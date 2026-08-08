"""
detector.py — YOLOv11 inference wrapper for bullet-hole detection.

Uses a -seg (segmentation) model by default so polygons are available for
the board calibrator's ellipse fit and tilt correction.

Classes (must match models/configs/bullet_scoring.yaml):
    0: bullet_hole
    1: target_board
    2: black_contour   (outer boundary of the printed black area;
                        used by board_calibrator as the PRIMARY calibration
                        source — its outer edge sits on ring-7 boundary at
                        ratio 0.35 of the full scoring radius.)
"""

from typing import List, Dict, Any, Optional, Tuple

import numpy as np
from ultralytics import YOLO


CLASS_BULLET_HOLE   = 0
CLASS_TARGET_BOARD  = 1
CLASS_BLACK_CONTOUR = 2


class BulletDetector:
    def __init__(self, weights: str = "models/weights/best.pt", conf: float = 0.4):
        self.model = YOLO(weights)
        self.conf = conf

        # Resolve class mapping dynamically from model class names
        self.bullet_hole_classes = []
        self.target_board_class = None
        self.black_contour_class = None

        for idx, name in self.model.names.items():
            name_lower = name.lower().replace("_", "").replace("-", "").strip()
            is_bullet_hole = False
            if any(k in name_lower for k in ["bullethole", "bullet", "hole"]):
                is_bullet_hole = True
            elif name_lower.isdigit() and 0 <= int(name_lower) <= 10:
                is_bullet_hole = True

            if is_bullet_hole:
                self.bullet_hole_classes.append(idx)
            elif any(k in name_lower for k in ["target", "board"]):
                self.target_board_class = idx
            elif any(k in name_lower for k in ["black", "contour"]):
                self.black_contour_class = idx

        # Fallback to default indices if not resolved
        if not self.bullet_hole_classes:
            self.bullet_hole_classes = [0]
        if self.target_board_class is None:
            self.target_board_class = 1
        if self.black_contour_class is None:
            self.black_contour_class = 2

    def detect(self, image: np.ndarray) -> Dict[str, Any]:
        """
        Runs the model and returns boxes + per-class polygons (if model has a -seg head)
        + per-bullet-hole detector confidence.

        masks are only populated when the loaded weights are a -seg model;
        for a plain detection model, mask/polygon fields will be None and the
        calibrator falls back to bbox-only math.
        """
        results = self.model(image, conf=self.conf, verbose=False)[0]
        boxes = results.boxes
        masks = results.masks  # None if model has no segmentation head

        bullet_holes: List[Tuple[int, int]] = []
        bullet_hole_confidences: List[float] = []
        board: Optional[Tuple[float, float, float, float]] = None
        board_polygon: Optional[np.ndarray] = None
        board_confidence: Optional[float] = None
        black_contour: Optional[Tuple[float, float, float, float]] = None
        black_contour_polygon: Optional[np.ndarray] = None
        black_contour_confidence: Optional[float] = None

        for i, box in enumerate(boxes):
            cls = int(box.cls[0])
            conf = float(box.conf[0])
            x1, y1, x2, y2 = map(int, box.xyxy[0])
            cx, cy = (x1 + x2) // 2, (y1 + y2) // 2
            w, h = x2 - x1, y2 - y1

            polygon: Optional[np.ndarray] = None
            if masks is not None and i < len(masks.xy):
                polygon = masks.xy[i]  # Nx2 array of polygon (x, y) in pixel coords

            if cls in self.bullet_hole_classes:
                is_duplicate = False
                for j, (ex, ey) in enumerate(bullet_holes):
                    # If within ~10 pixels, treat as the same hole
                    if (ex - cx)**2 + (ey - cy)**2 < 100:
                        is_duplicate = True
                        # Keep the one with higher confidence
                        if conf > bullet_hole_confidences[j]:
                            bullet_holes[j] = (cx, cy)
                            bullet_hole_confidences[j] = conf
                        break
                if not is_duplicate:
                    bullet_holes.append((cx, cy))
                    bullet_hole_confidences.append(conf)
            elif cls == self.target_board_class and board is None:
                board = (cx, cy, w, h)
                board_polygon = polygon
                board_confidence = conf
            elif cls == self.black_contour_class and black_contour is None:
                black_contour = (cx, cy, w, h)
                black_contour_polygon = polygon
                black_contour_confidence = conf

        return {
            "bullet_holes": bullet_holes,
            "bullet_hole_confidences": bullet_hole_confidences,
            "board": board,
            "board_polygon": board_polygon,
            "board_confidence": board_confidence,
            "black_contour": black_contour,
            "black_contour_polygon": black_contour_polygon,
            "black_contour_confidence": black_contour_confidence,
            "raw_results": results,
        }

    def detect_with_scores(self, image: np.ndarray) -> Dict[str, Any]:
        """
        Convenience wrapper: detection + calibration (with tilt correction) + scoring.

        Calibration priority: black_contour polygon > black_contour bbox >
        target_board polygon > target_board bbox (see board_calibrator.py).
        """
        from src.scoring.board_calibrator import calibrate
        from src.scoring.ring_scorer import score_bullets_from_detection, total_score

        out = self.detect(image)
        calib = calibrate(
            out["board"], out["black_contour"],
            board_polygon=out["board_polygon"],
            black_contour_polygon=out["black_contour_polygon"],
            image=image,
        )
        scored = score_bullets_from_detection(
            out["bullet_holes"], calib,
            confidences=out["bullet_hole_confidences"],
        )
        out["scored"] = scored
        out["total"] = total_score(scored)
        out["calibration"] = calib
        return out
