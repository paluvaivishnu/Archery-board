# Archery Board

Archery Board is an AI-powered web application for scoring archery and shooting targets. It uses a custom-trained YOLOv11 model running locally in your browser via ONNX Runtime to instantly detect bullet holes and target boundaries.

## Features
- **YOLOv11 AI Detection:** Automatically finds and scores bullet holes using an optimized ONNX model.
- **Auto-Calibration:** Uses OpenCV classical computer vision and edge detection to perfectly align the scoring rings to the physical target paper.
- **Perspective Warp:** Drag-and-drop corner pins to correct perspective distortion if the photo was taken from an angle.
- **Real-Time Scoring:** Calculates exact scores down to the decimal using standard target dimensions (e.g. ISSF 10m Air Pistol).

## How to Use
1. Open `index.html` in your browser or run a local web server (e.g. `npx serve .`)
2. Upload a photo of your target.
3. The AI will automatically detect the paper boundaries and the bullet holes.
4. Click **Adjust Calibration Corners** to manually tweak the 4 corners if needed.
5. The system will warp the image and display your total score in the table!
