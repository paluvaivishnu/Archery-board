import cv2
import asyncio
import numpy as np
from src.api.app import score_image
import io

img = cv2.imread("../resized_test.jpg")
_, buffer = cv2.imencode(".jpg", img)
file_obj = io.BytesIO(buffer)

from fastapi import UploadFile
upload_file = UploadFile(filename="test.jpg", file=file_obj)

def check_types(obj, path=""):
    if isinstance(obj, np.generic):
        print(f"FOUND NUMPY TYPE at {path}: {type(obj)}")
    elif isinstance(obj, dict):
        for k, v in obj.items():
            check_types(v, path + f"[{k}]")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            check_types(v, path + f"[{i}]")

async def test():
    response = await score_image(upload_file, debug_calib=False)
    check_types(response, "response")

asyncio.run(test())
