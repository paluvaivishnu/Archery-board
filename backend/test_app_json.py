import cv2
import asyncio
from fastapi import UploadFile
from fastapi.encoders import jsonable_encoder
from src.api.app import score_image
import io

img = cv2.imread("../resized_test.jpg")
_, buffer = cv2.imencode(".jpg", img)
file_obj = io.BytesIO(buffer)

upload_file = UploadFile(filename="test.jpg", file=file_obj)

async def test():
    try:
        response = await score_image(upload_file, debug_calib=False)
        jsonable_encoder(response)
        print("FastAPI endpoint successfully encoded response")
    except Exception as e:
        import traceback
        traceback.print_exc()

asyncio.run(test())
