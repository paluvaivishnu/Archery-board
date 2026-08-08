import cv2
import numpy as np
from src.api.app import detector
from src.scoring.board_calibrator import calibrate, refine_with_hough
from src.scoring.ring_scorer import score_bullets_from_detection

img = cv2.imread("../resized_test.jpg")
if img is None:
    print("Could not read image")
    exit(1)

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

