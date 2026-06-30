# Bullseye AI — Project Overview

Bullseye AI is a modern, interactive, browser-based precision target scoring application and synthetic dataset generator. It is designed for sport shooters, archers, coaches, and machine learning engineers who require high-fidelity target visualization, real-time analytics, or computer vision training datasets.

---

## 🎯 What Is It?

At its core, Bullseye AI is a zero-dependency web application that serves two primary functions:
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

The application has been simplified into a clean, static, client-side directory structure:

* **index.html**: The main web interface containing the simulator canvas, control sidebars, statistics panels, and the dataset generator modal.
* **style.css**: Custom modern styling rules including dark mode layouts, glassmorphism, responsive grids, and animation variables.
* **app.js**: The core application logic managing coordinates, scoring math, stats calculation, canvas rendering, magnifier lens, and file exporters.
* **dataset_generator.js**: Logic for rendering synthetic target frames, distorting coordinates, formatting YOLO text structures, and compiling them into packages.
* **sound_effects.js**: An audio synthesizer module that generates custom physical impact sound waves programmatically.
* **test.html**: An automated testing suite containing 50 specific cases to verify target coordinates, scoring ring boundaries, and decimal precision math.
* **run.sh**: A simple startup script that runs Python's built-in, lightweight web server.

---

## 🛠️ How To Run

1. Open your terminal in the project directory.
2. Run the shell script:
   ```bash
   ./run.sh
   ```
3. Open your browser and navigate to **http://localhost:8000**.
4. (Optional) To run coordinate math unit tests, open **test.html** directly in your browser.
