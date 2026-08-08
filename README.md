<div align="center">
  
# 🎯 Archery Board AI
**Precision Target Scoring & Computer Vision Analytics**

[![Python 3.10+](https://img.shields.io/badge/Python-3.10+-blue.svg?style=flat&logo=python&logoColor=white)](https://www.python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-005571?style=flat&logo=fastapi)](https://fastapi.tiangolo.com)
[![YOLOv11](https://img.shields.io/badge/YOLOv11-Ultralytics-FF9900?style=flat&logo=pytorch)](https://ultralytics.com)
[![OpenCV](https://img.shields.io/badge/OpenCV-Computer%20Vision-5C3EE8?style=flat&logo=opencv)](https://opencv.org)

Archery Board is an intelligent, AI-powered web application for scoring archery and shooting targets. By leveraging a custom-trained **YOLOv11** PyTorch model alongside a high-performance **FastAPI** backend, it instantly detects bullet holes and target boundaries with pinpoint accuracy.

---
</div>

## ✨ Key Features

- 🤖 **YOLOv11 AI Detection:** Automatically finds and scores bullet holes using an optimized PyTorch model via a REST API.
- 📐 **Auto-Calibration:** Utilizes OpenCV and classical computer vision edge detection to perfectly align scoring rings to the physical target paper.
- 🖼️ **Perspective Warp:** Drag-and-drop corner pins to seamlessly correct perspective distortion if your photo was taken from an angle.
- 💯 **Real-Time Scoring:** Calculates exact scores down to the decimal using standard official target dimensions (e.g., ISSF 10m Air Pistol).
- 🎨 **Modern Interface:** Beautiful, glassmorphic UI with real-time statistics, extreme spread calculations, and windage offsets.

---

## 🚀 Getting Started

The project includes a unified run script that automatically launches both the **Python Backend API** and the **Static Frontend Web Server** concurrently.

### 1️⃣ Install Dependencies (First time only)
```bash
cd backend
pip install -r requirements.txt
cd ..
```

### 2️⃣ Run the Application
Start everything with a single command from the project root:
```bash
./run.sh
```
> **Note:** This will automatically start the Backend API on `http://localhost:8000` and the Frontend Web Interface on `http://localhost:8080`.

---

## 💡 How to Use

1. **Launch** the app by navigating to `http://localhost:8080` in your browser.
2. **Upload** a photo of your shot target into the web interface.
3. **Analyze:** The backend AI will automatically detect the paper boundaries and plot the bullet holes.
4. **Calibrate:** Click **Adjust Calibration Corners** to manually tweak the 4 corners for perfect alignment.
5. **Score:** The system will dynamically warp the image and display your total score, average score, and grouping stats!

---
<div align="center">
  <i>Built for sport shooters, archers, and coaches who demand precision.</i>
</div>
