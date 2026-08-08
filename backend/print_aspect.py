import cv2
from src.detection.detector import BulletDetector
from src.scoring.board_calibrator import calibrate

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

_, _, w, h = calib["black_contour"]
aspect_ratio = min(w, h) / max(w, h)
print(f"w: {w}, h: {h}, aspect_ratio: {aspect_ratio}")
