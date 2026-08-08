import cv2
import numpy as np
import time
from src.scoring.board_calibrator import _detect_rings_hough

# Create a noisy image
img = np.random.randint(0, 255, (800, 800, 3), dtype=np.uint8)
calib = {'cx': 400, 'cy': 400, 'radius': 300, 'source': 'test'}

t0 = time.time()
try:
    res = _detect_rings_hough(img, calib)
    print(f"Time taken: {time.time() - t0:.2f}s, Result: {res}")
except Exception as e:
    import traceback
    traceback.print_exc()

