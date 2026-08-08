import cv2
import json
import base64
from src.api.app import score_image
from fastapi import UploadFile
import io
import asyncio

async def run():
    img = cv2.imread("../resized_test.jpg")
    _, buffer = cv2.imencode(".jpg", img)
    file_obj = io.BytesIO(buffer)
    upload_file = UploadFile(filename="test.jpg", file=file_obj)
    
    response = await score_image(upload_file, debug_calib=True)
    
    img_data = base64.b64decode(response["annotated_image"].split(",")[1])
    with open("debug_annotated.jpg", "wb") as f:
        f.write(img_data)
    
    print("Calibration Source:", response["calibration_source"])
    print("Total Score:", response["total_score"])
    print("Hough count:", response["calibration_source"])
    print("Target center:", response["target_center"])
    print("Target radius:", response["target_radius"])

asyncio.run(run())

