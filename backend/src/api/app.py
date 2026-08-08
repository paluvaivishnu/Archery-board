"""
app.py — FastAPI REST backend for the Archery Board scoring system.

Powered by YOLOv11 detection + board calibration + ring scoring from the
Automated Archery Scoring pipeline. This server receives target images from
the Bullseye AI frontend and returns accurate hole positions with 2-decimal
precision scores.

Endpoints:
    GET  /health         Server & model health check
    POST /api/score      Upload image → per-hole scores + annotated image (base64)

Run:
    cd backend
    python -m uvicorn src.api.app:app --reload --host 127.0.0.1 --port 8000
"""

import sys
import time
import uuid
import math
import base64
from pathlib import Path
from typing import Optional

# Make project root importable regardless of CWD
PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(PROJECT_ROOT))

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response

from src.detection.detector import BulletDetector
from src.scoring.board_calibrator import calibrate, refine_with_radial
from src.scoring.ring_scorer import score_bullets_from_detection, total_score
from src.utils.visualizer import annotate_detection


# --- Results directory ---
RESULTS_DIR = PROJECT_ROOT / "results" / "images"
RESULTS_DIR.mkdir(parents=True, exist_ok=True)

# --- Lazy-loaded detector singleton ---
_detector: Optional[BulletDetector] = None


def get_detector(
    weights: str = "models/weights/best.pt", conf: float = 0.4
) -> BulletDetector:
    global _detector
    if _detector is None:
        weights_path = Path(weights)
        if not weights_path.is_absolute():
            weights_path = PROJECT_ROOT / weights
        if not weights_path.exists():
            raise HTTPException(
                status_code=503,
                detail=f"Model weights not found at {weights_path}. "
                       f"Place best.pt in backend/models/weights/.",
            )
        _detector = BulletDetector(weights=str(weights_path), conf=conf)
    return _detector


# --- FastAPI application ---
app = FastAPI(
    title="Archery Board Scoring API",
    description=(
        "YOLOv11-powered hole detection and 2-decimal precision scoring "
        "for archery/shooting targets."
    ),
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Inline SVG favicon ---
_FAVICON_SVG = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
    '<rect width="64" height="64" rx="12" fill="#1d4ed8"/>'
    '<circle cx="32" cy="32" r="20" fill="#facc15"/>'
    '<circle cx="32" cy="32" r="12" fill="#ef4444"/>'
    '<circle cx="32" cy="32" r="6" fill="#000"/>'
    '</svg>'
)


@app.get("/favicon.ico", include_in_schema=False)
def favicon():
    return Response(content=_FAVICON_SVG, media_type="image/svg+xml")


@app.get("/health")
def health():
    """Check server health and model status."""
    import torch
    return {
        "status": "ok",
        "model": "YOLOv11 (best.pt)",
        "model_loaded": _detector is not None,
        "device": "cuda" if torch.cuda.is_available() else "cpu",
    }


@app.post("/api/score")
async def score_image(
    file: UploadFile = File(..., description="Target image (jpg/png)"),
    debug_calib: bool = Form(False, description="Overlay calibration debug circles"),
):
    """
    Upload a target image → get per-hole scores, annotated image, and statistics.

    Returns JSON matching the format expected by the Bullseye AI frontend:
    {
        "target_detected": bool,
        "target_center": [cx, cy],
        "target_radius": float,
        "arrows_count": int,
        "arrows": [...],
        "shots": [...],
        "stats": {...},
        "annotated_image": "data:image/jpeg;base64,...",
        "total_score": float,
        "processing_time_ms": float,
    }
    """
    # Validate content type
    allowed_types = ("image/jpeg", "image/png", "image/jpg", "image/webp")
    if file.content_type and file.content_type not in allowed_types:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported content type: {file.content_type}. "
                   f"Accepted: {', '.join(allowed_types)}",
        )

    # Decode image
    raw = await file.read()
    np_arr = np.frombuffer(raw, dtype=np.uint8)
    image = cv2.imdecode(np_arr, cv2.IMREAD_COLOR)
    if image is None:
        raise HTTPException(status_code=400, detail="Could not decode image")

    # Load detector
    try:
        detector = get_detector()
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Model load failed: {e}")

    # --- Run the scoring pipeline ---
    t0 = time.time()

    # 1. Detect bullet holes, target board, black contour
    out = detector.detect(image)

    # 2. Calibrate board center, radius, and perspective homography
    calib = calibrate(
        out["board"],
        out["black_contour"],
        board_polygon=out["board_polygon"],
        black_contour_polygon=out["black_contour_polygon"],
        image=image,
    )

    # 2b. Refine calibration: detect actual ring boundaries via Radial Profiling.
    # This checks against both ISSF and Evenly-Spaced target models so scores are
    # accurate even when the YOLO bounding box estimate is slightly off.
    if calib is not None:
        calib = refine_with_radial(calib, image)

    # 3. Score each bullet hole with 2-decimal precision
    scored = score_bullets_from_detection(
        out["bullet_holes"],
        calib,
        confidences=out["bullet_hole_confidences"],
    )
    total = total_score(scored)

    processing_time = (time.time() - t0) * 1000  # ms

    # 4. Generate annotated image
    annotated_img = annotate_detection(
        image, out,
        scored=scored,
        total=total,
        calibration=calib,
        debug_calib=debug_calib,
    )

    # Encode annotated image to base64
    _, buffer = cv2.imencode(".jpg", annotated_img, [cv2.IMWRITE_JPEG_QUALITY, 90])
    base64_str = base64.b64encode(buffer).decode("utf-8")
    annotated_image_base64 = f"data:image/jpeg;base64,{base64_str}"

    # --- Build response matching frontend expectations ---
    target_detected = calib is not None
    cx = float(calib["cx"]) if calib else 0.0
    cy = float(calib["cy"]) if calib else 0.0
    radius = float(calib["radius"]) if calib else 0.0
    base_source = calib.get("source", "unknown") if calib else "none"
    radial_count = calib.get("radial_count", 0) if calib else 0
    calib_source = f"{base_source}+radial({radial_count}rings)" if radial_count else base_source

    # Estimate mm_per_pixel (assume standard target outer radius ~80mm)
    mm_per_pixel = 80.0 / radius if radius > 0 else 0.2

    arrows = []
    shots = []
    for r in scored:
        bx = float(r["bullet"][0])
        by = float(r["bullet"][1])
        dist_px = float(math.hypot(bx - cx, by - cy))
        dist_mm = dist_px * mm_per_pixel

        arrows.append({
            "id": r["id"],
            "x": bx,
            "y": by,
            "dist": dist_px,
            "score": float(r["score"]),
            "ring": int(r.get("ring", 0)),
            "confidence": r.get("confidence"),
        })

        shots.append({
            "id": r["id"],
            "x": bx,
            "y": by,
            "score": float(r["score"]),
            "ring": int(r.get("ring", 0)),
            "distancePx": dist_px,
            "distanceReal": dist_mm,
            "type": "Detected Hole",
        })

    # Compute statistics
    avg_score = float(np.mean([r["score"] for r in scored])) if scored else 0.0
    dists_mm = [
        math.hypot(r["bullet"][0] - cx, r["bullet"][1] - cy) * mm_per_pixel
        for r in scored
    ]
    mean_radius_val = float(np.mean(dists_mm)) if dists_mm else 0.0

    extreme_spread = 0.0
    if len(scored) >= 2:
        max_spread = 0.0
        for i in range(len(scored)):
            for j in range(i + 1, len(scored)):
                d = math.hypot(
                    scored[i]["bullet"][0] - scored[j]["bullet"][0],
                    scored[i]["bullet"][1] - scored[j]["bullet"][1],
                )
                if d > max_spread:
                    max_spread = d
        extreme_spread = float(max_spread * mm_per_pixel)

    dxs_mm = [(r["bullet"][0] - cx) * mm_per_pixel for r in scored]
    windage = float(np.mean(dxs_mm)) if dxs_mm else 0.0

    dys_mm = [(cy - r["bullet"][1]) * mm_per_pixel for r in scored]
    elevation = float(np.mean(dys_mm)) if dys_mm else 0.0
    
    min_score = float(min([r["score"] for r in scored])) if scored else 0.0
    max_score = float(max([r["score"] for r in scored])) if scored else 0.0

    stats = {
        "avgScore": round(avg_score, 2),
        "extremeSpread": round(extreme_spread, 2),
        "meanRadius": round(mean_radius_val, 2),
        "windage": round(windage, 2),
        "elevation": round(elevation, 2),
        "minScore": round(min_score, 2),
        "maxScore": round(max_score, 2),
    }

    return {
        "target_detected": target_detected,
        "target_center": [cx, cy],
        "target_radius": radius,
        "calibration_source": calib_source,
        "arrows_count": len(scored),
        "arrows": arrows,
        "shots": shots,
        "stats": stats,
        "annotated_image": annotated_image_base64,
        "total_score": round(total, 2),
        "processing_time_ms": round(processing_time, 1),
    }
