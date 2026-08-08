"""
visualizer.py — Draw the target board, bullet holes, and per-hole labels on
the image for bullet-hole scoring.

Matches the actual pipeline output (detector.py / ring_scorer.py):
  detection_result keys: 'bullet_holes', 'board', 'black_contour', 'raw_results', ...
  scored result dicts:   {'id', 'bullet', 'score', 'ring', 'confidence'}

Two entry points:
  - annotate_detection(image, detection_result, scored, total): returns a BGR
    image with the board box, every hole labeled with its id/ring/score, and
    a total-score panel.
  - save_annotated(image, detection_result, scored, total, path): writes to disk.

Uses cv2 only — no extra dependencies.
"""

from __future__ import annotations

import os
from typing import Dict, Any, List, Optional, Tuple

import cv2
import numpy as np


# Ring number (0-10) -> display color (BGR), loosely matching the printed
# target's color bands (yellow bullseye -> red -> blue -> black -> white).
RING_COLOR_BGR = {
    10: (0, 215, 255),
    9:  (0, 215, 255),
    8:  (0, 0, 220),
    7:  (0, 0, 220),
    6:  (210, 130, 0),
    5:  (210, 130, 0),
    4:  (40, 40, 40),
    3:  (40, 40, 40),
    2:  (225, 225, 225),
    1:  (225, 225, 225),
    0:  (140, 140, 140),  # miss / outside board
}

LOW_CONFIDENCE_THRESHOLD = 0.5
"""Holes detected below this confidence get a distinct outline so a human
reviewer can spot-check them — useful for real-world deployments where a
borderline detection should not be scored without a second look."""


def _ring_color(ring: int) -> Tuple[int, int, int]:
    return RING_COLOR_BGR.get(int(round(ring)), (140, 140, 140))


def _draw_label(
    img: np.ndarray,
    text: str,
    x: int,
    y: int,
    bg_color: Tuple[int, int, int],
    fg_color: Tuple[int, int, int] = (0, 0, 0),
    pad: int = 4,
    font_scale: float = 0.5,
    thickness: int = 1,
) -> None:
    """Draw text with a strong white outline using PIL and Lucida font if available."""
    try:
        from PIL import Image, ImageDraw, ImageFont
        
        # Convert OpenCV image (BGR) to PIL Image (RGB)
        pil_img = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
        draw = ImageDraw.Draw(pil_img)
        
        # Determine font size from font_scale (approximate to match OpenCV scaling)
        font_size = int(14 * (font_scale / 0.5))
        
        try:
            # macOS Lucida Grande
            font = ImageFont.truetype("/System/Library/Fonts/LucidaGrande.ttc", font_size)
        except IOError:
            font = ImageFont.load_default()
            
        # Coordinates (OpenCV y is baseline, PIL y is top-left, so we adjust slightly)
        tx, ty = x + pad, y - int(font_size * 0.8)
        
        outline_color = (255, 255, 255)
        stroke_width = max(1, thickness + 1)
        
        # Convert fg_color from BGR to RGB
        fg_color_rgb = (fg_color[2], fg_color[1], fg_color[0])
        
        # Draw outline (stroke) by drawing text shifted in 4 directions
        for dx in [-stroke_width, 0, stroke_width]:
            for dy in [-stroke_width, 0, stroke_width]:
                if dx != 0 or dy != 0:
                    draw.text((tx + dx, ty + dy), text, font=font, fill=outline_color)
        
        # Draw main text
        draw.text((tx, ty), text, font=font, fill=fg_color_rgb)
        
        # Convert back to OpenCV BGR and copy into original array
        np.copyto(img, cv2.cvtColor(np.array(pil_img), cv2.COLOR_RGB2BGR))
        
    except Exception as e:
        # Fallback to OpenCV FONT_HERSHEY_DUPLEX
        outline_thickness = thickness + 2
        cv2.putText(img, text, (x + pad, y - 2), cv2.FONT_HERSHEY_DUPLEX, font_scale, (255, 255, 255), outline_thickness, cv2.LINE_AA)
        cv2.putText(img, text, (x + pad, y - 2), cv2.FONT_HERSHEY_DUPLEX, font_scale, fg_color, thickness, cv2.LINE_AA)


def draw_board(
    img: np.ndarray,
    board: Optional[Tuple[float, float, float, float]],
    color: Tuple[int, int, int] = (0, 200, 0),
    thickness: int = 2,
) -> None:
    """Draw a box around the detected target_board (cx, cy, w, h)."""
    # Disabled for a cleaner UI
    return


def draw_hole(
    img: np.ndarray,
    result: Dict[str, Any],
    radius: int = 6,
    base_scale: float = 1.0,
) -> None:
    """
    Draw one bullet hole: a modern orange dot with a white outline.
    """
    cx, cy = int(result["bullet"][0]), int(result["bullet"][1])
    hole_id = result.get("id", -1)
    confidence = result.get("confidence")

    r = max(3, int(radius * base_scale))

    # White outer border
    cv2.circle(img, (cx, cy), r + max(1, int(2 * base_scale)), (255, 255, 255), -1, cv2.LINE_AA)
    # Vibrant orange inner dot (BGR)
    cv2.circle(img, (cx, cy), r, (0, 140, 255), -1, cv2.LINE_AA)

    if confidence is not None and confidence < LOW_CONFIDENCE_THRESHOLD:
        cv2.circle(img, (cx, cy), r + max(2, int(5 * base_scale)), (0, 0, 255), max(1, int(2 * base_scale)), cv2.LINE_AA)

    score = result.get("score", 0.0)
    if score > 0:
        label = f"Shot {hole_id + 1} ({score:.2f})"
    else:
        label = f"Shot {hole_id + 1}"
        
    label_y = max(int(24 * base_scale), cy - r - max(4, int(8 * base_scale)))
    
    # White background with dark text and a bit more padding
    _draw_label(
        img, label, cx + r + max(2, int(4 * base_scale)), label_y,
        (250, 250, 250), (40, 40, 40),
        font_scale=0.85 * base_scale,
        thickness=max(1, int(1 * base_scale)),
        pad=max(2, int(4 * base_scale))
    )


def draw_calibration_debug(
    img: np.ndarray,
    calibration: Dict[str, Any],
    black_contour: Optional[Tuple[float, float, float, float]] = None,
    black_contour_polygon: Optional[np.ndarray] = None,
) -> None:
    """
    Draw the calibration reference circles so you can visually verify the
    math lines up with the actual printed rings on the target.

    Draws:
      - CYAN dashed circle  : the full scoring radius (outer edge of ring 1 / board edge)
      - CYAN crosshair      : calibrated center point
      - MAGENTA dashed circle: inner edge of ring 1 / outer edge of ring 0 (ratio 0.95)
      - GREEN dashed circle  : outer edge of ring 7 / inner edge of scoring area
                                (ratio 0.38, black-area boundary)
      - YELLOW dot           : center
      - Legend label         : calibration source + radius in pixels

    Args:
      calibration  : dict from board_calibrator.calibrate() —
                     needs 'cx', 'cy', 'radius'. May have 'homography'.
      black_contour: optional detected black_contour bbox (cx,cy,w,h) —
                     used as a fallback ORANGE comparison shape only when
                     no polygon is available (see black_contour_polygon).
      black_contour_polygon: optional Nx2 polygon points for black_contour,
                     as returned by detector.py when the model has a
                     segmentation head. When provided, ORANGE is drawn by
                     fitting a true ellipse to these points and warping it
                     the same way CYAN/GREEN/MAGENTA are — so on a tilted
                     photo ORANGE correctly appears as a tilted ellipse
                     instead of a perfect circle. Without this, ORANGE was
                     drawn from the raw axis-aligned bbox as a plain circle
                     with no tilt correction, which made it visually
                     disagree with the other (correctly tilt-corrected)
                     debug circles on any angled photo — a rendering bug,
                     not a scoring bug (scores never used this bbox shape).
    """
    from src.scoring.board_calibrator import BLACK_CONTOUR_OUTER_RATIO

    cx_cal = calibration["cx"]
    cy_cal = calibration["cy"]
    R = calibration["radius"]
    has_hom = calibration.get("homography") is not None

    h_img, w_img = img.shape[:2]

    # Calculate H_inv if homography is present
    H_inv = None
    if has_hom:
        try:
            H_inv = np.linalg.inv(calibration["homography"])
        except np.linalg.LinAlgError:
            H_inv = None

    def _draw_dashed_circle_warped(radius, color, gap=10, seg=8, thickness=2):
        if radius <= 0:
            return
        
        if H_inv is not None:
            step = gap + seg
            # Generate points for each dashed segment in dewarped space
            for start_deg in range(0, 360, step):
                pts_list = []
                for deg in range(start_deg, start_deg + seg + 1):
                    rad = np.deg2rad(deg)
                    # Point on circle in dewarped space
                    px = cx_cal + radius * np.cos(rad)
                    py = cy_cal + radius * np.sin(rad)
                    
                    # Map back to image space
                    pt = np.array([px, py, 1.0])
                    warped = H_inv @ pt
                    w = warped[2]
                    if w != 0:
                        pts_list.append([warped[0] / w, warped[1] / w])
                
                if len(pts_list) > 1:
                    pts_np = np.array(pts_list, dtype=np.int32).reshape((-1, 1, 2))
                    cv2.polylines(img, [pts_np], isClosed=False, color=color, thickness=thickness, lineType=cv2.LINE_AA)
        else:
            # Fallback to standard circle
            icx, icy, ir = int(round(cx_cal)), int(round(cy_cal)), int(round(radius))
            step = gap + seg
            for start_deg in range(0, 360, step):
                cv2.ellipse(
                    img, (icx, icy), (ir, ir), 0,
                    start_deg, start_deg + seg,
                    color, thickness, cv2.LINE_AA,
                )

    def _dashed_circle(center, radius, color, gap=12, seg=6, thickness=2):
        """Approximate dashed circle via short arcs (bbox-only fallback, no tilt)."""
        if radius <= 0:
            return
        step = gap + seg
        for start_deg in range(0, 360, step):
            cv2.ellipse(
                img, center, (radius, radius), 0,
                start_deg, start_deg + seg,
                color, thickness, cv2.LINE_AA,
            )

    def _dashed_ellipse_from_fit(polygon, color, gap=8, seg=8, thickness=2):
        """
        Fit a true ellipse to detected polygon points and draw it as a
        dashed ellipse in image space (no extra warping needed — the
        polygon points are already in real image coordinates, exactly as
        YOLO detected them, tilt included).
        """
        if polygon is None or len(polygon) < 5:
            return False
        try:
            (ecx, ecy), (minor, major), angle = cv2.fitEllipse(
                np.asarray(polygon, dtype=np.float32)
            )
        except cv2.error:
            return False
        center = (int(round(ecx)), int(round(ecy)))
        axes = (int(round(major / 2)), int(round(minor / 2)))
        step = gap + seg
        for start_deg in range(0, 360, step):
            cv2.ellipse(
                img, center, axes, angle,
                start_deg, start_deg + seg,
                color, thickness, cv2.LINE_AA,
            )
        cv2.circle(img, center, 4, color, -1, cv2.LINE_AA)
        return True

    # --- Full scoring radius (outer boundary of ring 1) ---
    _draw_dashed_circle_warped(R, (255, 220, 0), gap=10, seg=8, thickness=2)   # CYAN-ish

    # --- Black-area boundary (Ring 7 outer boundary) ---
    black_r = R * BLACK_CONTOUR_OUTER_RATIO
    _draw_dashed_circle_warped(black_r, (0, 220, 100), gap=8, seg=6, thickness=2)  # GREEN

    # --- Ring-1 inner edge (ratio 0.95) ---
    ring1_r = R * 0.95
    _draw_dashed_circle_warped(ring1_r, (200, 0, 200), gap=8, seg=5, thickness=1)  # MAGENTA

    # --- Crosshair at center ---
    arm = int(max(18, R // 10))
    if H_inv is not None:
        def map_pt(x, y):
            pt = np.array([x, y, 1.0])
            w_pt = H_inv @ pt
            w = w_pt[2]
            return (int(round(w_pt[0] / w)), int(round(w_pt[1] / w)))
        
        c_img = map_pt(cx_cal, cy_cal)
        left_img = map_pt(cx_cal - arm, cy_cal)
        right_img = map_pt(cx_cal + arm, cy_cal)
        up_img = map_pt(cx_cal, cy_cal - arm)
        down_img = map_pt(cx_cal, cy_cal + arm)
        
        cv2.line(img, left_img, right_img, (0, 255, 255), 1, cv2.LINE_AA)
        cv2.line(img, up_img, down_img, (0, 255, 255), 1, cv2.LINE_AA)
        cv2.circle(img, c_img, 4, (0, 255, 255), -1, cv2.LINE_AA)
    else:
        icx, icy = int(round(cx_cal)), int(round(cy_cal))
        cv2.line(img, (icx - arm, icy), (icx + arm, icy), (0, 255, 255), 1, cv2.LINE_AA)
        cv2.line(img, (icx, icy - arm), (icx, icy + arm), (0, 255, 255), 1, cv2.LINE_AA)
        cv2.circle(img, (icx, icy), 4, (0, 255, 255), -1, cv2.LINE_AA)

    # --- Detected black_contour shape (ORANGE) for comparison ---
    # Prefer fitting a true ellipse to the polygon (correctly shows tilt).
    # Only fall back to the non-tilt-aware bbox circle when no polygon is
    # available at all (e.g. a plain detection-only model with no -seg head).
    drew_ellipse = _dashed_ellipse_from_fit(
        black_contour_polygon, (0, 120, 255), gap=6, seg=8, thickness=2
    )
    if not drew_ellipse and black_contour is not None:
        bcx, bcy, bw, bh = black_contour
        bc_r = int(round(max(bw, bh) / 2))
        _dashed_circle((int(bcx), int(bcy)), bc_r, (0, 120, 255), gap=6, seg=8, thickness=2)
        cv2.circle(img, (int(bcx), int(bcy)), 4, (0, 120, 255), -1, cv2.LINE_AA)

    # --- Legend (bottom-right corner) ---
    src = calibration.get("source", "hom+ellipse" if has_hom else "bbox")
    lines = [
        f"CALIB DEBUG",
        f"center: ({int(round(cx_cal))}, {int(round(cy_cal))})",
        f"radius: {int(round(R))}px  src:{src}",
        f"-- CYAN   = full board radius (ring 1 edge)",
        f"-- GREEN  = est. ring 7 boundary ({BLACK_CONTOUR_OUTER_RATIO:.2f}R)",
        f"-- MAGENTA= ring 1 inner edge (0.95R)",
    ]
    if black_contour is not None or black_contour_polygon is not None:
        orange_desc = "fitted ellipse" if drew_ellipse else "bbox (no polygon, not tilt-corrected)"
        lines.append(f"-- ORANGE = detected black_contour ({orange_desc})")

    font, fscale, fthick = cv2.FONT_HERSHEY_SIMPLEX, 0.42, 1
    lh = 18
    panel_w = max(cv2.getTextSize(l, font, fscale, fthick)[0][0] for l in lines) + 14
    panel_h = len(lines) * lh + 10
    px = max(0, w_img - panel_w - 6)
    py = max(0, h_img - panel_h - 6)

    overlay = img.copy()
    cv2.rectangle(overlay, (px, py), (px + panel_w, py + panel_h), (0, 0, 0), -1)
    cv2.addWeighted(overlay, 0.65, img, 0.35, 0, img)
    cv2.rectangle(img, (px, py), (px + panel_w, py + panel_h), (80, 80, 80), 1)

    for i, line in enumerate(lines):
        color = (0, 255, 255) if i == 0 else (200, 200, 200)
        cv2.putText(img, line, (px + 6, py + (i + 1) * lh),
                    font, fscale, color, fthick, cv2.LINE_AA)


def draw_total(
    img: np.ndarray,
    total: float,
    scored: List[Dict[str, Any]],
) -> None:
    """Top-left total-score panel: count, total, and per-hole breakdown."""
    lines = [
        f"Holes: {len(scored)}",
        f"Total: {total:.2f}",
    ]
    if scored:
        breakdown = "  ".join(f"#{r['id']}:{r['score']:.2f}" for r in scored)
        if len(breakdown) > 60:
            breakdown = breakdown[:57] + "..."
        lines.append(breakdown)

    pad = 8
    line_h = 22
    panel_w = max(
        cv2.getTextSize(l, cv2.FONT_HERSHEY_SIMPLEX, 0.55, 1)[0][0] for l in lines
    ) + 2 * pad
    panel_h = line_h * len(lines) + 2 * pad

    overlay = img.copy()
    cv2.rectangle(overlay, (0, 0), (panel_w, panel_h), (0, 0, 0), -1)
    cv2.addWeighted(overlay, 0.6, img, 0.4, 0, img)
    cv2.rectangle(img, (0, 0), (panel_w, panel_h), (255, 255, 255), 1)

    for i, line in enumerate(lines):
        y = pad + line_h * (i + 1) - 4
        cv2.putText(
            img, line, (pad, y),
            cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA,
        )


def _draw_warped_circle(
    img: np.ndarray,
    cx: float,
    cy: float,
    radius: float,
    H_inv: Optional[np.ndarray],
    color: Tuple[int, int, int],
    thickness: int = 1,
) -> None:
    if radius <= 0:
        return
    if H_inv is not None:
        pts = []
        for deg in range(0, 361, 4):  # 90 points is enough for a smooth circle
            rad = np.deg2rad(deg)
            px = cx + radius * np.cos(rad)
            py = cy + radius * np.sin(rad)
            pt = np.array([px, py, 1.0])
            warped = H_inv @ pt
            w = warped[2]
            if w != 0:
                pts.append([warped[0] / w, warped[1] / w])
        if len(pts) > 1:
            pts_np = np.array(pts, dtype=np.int32).reshape((-1, 1, 2))
            cv2.polylines(img, [pts_np], isClosed=True, color=color, thickness=thickness, lineType=cv2.LINE_AA)
    else:
        icx, icy, ir = int(round(cx)), int(round(cy)), int(round(radius))
        cv2.circle(img, (icx, icy), ir, color, thickness, cv2.LINE_AA)


def draw_scoring_rings_and_crosshair(
    img: np.ndarray,
    calibration: Dict[str, Any],
) -> None:
    cx = calibration["cx"]
    cy = calibration["cy"]
    radius = calibration["radius"]
    ring_radii = calibration.get("ring_radii")  # actual detected ring boundaries, or None
    has_hom = calibration.get("homography") is not None

    H_inv = None
    if has_hom:
        try:
            H_inv = np.linalg.inv(calibration["homography"])
        except np.linalg.LinAlgError:
            H_inv = None

    # Draw concentric rings
    from src.scoring.ring_scorer import RINGS
    if ring_radii is not None and len(ring_radii) == len(RINGS):
        # Hough succeeded: draw at ACTUAL measured pixel boundaries (most accurate)
        for r_px, (_, _, _, ring_label) in zip(ring_radii, RINGS):
            color = _ring_color(ring_label)
            _draw_warped_circle(img, cx, cy, r_px, H_inv, color, thickness=2)
    else:
        # Fallback: compute from ISSF ratios × scoring radius
        for outer_ratio, _, _, ring_label in RINGS:
            color = _ring_color(ring_label)
            r_px = radius * outer_ratio
            _draw_warped_circle(img, cx, cy, r_px, H_inv, color, thickness=2)

    # Draw center crosshair
    arm = max(15, int(radius // 15))
    crosshair_color = (0, 0, 255)  # Red crosshair for visibility
    if H_inv is not None:
        def map_pt(x, y):
            pt = np.array([x, y, 1.0])
            w_pt = H_inv @ pt
            w = w_pt[2]
            if w == 0:
                return (int(round(x)), int(round(y)))
            return (int(round(w_pt[0] / w)), int(round(w_pt[1] / w)))
        
        c_img = map_pt(cx, cy)
        left_img = map_pt(cx - arm, cy)
        right_img = map_pt(cx + arm, cy)
        up_img = map_pt(cx, cy - arm)
        down_img = map_pt(cx, cy + arm)
        
        cv2.line(img, left_img, right_img, crosshair_color, 1, cv2.LINE_AA)
        cv2.line(img, up_img, down_img, crosshair_color, 1, cv2.LINE_AA)
        cv2.circle(img, c_img, 3, crosshair_color, -1, cv2.LINE_AA)
    else:
        icx, icy = int(round(cx)), int(round(cy))
        cv2.line(img, (icx - arm, icy), (icx + arm, icy), crosshair_color, 1, cv2.LINE_AA)
        cv2.line(img, (icx, icy - arm), (icx, icy + arm), crosshair_color, 1, cv2.LINE_AA)
        cv2.circle(img, (icx, icy), 3, crosshair_color, -1, cv2.LINE_AA)


def annotate_detection(
    image: np.ndarray,
    detection_result: Dict[str, Any],
    scored: Optional[List[Dict[str, Any]]] = None,
    total: Optional[float] = None,
    draw_board_box: bool = True,
    calibration: Optional[Dict[str, Any]] = None,
    debug_calib: bool = False,
) -> np.ndarray:
    """
    Render a fully annotated copy of the image.

    Args:
        image:            BGR numpy array (the original frame).
        detection_result: dict from BulletDetector.detect() — uses "board" key.
        scored:           list of per-hole result dicts from
                          ring_scorer.score_bullets_from_detection() /
                          score_all_bullets() — each has 'id','bullet','score','ring','confidence'.
                          If None, falls back to drawing raw "bullet_holes"
                          positions with no score/ring (id only).
        total:            optional total-score float for the top-left panel.
                          If None, computed from `scored`.
        draw_board_box:   if True, draws a box around the detected target_board.
        calibration:      optional calibration dict from board_calibrator.calibrate().
                          Required when debug_calib=True.
        debug_calib:      if True, draw the calibration debug overlay — shows
                          the scoring radius circle, center crosshair, and ring
                          boundary estimates so you can verify alignment visually.

    Returns:
        A new BGR numpy array (caller's input is not modified).
    """
    img = image.copy()
    board = detection_result.get("board")

    if draw_board_box:
        draw_board(img, board)

    # Draw color-coded scoring rings and center crosshairs if calibration is available
    # if calibration is not None:
    #     draw_scoring_rings_and_crosshair(img, calibration)

    # Calibration debug overlay — draw BEFORE holes so holes sit on top
    if debug_calib and calibration is not None:
        draw_calibration_debug(
            img,
            calibration,
            black_contour=detection_result.get("black_contour"),
            black_contour_polygon=detection_result.get("black_contour_polygon"),
        )

    if scored is None:
        # No scoring info available — still label each hole by index so
        # nothing is anonymous, even without a calibrated score.
        bullet_holes = detection_result.get("bullet_holes", [])
        scored = [
            {"id": i, "bullet": (bx, by), "score": 0.0, "ring": 0, "confidence": None}
            for i, (bx, by) in enumerate(bullet_holes)
        ]

    base_scale = max(0.5, img.shape[1] / 1200.0)
    for result in scored:
        draw_hole(img, result, base_scale=base_scale)

    total = total if total is not None else round(sum(r.get("score", 0.0) for r in scored), 2)
    # draw_total(img, total, scored)

    return img


def save_annotated(
    image: np.ndarray,
    detection_result: Dict[str, Any],
    path: str,
    scored: Optional[List[Dict[str, Any]]] = None,
    total: Optional[float] = None,
    draw_board_box: bool = True,
    calibration: Optional[Dict[str, Any]] = None,
    debug_calib: bool = False,
) -> str:
    """Annotate and save to disk. Returns the path written."""
    annotated = annotate_detection(
        image, detection_result, scored, total, draw_board_box,
        calibration=calibration, debug_calib=debug_calib,
    )
    os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)
    ok = cv2.imwrite(path, annotated)
    if not ok:
        raise IOError(f"cv2.imwrite failed for {path}")
    return path
