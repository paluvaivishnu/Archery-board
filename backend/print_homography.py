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

print(calib["source"])
print(calib.get("homography"))
