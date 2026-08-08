import cv2
import numpy as np
import time
from src.scoring.board_calibrator import _detect_rings_hough

img = np.random.randint(0, 255, (800, 800, 3), dtype=np.uint8)
calib = {'cx': 400, 'cy': 400, 'radius': 300, 'source': 'test'}

t0 = time.time()
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
gray = clahe.apply(gray)
gray = cv2.GaussianBlur(gray, (5, 5), 0)
t1 = time.time()

circles = cv2.HoughCircles(
    gray,
    cv2.HOUGH_GRADIENT,
    dp=1.2,
    minDist=10,
    param1=50,
    param2=22,
    minRadius=20,
    maxRadius=500
)
t2 = time.time()

print(f"Preprocessing: {t1-t0:.4f}s")
print(f"HoughCircles: {t2-t1:.4f}s")
if circles is not None:
    print(f"Num circles found: {circles.shape[1]}")

