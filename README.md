# Archery Board

Archery Board is an AI-powered web application for scoring archery and shooting targets. It uses a custom-trained YOLOv11 PyTorch model via a FastAPI Python backend to instantly detect bullet holes and target boundaries.

## Features
- **YOLOv11 AI Detection:** Automatically finds and scores bullet holes using an optimized PyTorch model via REST API.
- **Auto-Calibration:** Uses OpenCV classical computer vision and edge detection to perfectly align the scoring rings to the physical target paper.
- **Perspective Warp:** Drag-and-drop corner pins to correct perspective distortion if the photo was taken from an angle.
- **Real-Time Scoring:** Calculates exact scores down to the decimal using standard target dimensions (e.g. ISSF 10m Air Pistol).

## How to Run
The project includes a unified run script that starts both the backend API and the frontend web server simultaneously.

1. Install the backend dependencies (first time only):
```bash
cd backend
pip install -r requirements.txt
cd ..
```

2. Run the startup script from the project root:
```bash
./run.sh
```
This will automatically start the Backend API on `http://localhost:8000` and the Frontend Web Interface on `http://localhost:8080`.

## How to Use
1. Make sure both the backend and frontend are running.
2. Upload a photo of your target in the web interface.
3. The backend AI will automatically detect the paper boundaries and the bullet holes.
4. Click **Adjust Calibration Corners** to manually tweak the 4 corners if needed.
5. The system will warp the image and display your total score in the table!
