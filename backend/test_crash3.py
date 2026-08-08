import cv2
import traceback
from src.detection.detector import BulletDetector
from src.scoring.board_calibrator import calibrate, refine_with_hough
from src.scoring.ring_scorer import score_bullets_from_detection, total_score
from src.utils.visualizer import annotate_detection

detector = BulletDetector()
img = cv2.imread("../resized_test.jpg")

try:
    out = detector.detect(img)
    calib = calibrate(
        out["board"],
        out["black_contour"],
        board_polygon=out["board_polygon"],
        black_contour_polygon=out["black_contour_polygon"],
        image=img,
    )
    if calib is not None:
        calib = refine_with_hough(calib, img)
    
    scored = score_bullets_from_detection(
        out["bullet_holes"],
        calib,
        confidences=out["bullet_hole_confidences"],
    )
    total = total_score(scored)
    
    annotated = annotate_detection(
        img, out,
        scored=scored,
        total=total,
        calibration=calib,
        debug_calib=False,
    )
    print("Pipeline completed successfully")
except Exception as e:
    traceback.print_exc()

