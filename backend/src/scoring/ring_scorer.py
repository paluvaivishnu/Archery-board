"""
ring_scorer.py — Maps bullet hole (x, y) to a score using board calibration.
Score range: 0.00 - 10.99 (2 decimal places, continuous interpolation within each ring).

Scoring model: 11-zone target (rings 0-10).

If a homography is provided (the board was tilted and an ellipse was fit to its
inner boundary), every bullet hole is warped through that homography before
the ring math runs, so a tilted board scores identically to a straight-on one.

Each scored result includes a stable per-hole ID, the integer ring label
(0-10) the hole landed in, and (when available) the detector's confidence,
so every hole can be individually labeled and audited downstream.
"""

import math
from typing import List, Tuple, Optional, Dict, Any


# 10 ring bands (1..10), each (outer_ratio, score_at_inner_edge, score_at_outer_edge, ring_label).
# ratio = dist / board_radius. 0.0 = center, 1.0 = outermost edge of Ring 1.
RINGS = [
    (0.07395, 10.99, 10.00, 10),  # Ring 10 - bullseye (interpolates 10.99 down to 10.00)
    (0.17685, 10.00,  9.00,  9),
    (0.27974,  9.00,  8.00,  8),
    (0.38264,  8.00,  7.00,  7),  # outer boundary of black area (Ring 7)
    (0.48553,  7.00,  6.00,  6),
    (0.58842,  6.00,  5.00,  5),
    (0.69132,  5.00,  4.00,  4),
    (0.79421,  4.00,  3.00,  3),
    (0.89711,  3.00,  2.00,  2),
    (1.00000,  2.00,  1.00,  1),
]

DECIMAL_PRECISION = 2


def compute_score(
    bullet_x: float,
    bullet_y: float,
    board_cx: float,
    board_cy: float,
    board_radius: float,
) -> Tuple[float, int]:
    """
    Returns (decimal_score, ring_label) for a bullet hole at (bullet_x, bullet_y).

    decimal_score : 0.00-10.99, linear interpolation within each ring band.
    ring_label    : the integer ring (0-10) the hole landed in
                    (0 = outside the scoring rings but still touching the
                    board face / near-miss band; see compute_score's ratio>1
                    branch for a true off-board miss).

    board_cx, board_cy : center of target board in pixels
    board_radius        : outermost scoring-ring radius in pixels
    """
    dist  = math.hypot(bullet_x - board_cx, bullet_y - board_cy)
    ratio = dist / board_radius

    if ratio > 1.0:
        return 0.00, 0  # complete miss, off the board entirely

    prev_ratio = 0.0
    for outer_ratio, score_inner, score_outer, ring_label in RINGS:
        if ratio <= outer_ratio:
            band_width = outer_ratio - prev_ratio
            if band_width == 0:
                t = 0.0
            else:
                t = (ratio - prev_ratio) / band_width  # 0 = inner edge, 1 = outer edge
            raw = score_inner + t * (score_outer - score_inner)
            return round(raw, DECIMAL_PRECISION), ring_label
        prev_ratio = outer_ratio

    return 0.00, 0


def compute_score_with_ring_radii(
    bullet_x: float,
    bullet_y: float,
    board_cx: float,
    board_cy: float,
    ring_radii: List[float],
) -> Tuple[float, int]:
    """
    Like compute_score() but uses ACTUAL detected ring boundary pixel radii
    instead of ratio × scoring_radius.

    ring_radii: List of 10 floats in ASCENDING order — ring_radii[0] is the
    outer pixel radius of Ring 10 (bullseye), ring_radii[9] is the outer pixel
    radius of Ring 1 (outermost). This matches the order of RINGS[].

    Using real measured boundaries eliminates the compounding ratio error that
    occurs when the YOLO bounding box is even slightly off, and makes scoring
    accurate regardless of the target's print scale or camera zoom level.
    """
    dist = math.hypot(bullet_x - board_cx, bullet_y - board_cy)

    # Off the board entirely
    if dist > ring_radii[-1]:
        return 0.00, 0

    prev_r = 0.0
    for outer_r, (_, score_inner, score_outer, ring_label) in zip(ring_radii, RINGS):
        if dist <= outer_r:
            band_width = outer_r - prev_r
            t = (dist - prev_r) / band_width if band_width > 0 else 0.0
            raw = score_inner + t * (score_outer - score_inner)
            return round(raw, DECIMAL_PRECISION), ring_label
        prev_r = outer_r

    return 0.00, 0


def score_all_bullets(
    bullets: List[Tuple[float, float]],
    board_cx: float,
    board_cy: float,
    board_radius: float,
    confidences: Optional[List[float]] = None,
    ring_radii: Optional[List[float]] = None,
) -> List[dict]:
    """
    Geometric scorer: list of (x, y) bullet centers -> list of per-hole result dicts.

    Each result dict:
      {
        'id': int,                # stable 0-based index, assigned in input order
        'bullet': (x, y),         # corrected pixel coordinates used for scoring
        'score': float,           # 0.00-10.99
        'ring': int,               # integer ring label 0-10
        'confidence': float|None, # detector confidence for this hole, if provided
      }

    ring_radii: if provided (from refine_with_hough), actual detected ring boundary
    pixel radii are used for scoring instead of RINGS ratios × board_radius. This
    gives significantly more accurate scores when the YOLO bounding box estimate
    of board size is slightly off.
    """
    results = []
    for i, (bx, by) in enumerate(bullets):
        if ring_radii is not None and len(ring_radii) == len(RINGS):
            score, ring = compute_score_with_ring_radii(bx, by, board_cx, board_cy, ring_radii)
        else:
            score, ring = compute_score(bx, by, board_cx, board_cy, board_radius)
        conf = confidences[i] if confidences is not None and i < len(confidences) else None
        results.append({
            "id": i,
            "bullet": (bx, by),
            "score": score,
            "ring": ring,
            "confidence": conf,
        })
    return results


def total_score(results: List[dict]) -> float:
    """Sum of all bullet hole scores, rounded to 2 decimals."""
    return round(sum(r["score"] for r in results), DECIMAL_PRECISION)


def score_bullets_from_detection(
    bullets: List[Tuple[float, float]],
    calibration: Optional[Dict[str, Any]],
    confidences: Optional[List[float]] = None,
) -> List[dict]:
    """
    High-level scorer that handles tilt correction and per-hole labeling.

    calibration: dict returned by board_calibrator.calibrate(), or None.
      {
        'cx': float, 'cy': float, 'radius': float,
        'homography': 3x3 np.ndarray or None,
      }
    confidences: optional list of detector confidence scores, same order/length
                 as `bullets`. Pass detector.py's per-hole confidences here to
                 get them included in each result (useful for flagging
                 low-confidence hits for manual review in real-world use).

    If a homography is present (board was tilted and an ellipse was fit), every
    bullet hole is warped through it first, so ring math runs against an
    effectively straight-on board. If calibration is None (no board detected),
    every hole scores 0.00 with ring 0, but still gets an id/confidence so
    nothing is silently dropped.
    """
    if calibration is None:
        results = []
        for i, (bx, by) in enumerate(bullets):
            conf = confidences[i] if confidences is not None and i < len(confidences) else None
            results.append({"id": i, "bullet": (bx, by), "score": 0.00, "ring": 0, "confidence": conf})
        return results

    cx, cy, radius = calibration["cx"], calibration["cy"], calibration["radius"]
    homography = calibration.get("homography")
    ring_radii = calibration.get("ring_radii")  # None unless refine_with_hough() succeeded

    if homography is not None:
        # Lazy import to avoid a circular dependency at module load time.
        from src.scoring.board_calibrator import correct_point
        corrected = [correct_point(bx, by, homography) for (bx, by) in bullets]
    else:
        corrected = bullets

    return score_all_bullets(corrected, cx, cy, radius, confidences=confidences, ring_radii=ring_radii)
