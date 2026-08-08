# Bullseye AI — Project Overview

Bullseye AI is a modern, interactive, browser-based precision target scoring application and synthetic dataset generator. It is designed for sport shooters, archers, coaches, and machine learning engineers who require high-fidelity target visualization, real-time analytics, or computer vision training datasets.

---

## 🎯 What Is It?

At its core, Bullseye AI is a client-server web application with a Python FastAPI backend that serves two primary functions:
1. **Interactive Target Simulator**: A training and analysis tool where users can simulate shots, visualize impact coordinates, and calculate precise scores with real-time statistical metrics.
2. **ML Dataset Generator**: A synthetic data generator that creates thousands of target images with randomized bullet holes and annotations (in YOLO format) to train machine vision models for target recognition.

---

## 🚀 Key Features & Use Cases

### 1. Interactive Target Simulator
* **Precision Shot Placement**: Users can place and adjust shots by clicking or dragging circles on an Olympic-spec concentric target face.
* **Projectile Profiles**: Supports multiple projectile sizes with customized diameters:
  - `9mm Bullet` (9.0mm)
  - `Air Rifle Pellet` (4.5mm)
  - `Carbon Arrow` (5.5mm)
  - `Dart Needle` (3.0mm)
  - `Custom` (User-configurable pixel radius)
* **Scoring Rules**:
  - **Line Cutter**: Professional scoring rule where if a bullet/arrow hole touches a ring boundary line, the shooter receives the higher score.
  - **Center-Point**: Strict calculation based on the center coordinates of the impact.
* **Unit Customization**: Supports real-time unit conversion: Pixels (px), Millimeters (mm), Centimeters (cm), or Inches (in).
* **Live Analytics Dashboard**:
  - **Total Score / Average Score**
  - **Extreme Spread**: The maximum distance between any two shots in a group.
  - **Mean Distance from Center**: Helps measure shot consistency.
  - **Offset (Windage)**: Calculates directional error offset on the X and Y axes.
* **Interactive Magnifier Loupe**: A hover-based lens showing a zoomed-in grid with crosshairs for micro-level adjustment.
* **Export Utilities**: Export shot logs as standard `.csv` tables or capture target faces as `.png` images.
* **Audio Feedback**: Synthesizes impact sounds (pellets, darts, arrows, bullets, or misses) in real time using the browser's Web Audio API.

### 2. Machine Learning Dataset Generator
* **Bulk Synthesis**: Automatically generates target boards with randomly dispersed bullet holes, customizable visuals, and lighting effects.
* **Visual Noise & Skew**:
  - **Noise Level**: Synthesizes clean vector target grids, light paper texture, or outdoor/noisy range conditions.
  - **Perspective Skew**: Simulates camera angles by applying random perspective warps and rotation distortions.
* **Auto-Annotation**: Instantly generates YOLO-compliant bounding-box annotations (`class_id x_center y_center width height`) mapped to the skewed/rotated bullet holes.
* **ZIP Exporter**: Compiles all synthetic images and text annotation files into a single `.zip` file for instant client-side download.

---

## 📂 Project Architecture

The application features a modern client-server architecture:

### Frontend
* **index.html**: The main web interface containing the simulator canvas, control sidebars, statistics panels, and the dataset generator modal.
* **style.css**: Custom modern styling rules including dark mode layouts, glassmorphism, responsive grids, and animation variables.
* **app.js**: The core application logic managing coordinates, scoring math, stats calculation, canvas rendering, magnifier lens, and file exporters.
* **api_client.js**: Connects the frontend UI to the backend scoring API endpoints.
* **dataset_generator.js**: Logic for rendering synthetic target frames, distorting coordinates, formatting YOLO text structures, and compiling them into packages.
* **sound_effects.js**: An audio synthesizer module that generates custom physical impact sound waves programmatically.

### Backend
* **backend/src/api/**: The FastAPI REST API that processes images and returns scoring data.
* **backend/src/detection/**: Integration with YOLOv11 and PyTorch for accurate bounding box detection.
* **backend/src/scoring/**: OpenCV-based classical algorithms to precisely calibrate the target board and score the bullet holes accurately.

---

## 🛠️ How To Run

The project includes a unified shell script that starts both the backend API and the frontend web server concurrently.

### 1. Install Dependencies (First time only)
1. Open your terminal and navigate to the backend directory:
   ```bash
   cd backend
   ```
2. Install the required Python packages:
   ```bash
   pip install -r requirements.txt
   cd ..
   ```

### 2. Start Both Servers
1. From the project root, run the startup script:
   ```bash
   ./run.sh
   ```
   *This will automatically launch the Backend API on **http://localhost:8000** and the Frontend Web App on **http://localhost:8080**.*

2. Open your browser and navigate to **http://localhost:8080**.
3. (Optional) To run coordinate math unit tests, open **test.html** directly in your browser.
