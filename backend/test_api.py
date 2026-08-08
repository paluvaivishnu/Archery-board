import requests
import glob
import os

# Find a test image
test_images = glob.glob("../results/images/*.jpg")
if not test_images:
    test_images = glob.glob("../*.jpg")

if not test_images:
    print("No test images found")
    exit(1)

img_path = test_images[0]
print(f"Testing with {img_path}")

try:
    with open(img_path, 'rb') as f:
        files = {'file': (os.path.basename(img_path), f, 'image/jpeg')}
        response = requests.post("http://localhost:8000/api/score", files=files)
        print("Status Code:", response.status_code)
        print("Response:", response.text[:500])
except Exception as e:
    print("Error:", e)

