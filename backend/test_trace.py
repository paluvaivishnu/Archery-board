import cv2
import numpy as np
import time
from src.scoring.board_calibrator import _detect_rings_hough, calibrate

img = np.random.randint(0, 255, (800, 800, 3), dtype=np.uint8)
calib = {'cx': 400, 'cy': 400, 'radius': 300, 'source': 'test'}

def trace_it(frame, event, arg):
    if event == 'call':
        return trace_it
    elif event == 'line':
        t = time.time()
        print(f"Line {frame.f_lineno}: {t - frame.f_locals.get('t_last', t):.4f}s")
        frame.f_locals['t_last'] = t
    return trace_it

# Just do a manual print wrapper around HoughCircles inside a modified function in this script
gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
gray = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8)).apply(gray)
blurred = cv2.GaussianBlur(gray, (7, 7), 0)

t0 = time.time()
circles = cv2.HoughCircles(
    gray,
    cv2.HOUGH_GRADIENT,
    dp=1.2,
    minDist=10,
    param1=50,
    param2=35,
    minRadius=15,
    maxRadius=450
)
t1 = time.time()
print(f"HoughCircles time: {t1 - t0:.4f}s")

