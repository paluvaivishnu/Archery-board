import cv2
from fastapi.encoders import jsonable_encoder
from src.detection.detector import BulletDetector
from src.scoring.board_calibrator import calibrate, refine_with_hough
from src.scoring.ring_scorer import score_bullets_from_detection, total_score

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

scored = score_bullets_from_detection(out["bullet_holes"], calib, confidences=out["bullet_hole_confidences"])

arrows = []
for r in scored:
    arrows.append({
        "id": r["id"],
        "x": r["bullet"][0],
        "y": r["bullet"][1],
        "score": r["score"],
        "ring": r["ring"],
    })

response = {"arrows": arrows}
try:
    jsonable_encoder(response)
    print("JSON encoding successful")
except Exception as e:
    import traceback
    traceback.print_exc()

