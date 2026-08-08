# Archery Board

Archery Board is an AI-powered web application for scoring archery and shooting targets. It uses a custom-trained YOLOv11 PyTorch model via a FastAPI Python backend to instantly detect bullet holes and target boundaries.

## Features
- **YOLOv11 AI Detection:** Automatically finds and scores bullet holes using an optimized PyTorch model via REST API.
- **Auto-Calibration:** Uses OpenCV classical computer vision and edge detection to perfectly align the scoring rings to the physical target paper.
- **Perspective Warp:** Drag-and-drop corner pins to correct perspective distortion if the photo was taken from an angle.
- **Real-Time Scoring:** Calculates exact scores down to the decimal using standard target dimensions (e.g. ISSF 10m Air Pistol).

## How to Run
### 1. Start the Backend API
```bash
cd backend
pip install -r requirements.txt
python run.py
```
This will start the FastAPI server on `http://localhost:8000`.

### 2. Start the Frontend
In a new terminal window, serve the frontend from the project root:
```bash
./run.sh
```
Or simply open `index.html` directly in your browser.

## How to Use
1. Make sure both the backend and frontend are running.
2. Upload a photo of your target in the web interface.
3. The backend AI will automatically detect the paper boundaries and the bullet holes.
4. Click **Adjust Calibration Corners** to manually tweak the 4 corners if needed.
5. The system will warp the image and display your total score in the table!
