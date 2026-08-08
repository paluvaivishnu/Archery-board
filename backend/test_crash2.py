import cv2
from src.detection.detector import BulletDetector
from src.scoring.board_calibrator import calibrate, refine_with_hough
from src.scoring.ring_scorer import score_bullets_from_detection

detector = BulletDetector()
img = cv2.imread("../resized_test.jpg")

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
    print("refine_with_hough returned successfully")
else:
    print("calibrate returned None")

