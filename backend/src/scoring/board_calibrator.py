"""
board_calibrator.py — Determines board center (cx, cy) and scoring radius
for the ring scorer.

## Calibration priority (highest → lowest)

1. black_contour polygon  → fit ellipse → homography + (cx, cy, scoring_radius)
   (Used when a segmentation head is present in the model)

2. refined_black_contour_ellipse (OpenCV refined) → fit ellipse → homography + (cx, cy, scoring_radius)
   (Used when image is available and black_contour bbox is detected. Classic CV
   is used to find the exact contour boundary of the black target circle in the image,
   allowing pixel-perfect ellipse fitting and tilt/perspective correction even with
   a detection-only YOLO model)

3. black_contour bbox     → (cx, cy) from bbox center, scoring_radius from bbox
   using the 0.35 ratio (no tilt correction fallback)

4. target_board polygon   → fit ellipse → homography + (cx, cy, scoring_radius)
   scoring_radius = target_board_ellipse_major_axis / 2 * BOARD_TO_SCORING_RATIO

5. target_board bbox      → (cx, cy) from bbox center, scoring_radius from bbox
   with the BOARD_TO_SCORING_RATIO correction (no tilt correction fallback)

After any of the above, refine_with_hough() is called to detect actual printed
ring boundary circles in the image (or warped image) using cv2.HoughCircles.
When successful it adds 'ring_radii' to the calibration dict so that the scorer
can use real measured pixel boundaries instead of computed ratio × radius.
"""

import math
from typing import Optional, Tuple, Dict, Any, List

import numpy as np
import cv2


# --- Constants derived from ring geometry + ISSF target spec ---

# The outer edge of the printed black area falls on the ring-7 boundary.
# In the RINGS table (ring_scorer.py) ring-7's outer ratio is 0.38264.
BLACK_CONTOUR_OUTER_RATIO: float = 0.38264

# Ratio of the actual scoring-ring radius to the half-width of the full paper.
# ISSF 10 m Air Pistol: scoring radius 77.75 mm / card half-width 85.0 mm ≈ 0.9147.
BOARD_TO_SCORING_RATIO: float = 0.9147


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _fit_ellipse(
    polygon: Optional[np.ndarray],
) -> Optional[Tuple[Tuple[float, float], Tuple[float, float], float]]:
    """
    Fit an ellipse to a polygon array (Nx2 float32).
    Returns cv2.fitEllipse output: ((cx, cy), (minor, major), angle_deg), or None.
    Requires at least 5 points.
    """
    if polygon is None or len(polygon) < 5:
        return None
    pts = np.asarray(polygon, dtype=np.float32)
    try:
        return cv2.fitEllipse(pts)
    except cv2.error:
        return None


def _build_dewarp_homography(
    ellipse: Tuple,
    scoring_radius_override: Optional[float] = None,
) -> Optional[Tuple[np.ndarray, Tuple[float, float], float]]:
    """
    Build a 3×3 homography that un-squashes a tilted ellipse into a circle.

    cv2.fitEllipse returns (center, (minor_axis, major_axis), angle_deg) where
    angle_deg is the rotation of the MAJOR axis from vertical (+y axis).
    Bringing the major axis onto +x requires rotating by (angle_deg − 90°).

    Args:
        ellipse: cv2.fitEllipse result.
        scoring_radius_override: if given, use this as the scoring radius instead
            of major_axis/2 (used when the ellipse belongs to black_contour and we
            need to scale up to the full scoring radius).

    Returns:
        (homography 3×3, (cx, cy), scoring_radius) or None on failure.
    """
    (cx, cy), (minor_axis, major_axis), angle_deg = ellipse
    if minor_axis <= 0 or major_axis <= 0:
        return None

    ellipse_radius = major_axis / 2.0
    scoring_radius = scoring_radius_override if scoring_radius_override is not None else ellipse_radius
    scale_y = major_axis / minor_axis          # stretch the squashed (minor) axis
    rot_to_x = np.deg2rad(angle_deg - 90.0)   # rotation that aligns major axis → +x

    T1 = np.array([[1, 0, -cx], [0, 1, -cy], [0, 0, 1]], dtype=np.float64)
    cos_a, sin_a = np.cos(-rot_to_x), np.sin(-rot_to_x)
    R1 = np.array([[cos_a, -sin_a, 0], [sin_a, cos_a, 0], [0, 0, 1]])
    S  = np.array([[1, 0, 0], [0, scale_y, 0], [0, 0, 1]])
    cos_b, sin_b = np.cos(rot_to_x), np.sin(rot_to_x)
    R2 = np.array([[cos_b, -sin_b, 0], [sin_b, cos_b, 0], [0, 0, 1]])
    T2 = np.array([[1, 0, cx], [0, 1, cy], [0, 0, 1]])

    homography = T2 @ R2 @ S @ R1 @ T1
    return homography, (cx, cy), scoring_radius


def _order_corners(pts: np.ndarray) -> np.ndarray:
    """Order 4 unordered points as (top-left, top-right, bottom-right, bottom-left)."""
    s = pts.sum(axis=1)
    diff = np.diff(pts, axis=1).flatten()
    tl = pts[np.argmin(s)]
    br = pts[np.argmax(s)]
    tr = pts[np.argmin(diff)]
    bl = pts[np.argmax(diff)]
    return np.array([tl, tr, br, bl], dtype=np.float32)


def _extract_quad_corners(polygon: Optional[np.ndarray]) -> Optional[np.ndarray]:
    """
    Reduce a (possibly noisy) target_board polygon down to its 4 paper corners.

    IMPORTANT: this must NOT use cv2.minAreaRect. A perspective-tilted square
    photographs as a general (non-rectangular) quadrilateral -- that skew IS
    the tilt information we need. minAreaRect forces the 4 points onto an
    axis-independent but still perfectly rectangular box, silently discarding
    the exact perspective skew and defeating the whole point of correcting
    for it. Instead we simplify the polygon's convex hull down to 4 vertices
    with approxPolyDP, which preserves the true (skewed) corner positions.

    This is far more numerically stable for perspective correction than the
    ellipse-unsquish approach above, because it's built from points spread
    across the FULL extent of the board rather than points clustered on the
    small black center circle -- so the resulting transform stays accurate
    all the way out to rings 1-4, not just near the middle.
    """
    if polygon is None or len(polygon) < 4:
        return None
    pts = np.asarray(polygon, dtype=np.float32).reshape(-1, 1, 2)
    hull = cv2.convexHull(pts)
    if len(hull) < 4:
        return None
    hull_area = cv2.contourArea(hull)
    if hull_area <= 0:
        return None
    peri = cv2.arcLength(hull, True)
    if peri <= 0:
        return None

    # Deliberately narrow epsilon range: a genuine (slightly noisy) rectangle
    # collapses to 4 points at a small epsilon. A near-circular polygon (e.g.
    # black_contour, or a badly-segmented board) can ALSO be forced down to 4
    # points if epsilon is pushed high enough -- which would silently produce
    # a garbage "rectangle" for a shape that was never rectangular. We cap
    # epsilon low and additionally require the 4-point approximation to
    # preserve most of the original hull's area, which a real rectangle does
    # but a forced circle-to-quad collapse does not (a quad inscribed in a
    # circle loses roughly ~36% of the circle's area).
    for eps_frac in (0.01, 0.02, 0.03, 0.04, 0.05, 0.06):
        approx = cv2.approxPolyDP(hull, eps_frac * peri, True)
        if len(approx) == 4:
            approx_area = cv2.contourArea(approx)
            if approx_area > 0 and abs(approx_area - hull_area) / hull_area < 0.12:
                return _order_corners(approx.reshape(4, 2).astype(np.float32))
            return None  # 4 points found but shape doesn't look rectangular -- reject
    # Could not resolve the board outline to exactly 4 corners (occlusion,
    # rounded/torn paper corner, near-circular shape, etc.) -- signal failure
    # so calibrate() falls through to the ellipse-based paths below.
    return None


def _build_perspective_homography_from_quad(
    corners: np.ndarray,
) -> Optional[np.ndarray]:
    """
    Build a TRUE projective homography (full 8 DOF, unlike the similarity
    transform in _build_dewarp_homography) that maps the tilted board
    rectangle onto an ideal front-on square, using the 4 detected corners.

    Because ISSF-style targets are square/rectangular paper, 4 corner
    correspondences fully determine the perspective transform -- this is
    geometrically exact, not an approximation.
    """
    if corners is None or len(corners) != 4:
        return None

    side_lengths = [float(np.linalg.norm(corners[i] - corners[(i + 1) % 4])) for i in range(4)]
    side = float(np.mean(side_lengths))
    if side <= 0:
        return None
    half = side / 2.0
    cx = float(np.mean(corners[:, 0]))
    cy = float(np.mean(corners[:, 1]))

    dst = np.array([
        [cx - half, cy - half],
        [cx + half, cy - half],
        [cx + half, cy + half],
        [cx - half, cy + half],
    ], dtype=np.float32)

    H, _ = cv2.findHomography(corners, dst)
    return H


def _warp_points(points: np.ndarray, H: np.ndarray) -> np.ndarray:
    pts = np.asarray(points, dtype=np.float64).reshape(-1, 1, 2)
    warped = cv2.perspectiveTransform(pts, H).reshape(-1, 2)
    return warped


def _sample_ellipse_points(ellipse: Tuple, n: int = 24) -> np.ndarray:
    """Sample n points around a cv2.fitEllipse-style ellipse, in image coords."""
    (cx, cy), (minor, major), angle_deg = ellipse
    theta = np.radians(angle_deg)
    pts = []
    for t_deg in range(0, 360, max(1, 360 // n)):
        t = np.radians(t_deg)
        ex, ey = (major / 2) * np.cos(t), (minor / 2) * np.sin(t)
        ix = cx + ex * np.cos(theta) - ey * np.sin(theta)
        iy = cy + ex * np.sin(theta) + ey * np.cos(theta)
        pts.append([ix, iy])
    return np.array(pts, dtype=np.float64)


def _find_black_contour_points(
    image: np.ndarray,
    black_contour_box: Tuple[float, float, float, float],
) -> Optional[np.ndarray]:
    """
    Crop the region around the YOLO bounding box of the black target circle
    and segment its boundary via Otsu's thresholding.

    Returns the raw contour points (Nx2, in ORIGINAL image coordinates), or
    None. Factored out of refine_black_contour_via_opencv so callers that
    need the actual detected pixels (e.g. to warp through a perspective
    homography) aren't stuck re-sampling points off an already-fitted
    ellipse, which would compound approximation error unnecessarily.
    """
    h_img, w_img = image.shape[:2]
    cx, cy, w, h = black_contour_box
    if w <= 0 or h <= 0:
        return None

    # Crop a padded SQUARE region around the bounding box, sized from the
    # LARGER of w/h, not each dimension independently.
    #
    # Why: the black target area is round, so its true bbox should be
    # roughly square. If YOLO's detection itself has a badly wrong aspect
    # ratio (observed in practice: e.g. a 212x82 box for what should be a
    # circle), cropping with each dimension's own padding locks in that
    # error — the short dimension's crop can clip the real circle's edge
    # before Otsu thresholding ever runs, so no amount of refinement can
    # recover the missing part of the circle. Using a square crop sized
    # from max(w, h) guarantees the full circle is included in the crop
    # region regardless of how distorted YOLO's original box was.
    pad_factor = 0.25
    half_size = max(w, h) * (0.5 + pad_factor)
    x1 = max(0, int(cx - half_size))
    y1 = max(0, int(cy - half_size))
    x2 = min(w_img, int(cx + half_size))
    y2 = min(h_img, int(cy + half_size))

    if (x2 - x1) < 10 or (y2 - y1) < 10:
        return None

    roi = image[y1:y2, x1:x2]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)

    # Threshold: dark circle on light background (binary inverse threshold + Otsu)
    _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)

    # Find external contours to ignore bullet holes inside the black region
    contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    roi_cx = (x2 - x1) / 2.0
    roi_cy = (y2 - y1) / 2.0
    best_contour = None
    min_dist_to_center = float('inf')

    # Find the contour closest to the center of the cropped ROI
    for c in contours:
        if len(c) < 5:
            continue
        area = cv2.contourArea(c)
        roi_area = roi.shape[0] * roi.shape[1]
        # Ignore extremely small noise contours or background contours
        if area < 0.05 * roi_area or area > 0.95 * roi_area:
            continue

        M = cv2.moments(c)
        if M["m00"] == 0:
            continue
        ccx = M["m10"] / M["m00"]
        ccy = M["m01"] / M["m00"]

        dist = math.hypot(ccx - roi_cx, ccy - roi_cy)
        if dist < min_dist_to_center:
            min_dist_to_center = dist
            best_contour = c

    # Fallback to the largest contour of sufficient size if none was close to center
    if best_contour is None:
        valid_contours = [c for c in contours if len(c) >= 5]
        if not valid_contours:
            return None
        best_contour = max(valid_contours, key=cv2.contourArea)
        if cv2.contourArea(best_contour) < 0.05 * (roi.shape[0] * roi.shape[1]):
            return None

    return best_contour.reshape(-1, 2).astype(np.float64) + np.array([x1, y1], dtype=np.float64)


def refine_black_contour_via_opencv(
    image: np.ndarray,
    black_contour_box: Tuple[float, float, float, float],
) -> Optional[Tuple[Tuple[float, float], Tuple[float, float], float]]:
    """
    Classic CV refinement: Crop the region around the YOLO bounding box of the
    black target circle, segment the dark circle boundary using Otsu's thresholding,
    and fit a high-precision ellipse. This provides exact sub-pixel center detection
    and perspective tilt correction (homography) even without segmentation models.

    Args:
        image: Original BGR input image.
        black_contour_box: (cx, cy, w, h) bounding box from YOLO.

    Returns:
        cv2.fitEllipse output: ((cx, cy), (minor_axis, major_axis), angle_deg), or None.
    """
    pts = _find_black_contour_points(image, black_contour_box)
    if pts is None or len(pts) < 5:
        return None
    try:
        return cv2.fitEllipse(pts.astype(np.float32))
    except cv2.error:
        return None


def refine_board_quad_via_opencv(
    image: np.ndarray,
    board_box: Tuple[float, float, float, float],
) -> Optional[np.ndarray]:
    """
    Classic CV corner detection for the target_board's paper edge, working
    directly from the raw image + YOLO bounding box -- NO segmentation model
    required.

    This exists because most deployed YOLO weights are plain detection
    models (bbox only, no -seg head), which means `board_polygon` /
    `black_contour_polygon` are always None. Without this function, the
    true-perspective board-corner homography could never fire in practice,
    and calibration would silently fall back to the less accurate
    ellipse-unsquish path on every single angled photo -- exactly the
    real-world failure mode this refinement targets.

    Segments the paper (bright) against the background (typically a darker
    desk/table) via Otsu thresholding, finds the largest bounding contour,
    and reduces it to its 4 true corners (preserving perspective skew --
    see _extract_quad_corners for why this must NOT use minAreaRect).

    Args:
        image: Original BGR input image.
        board_box: (cx, cy, w, h) bounding box from YOLO for target_board.

    Returns:
        4x2 float32 array of corners in ORIGINAL image coordinates
        (ordered tl, tr, br, bl), or None if a clean quad could not be found.
    """
    h_img, w_img = image.shape[:2]
    cx, cy, w, h = board_box
    if w <= 0 or h <= 0:
        return None

    # Generous padding: the YOLO board bbox is axis-aligned, but a tilted
    # paper's true corners can stick out beyond an axis-aligned box fit to
    # its (also tilted) silhouette. Pad well past the box so no corner gets
    # clipped before thresholding ever runs.
    pad_factor = 0.30
    half_w = w * (0.5 + pad_factor)
    half_h = h * (0.5 + pad_factor)
    x1 = max(0, int(cx - half_w))
    y1 = max(0, int(cy - half_h))
    x2 = min(w_img, int(cx + half_w))
    y2 = min(h_img, int(cy + half_h))

    if (x2 - x1) < 20 or (y2 - y1) < 20:
        return None

    roi = image[y1:y2, x1:x2]
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)

    # Paper is bright against a (usually) darker background -- plain Otsu,
    # not inverted.
    _, thresh = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)

    # Close small gaps (e.g. dark printed rings/text near the paper edge
    # briefly breaking the outer contour) before contour extraction.
    kernel = np.ones((5, 5), np.uint8)
    closed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel, iterations=2)

    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return None

    roi_area = roi.shape[0] * roi.shape[1]
    candidates = [c for c in contours if 0.15 * roi_area <= cv2.contourArea(c) <= 0.98 * roi_area]
    if not candidates:
        return None
    best_contour = max(candidates, key=cv2.contourArea)

    quad = _extract_quad_corners(best_contour.reshape(-1, 2))
    if quad is None:
        return None

    # Shift back to original image coordinates.
    quad = quad + np.array([x1, y1], dtype=np.float32)
    return quad


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def calibrate(
    board: Optional[Tuple[float, float, float, float]] = None,
    black_contour: Optional[Tuple[float, float, float, float]] = None,
    board_polygon: Optional[np.ndarray] = None,
    black_contour_polygon: Optional[np.ndarray] = None,
    image: Optional[np.ndarray] = None,
) -> Optional[Dict[str, Any]]:
    """
    Returns a calibration dict:
        {
            'cx': float, 'cy': float, 'radius': float,
            'homography': 3×3 np.ndarray or None,
            'source': str,   # which path was used (for debug/logging)
        }
    or None if neither target_board nor black_contour was detected.

    Calibration priority (see module docstring for full rationale):
        1. black_contour polygon  (tilt-corrected, most accurate)
        2. refined_black_contour  (classic CV ellipse fitting on original image)
        3. black_contour bbox     (no tilt correction fallback)
        4. target_board polygon   (tilt-corrected, margin-corrected radius)
        5. target_board bbox      (last resort, margin-corrected radius)
    """

    # ------------------------------------------------------------------ #
    # Priority 0 (NEW, highest) — true perspective correction from the
    # target_board's rectangular paper corners, refined with the
    # black_contour ellipse (warped into the corrected frame) for a precise
    # scoring radius.
    #
    # Why this ranks above the ellipse-unsquish paths below: cv2.fitEllipse
    # on the small black center circle only recovers a SIMILARITY transform
    # (rotate + non-uniform scale) around that one small region -- a good
    # *local* approximation near the center, but a genuinely tilted photo is
    # a PROJECTIVE transform. The further a bullet hole is from the black
    # circle (rings 1-4, near the board edge), the more that local
    # approximation drifts from reality. The board's rectangular corners
    # span the FULL frame, so a homography fit to them stays accurate
    # everywhere on the board, not just near the middle.
    # ------------------------------------------------------------------ #
    quad = _extract_quad_corners(board_polygon)
    if quad is None and board is not None and image is not None:
        # No -seg model / no mask polygon available -- fall back to classic
        # CV corner detection directly on the raw image. This is the path
        # that actually fires for plain detection-only YOLO weights (the
        # common case), which is why it must exist: without it, Priority 0
        # only ever triggers for -seg models and silently never helps
        # real-world bbox-only deployments.
        quad = refine_board_quad_via_opencv(image, board)
    if quad is not None:
        H_persp = _build_perspective_homography_from_quad(quad)
        if H_persp is not None:
            radius_ellipse = None

            if black_contour_polygon is not None and len(black_contour_polygon) >= 5:
                warped_bc = _warp_points(black_contour_polygon, H_persp)
                radius_ellipse = _fit_ellipse(warped_bc)
            elif black_contour is not None and image is not None:
                raw_pts = _find_black_contour_points(image, black_contour)
                if raw_pts is not None and len(raw_pts) >= 5:
                    warped_bc = _warp_points(raw_pts, H_persp)
                    radius_ellipse = _fit_ellipse(warped_bc)

            if radius_ellipse is not None:
                (wcx, wcy), (wminor, wmajor), _ = radius_ellipse
                bc_radius = wmajor / 2.0
                scoring_radius = bc_radius / BLACK_CONTOUR_OUTER_RATIO
                return {
                    "cx": wcx, "cy": wcy, "radius": scoring_radius,
                    "homography": H_persp, "source": "board_quad_perspective",
                }

    # ------------------------------------------------------------------ #
    # Priority 1 — black_contour polygon (tilt-corrected, if model has masks)
    # ------------------------------------------------------------------ #
    ellipse = _fit_ellipse(black_contour_polygon)
    if ellipse is not None:
        (cx, cy), (minor_axis, major_axis), _ = ellipse
        bc_radius = major_axis / 2.0
        scoring_radius = bc_radius / BLACK_CONTOUR_OUTER_RATIO
        built = _build_dewarp_homography(ellipse, scoring_radius_override=scoring_radius)
        if built is not None:
            homography, (cx, cy), _ = built
            return {
                "cx": cx, "cy": cy, "radius": scoring_radius,
                "homography": homography, "source": "black_contour_polygon",
            }

    # ------------------------------------------------------------------ #
    # Priority 2 — refined_black_contour (Classic CV ellipse fitting)
    # ------------------------------------------------------------------ #
    if black_contour is not None and image is not None:
        refined_ellipse = refine_black_contour_via_opencv(image, black_contour)
        if refined_ellipse is not None:
            (cx, cy), (minor_axis, major_axis), _ = refined_ellipse
            bc_radius = major_axis / 2.0
            scoring_radius = bc_radius / BLACK_CONTOUR_OUTER_RATIO
            built = _build_dewarp_homography(refined_ellipse, scoring_radius_override=scoring_radius)
            if built is not None:
                homography, (cx, cy), _ = built
                return {
                    "cx": cx, "cy": cy, "radius": scoring_radius,
                    "homography": homography, "source": "refined_black_contour_ellipse",
                }

    # ------------------------------------------------------------------ #
    # Priority 3 — black_contour bbox (no tilt correction fallback)
    # ------------------------------------------------------------------ #
    if black_contour is not None:
        bcx, bcy, bw, bh = black_contour
        if bw > 0 and bh > 0:
            bc_radius = max(bw, bh) / 2.0
            scoring_radius = bc_radius / BLACK_CONTOUR_OUTER_RATIO
            return {
                "cx": float(bcx), "cy": float(bcy), "radius": float(scoring_radius),
                "homography": None, "source": "black_contour_bbox",
            }

    # ------------------------------------------------------------------ #
    # Priority 4 — target_board polygon (tilt-corrected, margin-corrected)
    # ------------------------------------------------------------------ #
    ellipse = _fit_ellipse(board_polygon)
    if ellipse is not None:
        (cx, cy), (minor_axis, major_axis), _ = ellipse
        board_radius = major_axis / 2.0
        scoring_radius = board_radius * BOARD_TO_SCORING_RATIO
        built = _build_dewarp_homography(ellipse, scoring_radius_override=scoring_radius)
        if built is not None:
            homography, (cx, cy), _ = built
            return {
                "cx": cx, "cy": cy, "radius": scoring_radius,
                "homography": homography, "source": "target_board_polygon",
            }

    # ------------------------------------------------------------------ #
    # Priority 5 — target_board bbox (last resort, margin-corrected)
    # ------------------------------------------------------------------ #
    if board is not None:
        cx, cy, w, h = board
        if w > 0 and h > 0:
            board_radius = max(w, h) / 2.0
            scoring_radius = board_radius * BOARD_TO_SCORING_RATIO
            return {
                "cx": float(cx), "cy": float(cy), "radius": float(scoring_radius),
                "homography": None, "source": "target_board_bbox",
            }

    return None


def _detect_rings_radial(
    image: np.ndarray,
    calibration: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    """
    Detect printed ring-boundary circles using Radial Intensity Profiling.
    
    This shoots virtual rays from the center, averages the pixels into a 1D
    intensity profile, and finds the dark spikes (which correspond to the printed
    rings). It then matches these spikes against multiple target models (e.g.,
    ISSF vs perfectly evenly-spaced synthetic targets) to find the exact
    scoring radius and ring boundaries.
    """
    from src.scoring.ring_scorer import RINGS as _RINGS

    # Model A: ISSF Standard Target
    ring_ratios_issf = [row[0] for row in _RINGS]
    # Model B: Perfectly Evenly Spaced Target (often found in synthetic images)
    ring_ratios_even = [i / 10.0 for i in range(1, 11)]

    h_img, w_img = image.shape[:2]

    # --- Step 1: Perspective-correct the working image ---
    H = calibration.get("homography")
    work = image
    if H is not None:
        work = cv2.warpPerspective(image, H, (w_img, h_img))

    cx_hint = float(calibration["cx"])
    cy_hint = float(calibration["cy"])
    r_hint  = float(calibration["radius"])

    if r_hint <= 0:
        return None

    # --- Step 2: Extract 1D Radial Profile ---
    gray = cv2.cvtColor(work, cv2.COLOR_BGR2GRAY)
    
    y, x = np.ogrid[:h_img, :w_img]
    dist = np.hypot(x - cx_hint, y - cy_hint)
    
    max_r = min(int(r_hint * 1.5), min(w_img, h_img))
    dist_int = dist.astype(int)
    mask = dist_int < max_r
    
    # Average pixel intensity by distance from center
    intensity_sum = np.bincount(dist_int[mask], weights=gray[mask], minlength=max_r)
    pixel_count = np.bincount(dist_int[mask], minlength=max_r)
    
    valid = pixel_count > 0
    profile = np.zeros(max_r, dtype=np.float32)
    profile[valid] = intensity_sum[valid] / pixel_count[valid]
    
    # Smooth profile
    kernel_size = 5
    kernel = np.ones(kernel_size) / kernel_size
    smoothed = np.convolve(profile, kernel, mode='same')
    
    # The printed rings might be black-on-white or white-on-black.
    # The absolute gradient captures the sharp edges of either.
    gradient = np.abs(np.diff(smoothed))
    
    # --- Step 3: Find Peaks in Gradient (The Rings) ---
    raw_peaks = []
    peak_threshold = 2.0
    
    for d in range(1, len(gradient) - 1):
        val = gradient[d]
        if val > peak_threshold and val > gradient[d - 1] and val >= gradient[d + 1]:
            raw_peaks.append(d)
            
    # Group adjacent edges (falling and rising edges of a thick line)
    # and take their average to find the true mathematical center.
    peaks = []
    min_spacing = max(8, int(r_hint * 0.03))
    
    current_group = []
    for p in raw_peaks:
        if not current_group:
            current_group.append(p)
        elif p - current_group[-1] <= min_spacing:
            current_group.append(p)
        else:
            peaks.append(sum(current_group) / len(current_group))
            current_group = [p]
            
    if current_group:
        peaks.append(sum(current_group) / len(current_group))
                
    if len(peaks) < 3:
        return None

    # --- Step 4: Robust Model Matching (RANSAC-style) ---
    models = [ring_ratios_issf, ring_ratios_even]
    best_inliers = 0
    best_scoring_r = None
    best_model = None
    best_error = float('inf')
    tol_ratio = 0.02  # 2% tolerance
    
    for model_ratios in models:
        for peak in peaks:
            for rr in model_ratios:
                candidate_r = peak / rr
                if candidate_r < r_hint * 0.50 or candidate_r > r_hint * 1.50:
                    continue
                
                # Count inliers and sum their absolute errors
                inliers = 0
                error_sum = 0.0
                for p in peaks:
                    # Find closest theoretical ring for this peak
                    best_match_err = min(abs(p / candidate_r - rr2) for rr2 in model_ratios)
                    if best_match_err < tol_ratio:
                        inliers += 1
                        error_sum += best_match_err
                
                if inliers > best_inliers or (inliers == best_inliers and error_sum < best_error):
                    best_inliers = inliers
                    best_scoring_r = candidate_r
                    best_model = model_ratios
                    best_error = error_sum

    if best_inliers < 3 or best_scoring_r is None:
        return None

    # --- Step 5: Refine ---
    inlier_estimates: List[float] = []
    for peak in peaks:
        best_rr = min(best_model, key=lambda rr: abs(peak / best_scoring_r - rr))
        if abs(peak / best_scoring_r - best_rr) < tol_ratio:
            inlier_estimates.append(peak / best_rr)

    if not inlier_estimates:
        return None

    refined_r = float(np.median(inlier_estimates))
    ring_radii = [refined_r * rr for rr in best_model]

    return {
        "cx": cx_hint,
        "cy": cy_hint,
        "scoring_radius": refined_r,
        "ring_radii": ring_radii,
        "radial_count": best_inliers,
    }


def refine_with_radial(
    calibration: Dict[str, Any],
    image: np.ndarray,
) -> Dict[str, Any]:
    """
    Attempt to refine calibration by detecting actual printed ring boundaries
    using radial intensity profiling.

    On success, adds 'ring_radii' (List[float], 10 values sorted ascending)
    and 'radial_count' to the calibration dict. Also updates 'radius'.
    """
    if calibration is None or image is None:
        return calibration
    try:
        result = _detect_rings_radial(image, calibration)
        if result is not None:
            calibration["ring_radii"]  = result["ring_radii"]
            calibration["radial_count"] = result["radial_count"]
            calibration["radius"] = result["scoring_radius"]
    except Exception:
        # Never let radial failure break the existing pipeline
        pass
    return calibration


def correct_point(x: float, y: float, homography: np.ndarray) -> Tuple[float, float]:
    """Maps a single (x, y) pixel coordinate through the dewarp homography."""
    pt = np.array([x, y, 1.0])
    warped = homography @ pt
    w = warped[2]
    return warped[0] / w, warped[1] / w
