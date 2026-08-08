import cv2
import numpy as np
from src.scoring.board_calibrator import _detect_rings_hough, refine_with_hough

# Create a blank image
img = np.zeros((800, 800, 3), dtype=np.uint8)
cv2.circle(img, (400, 400), 300, (255, 255, 255), -1)
calib = {'cx': 400, 'cy': 400, 'radius': 300, 'source': 'test'}

try:
    res = refine_with_hough(calib, img)
    print("Success:", res)
except Exception as e:
    import traceback
    traceback.print_exc()

