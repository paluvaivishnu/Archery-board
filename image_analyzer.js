/* ==========================================================
   BULLSEYE AI - INDUSTRIAL-GRADE TARGET IMAGE ANALYSIS MODULE
   ========================================================== */

class TargetImageAnalyzer {
    constructor() {
        this.db = null;
        this.openCvLoaded = false;
        this.jsPdfLoaded = false;
        this.onnxLoaded = false;
        this.yoloModelReady = false;
        this.yoloSession = null;
        this.yoloConfig = {
            name: "Bullet Hole Detector Only (best1)",
            modelPath: "models/best1.onnx",
            inputSize: 640,
            inputName: "auto",
            classes: [
                "hole"
            ],
            classDisplayNames: {
                "hole": "Hole"
            }
        };
        this.detectedHoles = [];
        this.yoloDetections = [];
        this.yoloWarpedDetections = [];
        
        // Active analysis session state
        this.currentSession = {
            id: null,
            name: "New Analysis Session",
            timestamp: null,
            originalImageBlob: null,
            warpedImageBase64: null,
            shots: [], // Array of { id, x, y, distancePx, distanceReal, score, type, confidence }
            stats: {},
            targetType: "olympic-rifle",
            calibration: {
                pixelsPerMm: 17.58, // Default for 10m Air Rifle
                centerX: 450,
                centerY: 450,
                cornerPoints: [
                    { x: 100, y: 100 },
                    { x: 800, y: 100 },
                    { x: 800, y: 800 },
                    { x: 100, y: 800 }
                ]
            }
        };

        // UI references
        this.originalImage = null; // HTMLImageElement
        this.resizedWidth = 900;
        this.resizedHeight = 900;
        this.scaleX = 1.0;
        this.scaleY = 1.0;

        // Interaction state
        this.activePin = null;
        this.pinRadius = 15;
        this.isCalibrating = false;
        this.isSetCenterMode = false;

        // Replay sequence state
        this.replayInterval = null;
        this.replayActive = false;
        this.replayIndex = 0;

        // Batch processing queue
        this.fileQueue = [];
        this.isProcessingQueue = false;

        // Performance benchmarking
        this.perf = {
            startTime: 0,
            opencvTime: 0,
            renderTime: 0,
            detectedCount: 0
        };

        // Saved comparison sessions
        this.sessionsList = [];

        // Content-hash cache for HITL: maps File → Promise<string>
        this._fileHashCache = new Map();

        this.initDatabase();
        this.loadExternalLibraries();
    }

    // ==========================================================
    // CONTENT-HASH HELPER  (used for HITL cache keys)
    // Computes a SHA-256 hash from the first 2KB + last 2KB of the
    // file so identical images match even if renamed or re-downloaded.
    // ==========================================================
    async getFileContentHash(file) {
        // Return cached hash if we already computed it for this File object
        if (this._fileHashCache.has(file)) return this._fileHashCache.get(file);

        const chunkSize = 2048;
        const first = file.slice(0, chunkSize);
        const last  = file.slice(Math.max(0, file.size - chunkSize));
        const blob  = new Blob([first, last]);
        const buf   = await blob.arrayBuffer();
        const hashBuf = await crypto.subtle.digest('SHA-256', buf);
        const hash = Array.from(new Uint8Array(hashBuf))
            .map(b => b.toString(16).padStart(2, '0'))
            .join('');

        this._fileHashCache.set(file, hash);
        return hash;
    }

    // ==========================================================
    // DATABASE STORAGE (IndexedDB)
    // ==========================================================
    initDatabase() {
        const request = indexedDB.open("BullseyeAnalyzerDB", 1);

        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains("sessions")) {
                db.createObjectStore("sessions", { keyPath: "id" });
            }
        };

        request.onsuccess = (e) => {
            this.db = e.target.result;
            this.loadSavedSessionsList();
        };

        request.onerror = (e) => {
            console.error("IndexedDB initialization failed:", e.target.error);
        };
    }

    async saveSession(name) {
        if (!this.db) return;

        this.currentSession.name = name || `Session ${new Date().toLocaleString()}`;
        this.currentSession.timestamp = new Date();

        const transaction = this.db.transaction(["sessions"], "readwrite");
        const store = transaction.objectStore(name ? "sessions" : "sessions");
        
        // Save current session deep copy
        const sessionCopy = JSON.parse(JSON.stringify(this.currentSession));
        sessionCopy.originalImageBlob = this.currentSession.originalImageBlob; // Restore binary blob reference

        const request = store.put(sessionCopy);

        return new Promise((resolve, reject) => {
            request.onsuccess = () => {
                this.loadSavedSessionsList();
                resolve(sessionCopy.id);
            };
            request.onerror = () => reject(request.error);
        });
    }

    async deleteSession(id) {
        if (!this.db) return;

        const transaction = this.db.transaction(["sessions"], "readwrite");
        const store = transaction.objectStore("sessions");
        const request = store.delete(id);

        return new Promise((resolve) => {
            request.onsuccess = () => {
                this.loadSavedSessionsList();
                resolve();
            };
        });
    }

    async clearAllSessions() {
        if (!this.db) return;
        const transaction = this.db.transaction(["sessions"], "readwrite");
        const store = transaction.objectStore("sessions");
        const request = store.clear();
        return new Promise((resolve) => {
            request.onsuccess = () => {
                this.loadSavedSessionsList();
                resolve();
            };
        });
    }

    loadSavedSessionsList() {
        if (!this.db) return;

        const transaction = this.db.transaction(["sessions"], "readonly");
        const store = transaction.objectStore("sessions");
        const request = store.getAll();

        request.onsuccess = (e) => {
            this.sessionsList = e.target.result || [];
            this.renderSessionsListUI();
            this.populateComparisonDropdowns();
        };
    }

    updatePlaceholderVisibility() {
        const placeholder = document.getElementById('analyzer-empty-placeholder');
        if (placeholder) {
            placeholder.style.display = this.originalImage ? 'none' : 'flex';
        }
    }

    async loadSessionIntoActive(id) {
        if (!this.db) return;

        const transaction = this.db.transaction(["sessions"], "readonly");
        const store = transaction.objectStore("sessions");
        const request = store.get(id);

        return new Promise((resolve, reject) => {
            request.onsuccess = (e) => {
                const session = e.target.result;
                if (session) {
                    this.currentSession = session;
                    
                    // Recover image object
                    if (session.originalImageBlob) {
                        const url = URL.createObjectURL(session.originalImageBlob);
                        const img = new Image();
                        img.onload = () => {
                            this.originalImage = img;
                            this.updatePlaceholderVisibility();
                            this.isCalibrating = false;
                            this.isWarpModeActive = false;
                            
                            // Reset calibration UI state
                            const pinsContainer = document.getElementById('warp-pins-container');
                            if (pinsContainer) pinsContainer.style.display = 'none';
                            const previewGroup = document.getElementById('manual-warp-preview-group');
                            if (previewGroup) previewGroup.style.display = 'none';
                            const calModeSelect = document.getElementById('calibration-mode');
                            if (calModeSelect) calModeSelect.value = 'auto';
                            const adjustToggle = document.getElementById('adjust-calibration-toggle');
                            if (adjustToggle) adjustToggle.checked = false;
                            
                            this.renderWarpedCanvas();
                            this.updateStatsUI();
                            this.renderShotsTableUI();
                            resolve(session);
                        };
                        img.src = url;
                    } else {
                        this.isCalibrating = false;
                        this.isWarpModeActive = false;
                        const pinsContainer = document.getElementById('warp-pins-container');
                        if (pinsContainer) pinsContainer.style.display = 'none';
                        const previewGroup = document.getElementById('manual-warp-preview-group');
                        if (previewGroup) previewGroup.style.display = 'none';
                        const calModeSelect = document.getElementById('calibration-mode');
                        if (calModeSelect) calModeSelect.value = 'auto';
                        const adjustToggle = document.getElementById('adjust-calibration-toggle');
                        if (adjustToggle) adjustToggle.checked = false;

                        this.renderWarpedCanvas();
                        this.updateStatsUI();
                        this.renderShotsTableUI();
                        resolve(session);
                    }
                } else {
                    reject("Session not found");
                }
            };
            request.onerror = () => reject(request.error);
        });
    }

    // ==========================================================
    // LIBRARY LOADING & CONFIGS
    // ==========================================================
    loadExternalLibraries() {
        // Dynamic loading of OpenCV.js with check interval
        if (!window.cv) {
            const cvScript = document.createElement('script');
            cvScript.src = "opencv.js";
            cvScript.async = true;
            cvScript.onload = () => {
                const startTime = Date.now();
                let checkTimer = setInterval(() => {
                    if (window.cv && window.cv.Mat) {
                        clearInterval(checkTimer);
                        this.openCvLoaded = true;
                        this.updateCvStatus(true);
                    } else if (Date.now() - startTime > 15000) {
                        clearInterval(checkTimer);
                        this.updateCvStatus(false, "OpenCV init timeout");
                        console.error("OpenCV.js loaded but failed to initialize within 15 seconds.");
                    }
                }, 100);
            };
            cvScript.onerror = () => {
                this.updateCvStatus(false, "OpenCV failed to load");
            };
            document.body.appendChild(cvScript);
        } else {
            // Already defined, check if Mat is ready (in case it was loaded in another script previously)
            if (window.cv.Mat) {
                this.openCvLoaded = true;
                this.updateCvStatus(true);
            } else {
                const startTime = Date.now();
                let checkTimer = setInterval(() => {
                    if (window.cv && window.cv.Mat) {
                        clearInterval(checkTimer);
                        this.openCvLoaded = true;
                        this.updateCvStatus(true);
                    } else if (Date.now() - startTime > 15000) {
                        clearInterval(checkTimer);
                        this.updateCvStatus(false, "OpenCV init timeout");
                    }
                }, 100);
            }
        }

        // Dynamic loading of jsPDF
        if (!window.jspdf) {
            const pdfScript = document.createElement('script');
            pdfScript.src = "https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js";
            pdfScript.async = true;
            pdfScript.onload = () => {
                this.jsPdfLoaded = true;
            };
            document.body.appendChild(pdfScript);
        } else {
            this.jsPdfLoaded = true;
        }

        // Dynamic loading of ONNX Runtime Web for configured YOLO model
        if (!window.ort) {
            const ortScript = document.createElement('script');
            ortScript.src = "models/ort.min.js";
            ortScript.async = true;
            ortScript.onload = () => {
                this.onnxLoaded = true;
                this.initYOLOEngine();
            };
            ortScript.onerror = () => {
                this.updateYoloStatus("error", "Local ONNX failed");
            };
            document.body.appendChild(ortScript);
        } else {
            this.onnxLoaded = true;
            this.initYOLOEngine();
        }
    }

    updateCvStatus(loaded, errMessage = "") {
        const icon = document.getElementById('cv-status-icon');
        const text = document.getElementById('cv-status-text');
        const box = document.getElementById('opencv-status');
        const rerunBtn = document.getElementById('rerun-analysis');

        if (!box) return;

        if (loaded) {
            box.className = "cv-status-box ready";
            icon.className = "fa-solid fa-circle-check text-success animate-bounce";
            text.textContent = "OpenCV.js Ready";
            if (rerunBtn) rerunBtn.disabled = false;
        } else {
            box.className = "cv-status-box error";
            icon.className = "fa-solid fa-circle-xmark text-danger";
            text.textContent = errMessage || "OpenCV.js Failed";
        }
    }

    updateYoloStatus(status, message) {
        const el = document.getElementById('yolo-engine-status');
        if (!el) return;
        
        el.textContent = message;
        el.className = ""; // clear all
        
        if (status === 'loading') {
            el.style.background = "rgba(245, 158, 11, 0.15)";
            el.style.color = "#f59e0b";
        } else if (status === 'ready') {
            el.style.background = "rgba(16, 185, 129, 0.15)";
            el.style.color = "#10b981";
            
            const verEl = document.getElementById('perf-model-version');
            if (verEl) verEl.textContent = `${this.yoloConfig.name} Active`;
        } else if (status === 'error') {
            el.style.background = "rgba(239, 68, 68, 0.15)";
            el.style.color = "#ef4444";
            
            const verEl = document.getElementById('perf-model-version');
            if (verEl) verEl.textContent = "OpenCV (YOLO Fallback)";
        }
    }

    async initYOLOEngine() {
        this.updateYoloStatus("loading", "Loading model config...");
        try {
            await this.loadYOLOConfig();
            this.updateYoloStatus("loading", "Loading model file...");

            // Enable verbose logging for easier browser debugging
            if (window.ort && ort.env) {
                ort.env.debug = true;
                ort.env.logLevel = 'verbose';
            }

            // Configure WebAssembly settings for maximum compatibility
            if (window.ort && ort.env && ort.env.wasm) {
                // Disable SIMD and Multi-threading to prevent low-level CPU/browser crashes
                ort.env.wasm.simd = false;
                ort.env.wasm.numThreads = 1;
                
                // Set WASM paths locally to fetch from models/ folder
                ort.env.wasm.wasmPaths = '/models/';
            }
            
            // Add a cache-busting version query parameter to ensure the browser loads the newly compiled model file
            const modelUrl = `${this.yoloConfig.modelPath}?v=14`;

            // Phase 1 - Verify Model Loading
            console.log("[YOLO Debug] ONNX Runtime version: " + (window.ort ? ort.version : "unknown"));
            console.log("[YOLO Debug] Loading model: " + modelUrl);

            // Initialize ONNX session using local WASM binaries
            this.yoloSession = await ort.InferenceSession.create(modelUrl, {
                executionProviders: ['wasm']
            });

            console.log("[YOLO Debug] Model loaded successfully");
            console.log("[YOLO Debug] Session initialized successfully.");
            console.log("[YOLO Debug] Input names: " + JSON.stringify(this.yoloSession.inputNames));
            console.log("[YOLO Debug] Output names: " + JSON.stringify(this.yoloSession.outputNames));

            // Phase 5 - Verify Class Mapping
            console.log("[YOLO Debug] Loaded class mapping:");
            this.yoloConfig.classes.forEach((className, classId) => {
                console.log(`[YOLO Debug] ${classId} -> ${className}`);
            });

            this.yoloModelReady = true;
            this.updateYoloStatus("ready", `${this.yoloConfig.name} Ready`);
        } catch (err) {
            console.error("YOLO Model load failed (graceful fallback to OpenCV):", err);
            this.yoloModelReady = false;
            // Provide a clear description of the error on the UI
            const errReason = err.message || err.toString() || "Unknown error";
            this.updateYoloStatus("error", `Offline (${errReason})`);
        }
    }

    async loadYOLOConfig() {
        try {
            const response = await fetch("models/model-config.json", { cache: "no-store" });
            if (!response.ok) return;

            const config = await response.json();
            this.yoloConfig = {
                ...this.yoloConfig,
                ...config,
                classDisplayNames: {
                    ...this.yoloConfig.classDisplayNames,
                    ...(config.classDisplayNames || {})
                }
            };
        } catch (err) {
            console.warn("Using built-in YOLO config because model-config.json could not be loaded:", err);
        }
    }

    preprocessYOLO(canvasOrMat, targetWidth = this.yoloConfig.inputSize, targetHeight = this.yoloConfig.inputSize) {
        let originalWidth = targetWidth;
        let originalHeight = targetHeight;
        if (canvasOrMat instanceof cv.Mat) {
            originalWidth = canvasOrMat.cols;
            originalHeight = canvasOrMat.rows;
        } else {
            originalWidth = canvasOrMat.width || canvasOrMat.naturalWidth || targetWidth;
            originalHeight = canvasOrMat.height || canvasOrMat.naturalHeight || targetHeight;
        }

        // ── Official Ultralytics LetterBox (matches Python exactly) ──────────
        // Python: r = min(new_shape/h, new_shape/w)
        // Python: new_unpad = (int(round(w*r)), int(round(h*r)))
        // Python: dw/dh = (new_shape - new_unpad) / 2
        // Python: top=int(round(dh-0.1)), bottom=int(round(dh+0.1))
        //         left=int(round(dw-0.1)), right=int(round(dw+0.1))
        const gain = Math.min(targetWidth / originalWidth, targetHeight / originalHeight);

        // Integer-rounded scaled dimensions (matches Python's int(round(...)))
        const newW = Math.round(originalWidth  * gain);
        const newH = Math.round(originalHeight * gain);

        // Half-padding (float, used for postprocessing reversal)
        const dw = (targetWidth  - newW) / 2;
        const dh = (targetHeight - newH) / 2;

        // Integer pixel offsets — Python's asymmetric rounding avoids off-by-one
        const top    = Math.round(dh - 0.1);
        const bottom = Math.round(dh + 0.1);
        const left   = Math.round(dw - 0.1);
        const right  = Math.round(dw + 0.1);  // eslint-disable-line no-unused-vars

        // Store letterbox params for postprocessing reversal
        // Use the float dw/dh (not the rounded offsets) so inverse is exact
        this.yoloLetterbox = { gain, padX: dw, padY: dh, originalWidth, originalHeight, targetWidth, targetHeight };

        // Step 1: resize source to exact integer newW×newH (matches cv2.INTER_LINEAR)
        const resizedCanvas = document.createElement('canvas');
        resizedCanvas.width  = newW;
        resizedCanvas.height = newH;
        const resCtx = resizedCanvas.getContext('2d');
        if (canvasOrMat instanceof cv.Mat) {
            const matCanvas = document.createElement('canvas');
            matCanvas.width  = originalWidth;
            matCanvas.height = originalHeight;
            cv.imshow(matCanvas, canvasOrMat);
            resCtx.drawImage(matCanvas, 0, 0, newW, newH);
        } else {
            resCtx.drawImage(canvasOrMat, 0, 0, newW, newH);
        }

        // Step 2: fill target canvas with gray (114,114,114) then paste at integer offset
        // (matches Python's copyMakeBorder with BORDER_CONSTANT value=(114,114,114))
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width  = targetWidth;
        tempCanvas.height = targetHeight;
        const ctx = tempCanvas.getContext('2d');
        ctx.fillStyle = 'rgb(114, 114, 114)';
        ctx.fillRect(0, 0, targetWidth, targetHeight);
        ctx.drawImage(resizedCanvas, left, top);

        // Extract pixel data and build NCHW float32 tensor
        const imgData = ctx.getImageData(0, 0, targetWidth, targetHeight);
        const data = imgData.data;
        const floatData = new Float32Array(3 * targetWidth * targetHeight);
        const area = targetWidth * targetHeight;
        for (let i = 0; i < area; i++) {
            floatData[i]            = data[i * 4]     / 255.0;  // R
            floatData[area + i]     = data[i * 4 + 1] / 255.0;  // G
            floatData[2 * area + i] = data[i * 4 + 2] / 255.0;  // B
        }

        // Debug stats
        let minVal = floatData[0], maxVal = floatData[0], sumVal = 0;
        for (let i = 0; i < floatData.length; i++) {
            const v = floatData[i];
            if (v < minVal) minVal = v;
            if (v > maxVal) maxVal = v;
            sumVal += v;
        }
        const meanVal = sumVal / floatData.length;

        console.log(`[YOLO Debug] Original image: ${originalWidth}x${originalHeight}`);
        console.log(`[YOLO Debug] Resized image: ${targetWidth}x${targetHeight}`);
        console.log(`[YOLO Debug] Resize dimensions: ${targetWidth}x${targetHeight}`);
        console.log(`[YOLO Debug] Whether aspect ratio is preserved or stretched: letterboxed`);
        console.log(`[YOLO Debug] RGB/BGR channel order: RGB`);
        console.log(`[YOLO Debug] Tensor layout (NCHW/NHWC): NCHW`);
        console.log(`[YOLO Debug] Pixel normalization method: x / 255.0`);
        console.log(`[YOLO Debug] Tensor shape: [1,3,${targetWidth},${targetHeight}]`);
        console.log(`[YOLO Debug] Input tensor type: float32`);
        console.log(`[YOLO Debug] Tensor minimum value: ${minVal}`);
        console.log(`[YOLO Debug] Tensor maximum value: ${maxVal}`);
        console.log(`[YOLO Debug] Tensor mean value: ${meanVal}`);
        console.log(`[YOLO Debug] Letterbox gain: ${gain.toFixed(6)}`);
        console.log(`[YOLO Debug] Letterbox padX (dw): ${dw.toFixed(2)}  left=${left} right=${right}`);
        console.log(`[YOLO Debug] Letterbox padY (dh): ${dh.toFixed(2)}  top=${top}  bottom=${bottom}`);
        console.log(`[YOLO Debug] Letterbox new_unpad: ${newW}x${newH}`);
        console.log(`[YOLO Debug] Letterbox original image size: ${originalWidth}x${originalHeight}`);
        console.log(`[YOLO Debug] Letterbox letterboxed image size: ${targetWidth}x${targetHeight}`);

        return new ort.Tensor('float32', floatData, [1, 3, targetWidth, targetHeight]);
    }


    postprocessYOLO(outputTensor, originalWidth, originalHeight, confThreshold) {
        const candidates = [];
        const inputSize = this.yoloConfig.inputSize || 640;
        const classCount = this.yoloConfig.classes.length;
        const dims = outputTensor.dims || [];
        const data = outputTensor.data;

        // Retrieve stored Letterbox parameters
        let gain = 1.0;
        let padX = 0;
        let padY = 0;
        if (this.yoloLetterbox) {
            gain = this.yoloLetterbox.gain;
            padX = this.yoloLetterbox.padX;
            padY = this.yoloLetterbox.padY;
        } else {
            gain = Math.min(inputSize / originalWidth, inputSize / originalHeight);
            padX = (inputSize - originalWidth * gain) / 2;
            padY = (inputSize - originalHeight * gain) / 2;
        }

        let numCandidates = 0;
        let valuesPerCandidate = 0;
        let channelFirst = true;

        if (dims.length === 3 && dims[1] === 4 + classCount) {
            valuesPerCandidate = dims[1];
            numCandidates = dims[2];
            channelFirst = true;
        } else if (dims.length === 3 && dims[2] === 4 + classCount) {
            numCandidates = dims[1];
            valuesPerCandidate = dims[2];
            channelFirst = false;
        } else {
            valuesPerCandidate = 4 + classCount;
            numCandidates = Math.floor(data.length / valuesPerCandidate);
            channelFirst = false;
        }

        console.log("[YOLO Debug] Before confidence filtering: Total candidate detections: " + numCandidates);

        const readValue = (candidateIndex, valueIndex) => {
            if (channelFirst) {
                return data[valueIndex * numCandidates + candidateIndex];
            }
            return data[candidateIndex * valuesPerCandidate + valueIndex];
        };

        for (let i = 0; i < numCandidates; i++) {
            let maxClassScore = -1;
            let classId = -1;
            for (let c = 0; c < classCount; c++) {
                const score = readValue(i, 4 + c);
                if (score > maxClassScore) {
                    maxClassScore = score;
                    classId = c;
                }
            }
            
            if (maxClassScore >= confThreshold) {
                const className = this.getYOLOClassName(classId);
                const isHole = className === "hole" || className === "bullet-holes" || className === "hit";
                const isTarget = className === "Target" || className === "target";
                // if (!isHole && !isTarget) {
                //     continue;
                // }

                const xc_input = readValue(i, 0);
                const yc_input = readValue(i, 1);
                const w_input = readValue(i, 2);
                const h_input = readValue(i, 3);
                
                // Relaxed heuristics: We trust the custom YOLO model's training
                // to correctly identify holes, regardless of perspective distortion
                // or varying pixel sizes across different camera angles.

                // Reverse Letterbox transform
                const xc = (xc_input - padX) / gain;
                const yc = (yc_input - padY) / gain;
                const w = w_input / gain;
                const h = h_input / gain;
                
                const x1 = xc - w / 2;
                const y1 = yc - h / 2;
                const x2 = xc + w / 2;
                const y2 = yc + h / 2;
                
                candidates.push({
                    x1, y1, x2, y2,
                    xc, yc, w, h,
                    classId,
                    confidence: maxClassScore,
                    className: className
                });
            }
        }

        console.log("[YOLO Debug] After confidence filtering: Remaining detections: " + candidates.length);
        return candidates;
    }

    getYOLOClassName(classId) {
        return this.yoloConfig.classes[classId] || "unknown";
    }

    calculateIoU(box1, box2) {
        const xMinInter = Math.max(box1.x1, box2.x1);
        const yMinInter = Math.max(box1.y1, box2.y1);
        const xMaxInter = Math.min(box1.x2, box2.x2);
        const yMaxInter = Math.min(box1.y2, box2.y2);
        
        const interWidth = Math.max(0, xMaxInter - xMinInter);
        const interHeight = Math.max(0, yMaxInter - yMinInter);
        const interArea = interWidth * interHeight;
        
        const box1Area = (box1.x2 - box1.x1) * (box1.y2 - box1.y1);
        const box2Area = (box2.x2 - box2.x1) * (box2.y2 - box2.y1);
        const unionArea = box1Area + box2Area - interArea;
        
        if (unionArea === 0) return 0;
        return interArea / unionArea;
    }

    runYOLONMS(candidates, iouThreshold = 0.45) {
        candidates.sort((a, b) => b.confidence - a.confidence);
        const selected = [];
        for (const box of candidates) {
            let keep = true;
            for (const active of selected) {
                if (box.classId === active.classId) {
                    const iou = this.calculateIoU(box, active);
                    if (iou > iouThreshold) {
                        keep = false;
                        break;
                    }
                }
            }
            if (keep) {
                selected.push(box);
            }
        }
        return selected;
    }

    async runYOLODetection(imageOrCanvas) {
        if (!this.yoloModelReady || !this.yoloSession) {
            console.warn("YOLO Session not ready.");
            return [];
        }
        
        const preStart = performance.now();
        const inputTensor = this.preprocessYOLO(imageOrCanvas);
        this.perf.preprocessTime = performance.now() - preStart;
        
        const infStart = performance.now();
        const configuredInputName = this.yoloConfig.inputName;
        const inputName = configuredInputName && configuredInputName !== "auto"
            ? configuredInputName
            : this.yoloSession.inputNames[0];
        const feeds = { [inputName]: inputTensor };
        const outputs = await this.yoloSession.run(feeds);
        this.perf.yoloTime = performance.now() - infStart;
        
        const outputKey = Object.keys(outputs)[0];
        const outputTensor = outputs[outputKey];
        
        // Phase 3 - Inspect Raw Model Outputs
        console.log(outputTensor.dims);
        console.log(outputTensor.type);
        console.log(outputTensor.data.length);

        console.log("[YOLO Debug] Output tensor shape: [" + outputTensor.dims.join(",") + "]");
        console.log("[YOLO Debug] Output tensor datatype: " + outputTensor.type);
        console.log("[YOLO Debug] Output tensor type: " + outputTensor.type);
        console.log("[YOLO Debug] Output tensor data length: " + outputTensor.data.length);

        const printCandidateDetails = (index) => {
            const classCount = this.yoloConfig.classes.length;
            const dims = outputTensor.dims || [];
            const data = outputTensor.data;
            let numCandidates = 0;
            let valuesPerCandidate = 0;
            let channelFirst = true;

            if (dims.length === 3 && dims[1] === 4 + classCount) {
                valuesPerCandidate = dims[1];
                numCandidates = dims[2];
                channelFirst = true;
            } else if (dims.length === 3 && dims[2] === 4 + classCount) {
                numCandidates = dims[1];
                valuesPerCandidate = dims[2];
                channelFirst = false;
            } else {
                valuesPerCandidate = 4 + classCount;
                numCandidates = Math.floor(data.length / valuesPerCandidate);
                channelFirst = false;
            }

            const getVal = (candidateIndex, valueIndex) => {
                if (channelFirst) {
                    return data[valueIndex * numCandidates + candidateIndex];
                }
                return data[candidateIndex * valuesPerCandidate + valueIndex];
            };

            const cx = getVal(index, 0);
            const cy = getVal(index, 1);
            const w = getVal(index, 2);
            const h = getVal(index, 3);
            
            const scores = [];
            let maxClassScore = -1;
            let classId = -1;
            for (let c = 0; c < classCount; c++) {
                const score = getVal(index, 4 + c);
                scores.push(score);
                if (score > maxClassScore) {
                    maxClassScore = score;
                    classId = c;
                }
            }

            console.log(`[YOLO Debug] Candidate ${index}:`);
            console.log(`  x: ${cx}`);
            console.log(`  y: ${cy}`);
            console.log(`  w: ${w}`);
            console.log(`  h: ${h}`);
            console.log(`  all class scores: [${scores.join(",")}]`);
            console.log(`  maximum class score: ${maxClassScore}`);
            console.log(`  predicted class: ${classId} (${this.getYOLOClassName(classId)})`);
        };

        for (let i = 0; i <= 3; i++) {
            printCandidateDetails(i);
        }
        
        let outMin = outputTensor.data[0];
        let outMax = outputTensor.data[0];
        for (let i = 0; i < outputTensor.data.length; i++) {
            const v = outputTensor.data[i];
            if (v < outMin) outMin = v;
            if (v > outMax) outMax = v;
        }
        console.log("[YOLO Debug] Minimum output value: " + outMin);
        console.log("[YOLO Debug] Maximum output value: " + outMax);
        console.log("[YOLO Debug] First 100 tensor values:", Array.from(outputTensor.data.slice(0, 100)));
        
        const confEl = document.getElementById('yolo-conf-threshold');
        const confThreshold = confEl ? parseFloat(confEl.value) : 0.25; // Sensible default to ignore noise

        const iouEl = document.getElementById('yolo-iou-threshold');
        const iouThreshold = iouEl ? parseFloat(iouEl.value) : 0.45;
        console.log("[YOLO Debug] confThreshold used in runYOLODetection: " + confThreshold + ", iouThreshold: " + iouThreshold);
        
        let originalWidth = 640;
        let originalHeight = 640;
        if (imageOrCanvas instanceof cv.Mat) {
            originalWidth = imageOrCanvas.cols;
            originalHeight = imageOrCanvas.rows;
        } else {
            originalWidth = imageOrCanvas.width || imageOrCanvas.naturalWidth || 640;
            originalHeight = imageOrCanvas.height || imageOrCanvas.naturalHeight || 640;
        }
        
        // Unfiltered candidates for exact ONNX output format analysis
        const unfilteredCandidates = this.postprocessYOLO(outputTensor, originalWidth, originalHeight, 0.0);
        console.log("outputTensor.dims:", JSON.stringify(outputTensor.dims));
        console.log("outputTensor.data.length:", outputTensor.data.length);
        
        console.log("[Decoded Candidates - First 20]:");
        unfilteredCandidates.slice(0, 20).forEach((cand, idx) => {
            console.log(`candidate index: ${idx}
classId: ${cand.classId}
className: ${cand.className}
confidence: ${cand.confidence.toFixed(6)}
x1: ${cand.x1.toFixed(2)}
y1: ${cand.y1.toFixed(2)}
x2: ${cand.x2.toFixed(2)}
y2: ${cand.y2.toFixed(2)}`);
        });

        // Count detections by class
        const classCounts = {};
        unfilteredCandidates.forEach(cand => {
            classCounts[cand.className] = (classCounts[cand.className] || 0) + 1;
        });
        console.log("[Detections by Class]:", JSON.stringify(classCounts));

        // Top 20 highest confidence detections
        const sortedCandidates = [...unfilteredCandidates].sort((a, b) => b.confidence - a.confidence);
        console.log("[Top 20 Highest Confidence Detections]:");
        sortedCandidates.slice(0, 20).forEach((cand, idx) => {
            console.log(`Rank ${idx+1}: Class: ${cand.className} (ID: ${cand.classId}), Confidence: ${cand.confidence.toFixed(6)}, Box: [${cand.x1.toFixed(2)}, ${cand.y1.toFixed(2)}, ${cand.x2.toFixed(2)}, ${cand.y2.toFixed(2)}]`);
        });

        // Count detections by confidence thresholds
        const confLevels = [0.25, 0.50, 0.75, 0.90];
        confLevels.forEach(lvl => {
            const count = unfilteredCandidates.filter(cand => cand.confidence > lvl).length;
            console.log(`Detections with confidence >${lvl.toFixed(2)}: ${count}`);
        });

        const candidates = this.postprocessYOLO(outputTensor, originalWidth, originalHeight, confThreshold);
        console.log("[YOLO Debug] Before NMS: Number of boxes: " + candidates.length);
        
        const finalDetections = this.runYOLONMS(candidates, iouThreshold);
        console.log("[YOLO Debug] After NMS: Final detections: " + finalDetections.length);
        finalDetections.forEach((det, idx) => {
            console.log(`[YOLO Debug] Detection ${idx + 1}: Class ID = ${det.classId}, Class Name = ${det.className}, Confidence = ${det.confidence.toFixed(4)}, Bounding Box = [${det.x1.toFixed(2)}, ${det.y1.toFixed(2)}, ${det.x2.toFixed(2)}, ${det.y2.toFixed(2)}]`);
        });
        
        return finalDetections;
    }

    getProjectileTypeByDiameter(diameterMm, classId) {
        if (classId !== undefined) {
            const className = this.getYOLOClassName(classId);
            const displayName = this.yoloConfig.classDisplayNames[className] || className;
            if (className !== "unknown") return displayName;
        }
        
        if (diameterMm < 3.0) return "Shotgun Pellet (2.0mm)";
        else if (diameterMm >= 3.0 && diameterMm < 7.5) return ".22 LR Bullet (5.6mm)";
        else if (diameterMm >= 7.5 && diameterMm < 10.0) return "9mm Bullet (9.0mm)";
        else if (diameterMm >= 10.0) return ".45 ACP Bullet (11.5mm)";
        return "9mm Bullet (9.0mm)";
    }

    getInverseWarpMatrix() {
        const M = this.getWarpPerspectiveMatrix();
        if (!M || M.empty()) return null;
        let M_inv = new cv.Mat();
        try {
            cv.invert(M, M_inv);
        } catch(e) {
            M.delete();
            return null;
        }
        M.delete();
        return M_inv;
    }

    // ==========================================================
    // FIX 1 — ROBUST BULL'S-EYE CENTER DETECTION VIA HOUGH CIRCLES
    // Replaces the fragile contour-centroid approach that would fall back
    // to hardcoded (250,250) whenever the bull's-eye wasn't perfectly centred.
    // ==========================================================
    detectTargetCenterHough() {
        if (!this.warpedMat || this.warpedMat.empty()) {
            return { x: 250, y: 250, valid: false };
        }

        let gray    = new cv.Mat();
        let blurred = new cv.Mat();
        let circles = new cv.Mat();

        try {
            cv.cvtColor(this.warpedMat, gray, cv.COLOR_RGBA2GRAY);
            cv.GaussianBlur(gray, blurred, new cv.Size(9, 9), 2);

            // Search for circles across a wide radius range in the 900×900 warped image.
            // dp=1, minDist=20, param1=100 (Canny high), param2=25 (accumulator threshold — low to catch many rings)
            cv.HoughCircles(blurred, circles, cv.HOUGH_GRADIENT, 1, 20, 100, 25, 15, 440);

            if (circles.cols > 0) {
                // Collect centres that lie within 120px of the image mid-point (450,450)
                let sumX = 0, sumY = 0, count = 0;
                for (let i = 0; i < circles.cols; i++) {
                    const cx = circles.data32F[i * 3];
                    const cy = circles.data32F[i * 3 + 1];
                    const distFromMid = Math.sqrt((cx - 450) ** 2 + (cy - 450) ** 2);
                    if (distFromMid < 120) {
                        sumX += cx;
                        sumY += cy;
                        count++;
                    }
                }

                if (count > 0) {
                    // Convert from 900-space → 500-space (scoring coordinate system)
                    const detectedX = (sumX / count) / 1.8;
                    const detectedY = (sumY / count) / 1.8;
                    console.log(`[CenterDetect] HoughCircles found center at (${detectedX.toFixed(1)}, ${detectedY.toFixed(1)}) from ${count} circles`);
                    return { x: detectedX, y: detectedY, valid: true };
                }
            }

            console.warn('[CenterDetect] HoughCircles found no concentric rings — falling back to (250,250)');
            return { x: 250, y: 250, valid: false };
        } catch (e) {
            console.warn('[CenterDetect] HoughCircles error:', e);
            return { x: 250, y: 250, valid: false };
        } finally {
            gray.delete();
            blurred.delete();
            circles.delete();
        }
    }

    // ==========================================================
    // MULTI-STRATEGY TARGET CENTER DETECTION & REFINEMENT
    // ==========================================================

    detectCenterByConcentricEllipses() {
        if (!this.warpedMat || this.warpedMat.empty()) {
            return { x: 250, y: 250, valid: false };
        }

        let gray = new cv.Mat();
        let blurred = new cv.Mat();
        let edges = new cv.Mat();
        let contours = new cv.MatVector();
        let hierarchy = new cv.Mat();

        try {
            cv.cvtColor(this.warpedMat, gray, cv.COLOR_RGBA2GRAY);
            cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
            cv.Canny(blurred, edges, 50, 150, 3, false);
            cv.findContours(edges, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);

            let ellipseCenters = [];
            for (let i = 0; i < contours.size(); i++) {
                let contour = contours.get(i);
                if (contour.rows >= 5) {
                    let area = cv.contourArea(contour);
                    let perimeter = cv.arcLength(contour, true);
                    if (perimeter > 0) {
                        let circularity = 4 * Math.PI * area / (perimeter * perimeter);
                        if (circularity > 0.4 && area > 200) {
                            try {
                                let rotatedRect = cv.fitEllipse(contour);
                                ellipseCenters.push({
                                    x: rotatedRect.center.x / 1.8,
                                    y: rotatedRect.center.y / 1.8,
                                    width: rotatedRect.size.width / 1.8,
                                    height: rotatedRect.size.height / 1.8,
                                    angle: rotatedRect.angle
                                });
                            } catch (err) {
                                // fitEllipse can occasionally fail/throw
                            }
                        }
                    }
                }
                contour.delete();
            }

            if (ellipseCenters.length >= 2) {
                let bestCluster = [];
                for (let i = 0; i < ellipseCenters.length; i++) {
                    let cluster = [ellipseCenters[i]];
                    for (let j = 0; j < ellipseCenters.length; j++) {
                        if (i === j) continue;
                        let dx = ellipseCenters[i].x - ellipseCenters[j].x;
                        let dy = ellipseCenters[i].y - ellipseCenters[j].y;
                        let dist = Math.sqrt(dx * dx + dy * dy);
                        if (dist < 15) {
                            cluster.push(ellipseCenters[j]);
                        }
                    }
                    if (cluster.length > bestCluster.length) {
                        bestCluster = cluster;
                    }
                }

                if (bestCluster.length >= 2) {
                    bestCluster.sort((a, b) => a.x - b.x);
                    let medianX = bestCluster[Math.floor(bestCluster.length / 2)].x;
                    bestCluster.sort((a, b) => a.y - b.y);
                    let medianY = bestCluster[Math.floor(bestCluster.length / 2)].y;

                    console.log(`[CenterDetect] Concentric ellipses found center at (${medianX.toFixed(1)}, ${medianY.toFixed(1)}) from cluster of ${bestCluster.length} ellipses`);
                    return { x: medianX, y: medianY, valid: true, confidence: bestCluster.length };
                }
            }

            return { x: 250, y: 250, valid: false };
        } catch (e) {
            console.warn('[CenterDetect] Concentric ellipses error:', e);
            return { x: 250, y: 250, valid: false };
        } finally {
            gray.delete();
            blurred.delete();
            edges.delete();
            contours.delete();
            hierarchy.delete();
        }
    }

    detectCenterByYellowRefinement() {
        if (!this.warpedMat || this.warpedMat.empty()) {
            return { x: 250, y: 250, valid: false };
        }

        let hsv = new cv.Mat();
        let mask = new cv.Mat();
        let rgb = new cv.Mat();
        let contours = new cv.MatVector();
        let hierarchy = new cv.Mat();

        try {
            cv.cvtColor(this.warpedMat, rgb, cv.COLOR_RGBA2RGB);
            cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);

            // Yellow HSV range
            let low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [15, 40, 100, 0]);
            let high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [35, 255, 255, 255]);
            cv.inRange(hsv, low, high, mask);

            let kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(9, 9));
            cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
            kernel.delete();

            cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

            let largestArea = 0;
            let bestContour = null;

            for (let i = 0; i < contours.size(); i++) {
                let contour = contours.get(i);
                let area = cv.contourArea(contour);
                if (area > largestArea) {
                    largestArea = area;
                    bestContour = contour;
                }
            }

            if (bestContour && largestArea > 200) {
                let M = cv.moments(bestContour, false);
                if (M.m00 !== 0) {
                    let cx = M.m10 / M.m00;
                    let cy = M.m01 / M.m00;
                    let cx500 = cx / 1.8;
                    let cy500 = cy / 1.8;
                    console.log(`[CenterDetect] Yellow refinement found center at (${cx500.toFixed(1)}, ${cy500.toFixed(1)})`);
                    
                    low.delete();
                    high.delete();
                    return { x: cx500, y: cy500, valid: true };
                }
            }

            low.delete();
            high.delete();
            return { x: 250, y: 250, valid: false };
        } catch (e) {
            console.warn('[CenterDetect] Yellow refinement error:', e);
            return { x: 250, y: 250, valid: false };
        } finally {
            hsv.delete();
            mask.delete();
            rgb.delete();
            contours.delete();
            hierarchy.delete();
        }
    }

    detectCenterMultiStrategy() {
        let ellipseResult = this.detectCenterByConcentricEllipses();
        let yellowResult = this.detectCenterByYellowRefinement();

        if (ellipseResult.valid && yellowResult.valid) {
            let dx = ellipseResult.x - yellowResult.x;
            let dy = ellipseResult.y - yellowResult.y;
            let dist = Math.sqrt(dx * dx + dy * dy);
            if (dist < 10) {
                console.log(`[CenterDetect] MultiStrategy: Ellipse & Yellow agree (dist=${dist.toFixed(1)}px). Preferring yellow: (${yellowResult.x.toFixed(1)}, ${yellowResult.y.toFixed(1)})`);
                return { x: yellowResult.x, y: yellowResult.y, valid: true, _autoDetected: true };
            } else {
                console.log(`[CenterDetect] MultiStrategy: Ellipse & Yellow disagree (dist=${dist.toFixed(1)}px). Preferring ellipse: (${ellipseResult.x.toFixed(1)}, ${ellipseResult.y.toFixed(1)})`);
                return { x: ellipseResult.x, y: ellipseResult.y, valid: true, _autoDetected: true };
            }
        }

        if (ellipseResult.valid) {
            console.log(`[CenterDetect] MultiStrategy: Using ellipse center: (${ellipseResult.x.toFixed(1)}, ${ellipseResult.y.toFixed(1)})`);
            return { x: ellipseResult.x, y: ellipseResult.y, valid: true, _autoDetected: true };
        }

        if (yellowResult.valid) {
            console.log(`[CenterDetect] MultiStrategy: Using yellow center: (${yellowResult.x.toFixed(1)}, ${yellowResult.y.toFixed(1)})`);
            return { x: yellowResult.x, y: yellowResult.y, valid: true, _autoDetected: true };
        }

        let houghResult = this.detectTargetCenterHough();
        if (houghResult.valid) {
            console.log(`[CenterDetect] MultiStrategy: Using Hough circles center: (${houghResult.x.toFixed(1)}, ${houghResult.y.toFixed(1)})`);
            return { x: houghResult.x, y: houghResult.y, valid: true, _autoDetected: true };
        }

        console.warn(`[CenterDetect] MultiStrategy: All automatic strategies failed. Falling back to default (250, 250)`);
        return { x: 250, y: 250, valid: false, _autoDetected: true };
    }

    detectRingBoundariesRadial(center) {
        if (!this.warpedMat || this.warpedMat.empty()) {
            return [];
        }

        const template = this.getTargetTemplateDetails(this.currentSession.targetType);
        const ringCount = template.ringCount || 10;
        
        const cx900 = center.x * 1.8;
        const cy900 = center.y * 1.8;
        
        const width = this.warpedMat.cols;
        const height = this.warpedMat.rows;
        const data = this.warpedMat.data;
        
        const numRays = 36;
        const maxDist = 400;
        
        const profiles = Array.from({ length: numRays }, () => new Float32Array(maxDist));
        
        for (let ray = 0; ray < numRays; ray++) {
            const angle = (ray * 10) * Math.PI / 180;
            const cosA = Math.cos(angle);
            const sinA = Math.sin(angle);
            
            for (let d = 0; d < maxDist; d++) {
                const px = Math.round(cx900 + d * cosA);
                const py = Math.round(cy900 + d * sinA);
                
                if (px >= 0 && px < width && py >= 0 && py < height) {
                    const idx = (py * width + px) * 4;
                    const r = data[idx];
                    const g = data[idx + 1];
                    const b = data[idx + 2];
                    profiles[ray][d] = 0.299 * r + 0.587 * g + 0.114 * b;
                } else {
                    profiles[ray][d] = d > 0 ? profiles[ray][d - 1] : 128;
                }
            }
        }
        
        const avgProfile = new Float32Array(maxDist);
        for (let d = 0; d < maxDist; d++) {
            let sum = 0;
            for (let ray = 0; ray < numRays; ray++) {
                sum += profiles[ray][d];
            }
            avgProfile[d] = sum / numRays;
        }
        
        const smoothed = new Float32Array(maxDist);
        for (let d = 0; d < maxDist; d++) {
            let sum = 0;
            let count = 0;
            for (let k = -2; k <= 2; k++) {
                const idx = d + k;
                if (idx >= 0 && idx < maxDist) {
                    sum += avgProfile[idx];
                    count++;
                }
            }
            smoothed[d] = sum / count;
        }
        
        const gradient = new Float32Array(maxDist - 1);
        for (let d = 0; d < maxDist - 1; d++) {
            gradient[d] = Math.abs(smoothed[d + 1] - smoothed[d]);
        }
        
        const peaks = [];
        const minPeakSpacing = 15;
        const peakThreshold = 1.5;
        
        for (let d = 1; d < maxDist - 2; d++) {
            const val = gradient[d];
            if (val > peakThreshold && val > gradient[d - 1] && val > gradient[d + 1]) {
                if (peaks.length === 0 || d - peaks[peaks.length - 1] >= minPeakSpacing) {
                    peaks.push(d);
                } else if (val > gradient[peaks[peaks.length - 1]]) {
                    peaks[peaks.length - 1] = d;
                }
            }
        }
        
        let detectedRadii = peaks.map(p => p / 1.8);
        detectedRadii.sort((a, b) => a - b);
        detectedRadii = detectedRadii.filter(r => r > 5 && r < 245);
        
        console.log(`[RadialRings] Found ${detectedRadii.length} ring boundaries via radial intensity sampling:`, 
                    detectedRadii.map(r => r.toFixed(1)));
        
        return detectedRadii;
    }

    alignAndSmoothRadii(detectedRadii, template) {
        const ringCount = template.ringCount || 10;
        const defaultSpacing = 250.0 / ringCount;
        let expectedRadii = [];
        for (let i = 1; i <= ringCount; i++) {
            expectedRadii.push(i * defaultSpacing);
        }

        if (!detectedRadii || detectedRadii.length < 2) {
            return expectedRadii;
        }

        detectedRadii.sort((a, b) => a - b);

        let spacings = [];
        for (let i = 1; i < detectedRadii.length; i++) {
            spacings.push(detectedRadii[i] - detectedRadii[i - 1]);
        }
        
        spacings = spacings.filter(s => s > 10 && s < 60);
        if (spacings.length === 0) {
            return expectedRadii;
        }
        
        spacings.sort((a, b) => a - b);
        let medianSpacing = spacings[Math.floor(spacings.length / 2)];

        let finalRadii = [];
        for (let i = 1; i <= ringCount; i++) {
            let expectedRadius = i * medianSpacing;
            let closest = detectedRadii.reduce((prev, curr) => 
                Math.abs(curr - expectedRadius) < Math.abs(prev - expectedRadius) ? curr : prev
            );
            
            if (Math.abs(closest - expectedRadius) < medianSpacing * 0.4) {
                finalRadii.push(closest);
            } else {
                if (finalRadii.length > 0) {
                    finalRadii.push(finalRadii[finalRadii.length - 1] + medianSpacing);
                } else {
                    finalRadii.push(expectedRadius);
                }
            }
        }
        return finalRadii;
    }


    // ==========================================================
    // FIX 2 — CALIBRATE pixelsPerMm FROM ACTUALLY-DETECTED RINGS
    // The old formula (250 / outerRadiusMm) only works when the board
    // fills the entire 500-px scoring canvas. This derives the true scale
    // from the ring radii that OpenCV can actually see in the warped image.
    // ==========================================================
    calibratePixelsPerMmFromRings(template) {
        const detectedRadii = this.detectAllRingRadiiWarped(template);
        if (!detectedRadii || detectedRadii.length < 3) {
            // Not enough rings detected — fall back to assumption-based formula
            const fallback = 250.0 / template.outerRadiusMm;
            console.warn(`[CalibratePxMm] Insufficient rings (${detectedRadii ? detectedRadii.length : 0}), using formula fallback: ${fallback.toFixed(4)} px/mm`);
            return fallback;
        }

        // The largest detected radius corresponds to the outermost visible ring.
        // Use ALL ring-spacing samples and take the median for robustness.
        const spacings = [];
        for (let i = 1; i < detectedRadii.length; i++) {
            spacings.push(detectedRadii[i] - detectedRadii[i - 1]);
        }
        spacings.sort((a, b) => a - b);
        const medianSpacing = spacings[Math.floor(spacings.length / 2)];

        // Each spacing = concentricSpacingMm in real-world units
        const derived = medianSpacing / template.concentricSpacingMm;

        // Sanity-check: must be within ±50% of the formula-based value
        const formulaBased = 250.0 / template.outerRadiusMm;
        if (derived < formulaBased * 0.5 || derived > formulaBased * 2.0) {
            console.warn(`[CalibratePxMm] Derived value (${derived.toFixed(4)}) is out of range — using formula fallback`);
            return formulaBased;
        }

        console.log(`[CalibratePxMm] Auto-calibrated: ${derived.toFixed(4)} px/mm (from ${detectedRadii.length} rings, median spacing=${medianSpacing.toFixed(1)}px)`);
        return derived;
    }

    // ==========================================================
    // FIX 4 — WARP QUALITY VALIDATION
    // Checks that detected ring spacings are uniform after perspective warp.
    // If variance > 20%, the homography is distorted and scores will be wrong.
    // ==========================================================
    validateWarpQuality(template) {
        const radii = this.detectAllRingRadiiWarped(template);
        if (!radii || radii.length < 3) {
            return { valid: false, reason: 'Too few rings detected after warp. Try adjusting the corner pins.' };
        }
        const spacings = [];
        for (let i = 1; i < radii.length; i++) spacings.push(radii[i] - radii[i - 1]);
        const mean = spacings.reduce((s, v) => s + v, 0) / spacings.length;
        const maxDev = Math.max(...spacings.map(s => Math.abs(s - mean) / mean));
        if (maxDev > 0.22) {
            return {
                valid: false,
                reason: `Ring spacing varies by ${(maxDev * 100).toFixed(0)}% — perspective warp may be inaccurate. Re-adjust corner pins.`
            };
        }
        return { valid: true };
    }

    hexToRgba(hex, alpha) {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r}, ${g}, ${b}, ${alpha})`;
    }


    getTargetTemplateDetails(type) {
        // Spacing in mm: standard Olympic targets
        const templates = {
            "olympic-rifle": {
                name: "Olympic 10m Air Rifle",
                outerRadiusMm: 22.75, // 1-ring outer radius
                concentricSpacingMm: 2.50,
                ringCount: 10,
                scoreMin: 1.0,
                scoreMax: 10.9
            },
            "olympic-pistol": {
                name: "Olympic 10m Air Pistol",
                outerRadiusMm: 77.75,
                concentricSpacingMm: 8.00,
                ringCount: 10,
                scoreMin: 1.0,
                scoreMax: 10.9
            },
            "archery-10ring": {
                name: "Archery 10-Ring Target",
                outerRadiusMm: 400.0,
                concentricSpacingMm: 40.0,
                ringCount: 10,
                scoreMin: 1.0,
                scoreMax: 10.9
            },
            "knsa-bullet": {
                name: "KNSA Bullet Holes Target",
                outerRadiusMm: 50.0,
                concentricSpacingMm: 5.0,
                ringCount: 12,
                scoreMin: 1.0,
                scoreMax: 12.0
            },
            "dartboard": {
                name: "Standard Dartboard",
                outerRadiusMm: 170.0,
                concentricSpacingMm: 20.0,
                ringCount: 10,
                scoreMin: 1.0,
                scoreMax: 10.9
            },
            "issf-50m": {
                name: "ISSF 50m Rifle Target",
                outerRadiusMm: 77.2,
                concentricSpacingMm: 8.0,
                ringCount: 10,
                scoreMin: 1.0,
                scoreMax: 10.9
            },
            "custom": {
                name: "Custom Target Face",
                outerRadiusMm: 100.0,
                concentricSpacingMm: 10.0,
                ringCount: 10,
                scoreMin: 1.0,
                scoreMax: 10.9
            }
        };

        return templates[type] || templates["olympic-rifle"];
    }

    // ==========================================================
    // BATCH PROCESSING QUEUE
    // ==========================================================
    async handleFilesAdded(files) {
        if (files.length === 0) return;

        // Show Queue List UI
        document.getElementById('analyzer-queue-container').style.display = 'block';

        for (let i = 0; i < files.length; i++) {
            const file = files[i];

            const queueItem = {
                id: `queue-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                file: file,
                name: file.name,
                status: "pending"
            };

            this.fileQueue.push(queueItem);
            this.renderQueueItemUI(queueItem);
        }

        this.processNextInQueue();
    }

    async handleImageUrlAdded(imageUrl) {
        try {
            if (imageUrl.startsWith('data:image/')) {
                const blob = this.dataURItoBlob(imageUrl);
                const file = new File([blob], `dragged_image_${Date.now()}.png`, { type: blob.type });
                this.handleFilesAdded([file]);
            } else {
                this.updateYoloStatus("loading", "Fetching image from URL...");
                const response = await fetch(imageUrl);
                if (!response.ok) throw new Error("Failed to fetch image from URL");
                
                const blob = await response.blob();
                const file = new File([blob], `downloaded_image_${Date.now()}.png`, { type: blob.type });
                this.handleFilesAdded([file]);
            }
        } catch (err) {
            console.error("Failed to load dropped image from URL:", err);
            alert("Unable to load image directly from this website due to browser CORS security restrictions.\n\nTip: You can save the image to your computer and drag it in, or copy-paste it directly!");
            this.updatePlaceholderVisibility();
        }
    }

    dataURItoBlob(dataURI) {
        const parts = dataURI.split(',');
        const byteString = atob(parts[1]);
        const mimeString = parts[0].split(':')[1].split(';')[0];
        const ab = new ArrayBuffer(byteString.length);
        const ia = new Uint8Array(ab);
        for (let i = 0; i < byteString.length; i++) {
            ia[i] = byteString.charCodeAt(i);
        }
        return new Blob([ab], { type: mimeString });
    }

    renderQueueItemUI(item) {
        const list = document.getElementById('analyzer-queue-list');
        if (!list) return;

        const div = document.createElement('div');
        div.className = "queue-item";
        div.id = item.id;
        div.innerHTML = `
            <span class="item-title" title="${item.name}">${item.name}</span>
            <div class="item-actions">
                <span class="item-status pending">Pending</span>
            </div>
        `;
        list.appendChild(div);
    }

    updateQueueItemStatus(id, status) {
        const item = document.getElementById(id);
        if (!item) return;

        const action = item.querySelector('.item-actions');
        if (!action) return;

        let statusClass = "pending";
        if (status === "Processing") statusClass = "processing";
        else if (status === "Success") statusClass = "success";
        else if (status === "Error") statusClass = "error";

        action.innerHTML = `<span class="item-status ${statusClass}">${status}</span>`;
    }

    async processNextInQueue() {
        if (this.isProcessingQueue) return;

        const pendingItem = this.fileQueue.find(item => item.status === "pending");
        if (!pendingItem) {
            // Queue complete, hide progress bar
            document.getElementById('queue-progress-container').style.display = 'none';
            return;
        }

        this.isProcessingQueue = true;
        pendingItem.status = "processing";
        this.updateQueueItemStatus(pendingItem.id, "Processing");
        
        // Show progress bar
        const progressContainer = document.getElementById('queue-progress-container');
        progressContainer.style.display = 'block';
        
        // Update bar width
        const total = this.fileQueue.length;
        const processed = this.fileQueue.filter(item => item.status !== "pending" && item.status !== "processing").length;
        const pct = Math.round((processed / total) * 100);
        document.getElementById('queue-progress').style.width = `${pct}%`;

        try {
            await this.processSingleFile(pendingItem.file);
            pendingItem.status = "success";
            this.updateQueueItemStatus(pendingItem.id, "Success");
        } catch (err) {
            console.error("Failed to process file:", pendingItem.name, err);
            pendingItem.status = "error";
            this.updateQueueItemStatus(pendingItem.id, "Error");
            alert(`Failed to process image "${pendingItem.name}":\n${err.message || err}\n\nStack:\n${err.stack || "No stack trace available."}`);
        }

        this.isProcessingQueue = false;
        
        // Restore any cached Human-in-the-Loop manual holes for this specific file
        try {
            const contentHash = await this.getFileContentHash(pendingItem.file);
            const cacheKey = `hitl_cache_${contentHash}`;
            const cached = localStorage.getItem(cacheKey);
            if (cached) {
                const cachedShots = JSON.parse(cached);
                if (cachedShots && cachedShots.length > 0) {
                    this.currentSession.shots = cachedShots;
                    this.currentSession.shots.sort((a, b) => b.score - a.score);

                    // Generate the warped base64 image first so that renderWarpedCanvas has a real background image to draw
                    this.applyPerspectiveWarp();

                    // Re-render UI so restored shots are visible
                    this.calculateAdvancedStats();
                    this.calculateConfidenceScores();
                    this.renderWarpedCanvas();
                    this.updateStatsUI();
                    this.renderShotsTableUI();
                    this.renderPerformanceUI();
                    console.log(`[HITL] Restored ${cachedShots.length} cached shots (queue path)`);
                }
            }
        } catch (e) {
            console.warn("Failed to restore HITL cache (queue path)", e);
        }

        // Process next item
        setTimeout(() => this.processNextInQueue(), 100);
    }

    applyPerspectiveWarp() {
        if (!this.originalImage || !this.originalMat) return;

        const pins = this.currentSession.calibration.cornerPoints;
        if (!pins || pins.length !== 4) return;

        const srcPtsData = [];
        pins.forEach(pin => {
            srcPtsData.push(pin.x / this.scaleX);
            srcPtsData.push(pin.y / this.scaleY);
        });

        const dstPtsData = this.computeProportionalDstPoints(pins);

        let srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, srcPtsData);
        let dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, dstPtsData);

        let M = cv.getPerspectiveTransform(srcPts, dstPts);
        
        if (this.warpedMat) this.warpedMat.delete();
        this.warpedMat = new cv.Mat();
        this.cachedBlackRadius = null;
        this.currentSession.detectedRingRadii = null;
        this.currentSession._calibratedPixelsPerMm = null;
        
        cv.warpPerspective(this.originalMat, this.warpedMat, M, new cv.Size(900, 900));

        srcPts.delete();
        dstPts.delete();
        M.delete();

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = 900;
        tempCanvas.height = 900;
        cv.imshow(tempCanvas, this.warpedMat);
        this.currentSession.warpedImageBase64 = tempCanvas.toDataURL();
    }

    async cacheManualHoles() {
        if (!this.currentSession.originalImageBlob) return;
        const file = this.currentSession.originalImageBlob;

        try {
            const contentHash = await this.getFileContentHash(file);
            const cacheKey = `hitl_cache_${contentHash}`;

            // Save the ENTIRE perfectly corrected shots array so deletions are captured too
            localStorage.setItem(cacheKey, JSON.stringify(this.currentSession.shots));
            console.log(`[HITL] Cached ${this.currentSession.shots.length} shots (key=${cacheKey.slice(0,24)}…)`);
        } catch (e) {
            console.warn("Failed to cache manual holes", e);
        }
    }

    async processSingleFile(file) {
        if (!this.openCvLoaded) {
            alert("OpenCV.js has not finished loading. Please wait.");
            throw new Error("OpenCV not ready");
        }

        this.currentSession.id = `session-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`;
        this.currentSession.originalImageBlob = file;

        // Load image onto Image object
        const url = URL.createObjectURL(file);
        const img = new Image();

        return new Promise((resolve, reject) => {
            img.onload = async () => {
                try {
                    this.originalImage = img;
                    this.updatePlaceholderVisibility();
                    this.isCalibrating = true;
                    
                    // Set default pins relative to image size
                    const w = img.naturalWidth;
                    const h = img.naturalHeight;
                    this.currentSession.calibration.cornerPoints = [
                        { x: Math.round(w * 0.1), y: Math.round(h * 0.1) },
                        { x: Math.round(w * 0.9), y: Math.round(h * 0.1) },
                        { x: Math.round(w * 0.9), y: Math.round(h * 0.9) },
                        { x: Math.round(w * 0.1), y: Math.round(h * 0.9) }
                    ];

                    await this.runCVAnalysisPipeline();
                    resolve();
                } catch (err) {
                    console.error("Error running CV analysis pipeline:", err);
                    reject(err);
                }
            };
            img.onerror = () => reject("Image loading error");
            img.src = url;
        });
    }

    // ==========================================================
    // COMPUTER VISION PIPELINE
    // ==========================================================
    async runCVAnalysisPipeline() {
        if (!this.originalImage) return;

        this.perf.startTime = performance.now();

        // 1. Prepare/Resize source canvas
        const srcCanvas = document.createElement('canvas');
        const imgW = this.originalImage.naturalWidth;
        const imgH = this.originalImage.naturalHeight;
        
        // Keep sizes reasonable (Max 1200px) to prevent memory crashes
        const maxDim = 1200;
        if (imgW > maxDim || imgH > maxDim) {
            if (imgW > imgH) {
                this.resizedWidth = maxDim;
                this.resizedHeight = Math.round(imgH * (maxDim / imgW));
            } else {
                this.resizedHeight = maxDim;
                this.resizedWidth = Math.round(imgW * (maxDim / imgH));
            }
        } else {
            this.resizedWidth = imgW;
            this.resizedHeight = imgH;
        }

        this.scaleX = imgW / this.resizedWidth;
        this.scaleY = imgH / this.resizedHeight;

        srcCanvas.width = this.resizedWidth;
        srcCanvas.height = this.resizedHeight;
        const srcCtx = srcCanvas.getContext('2d');
        srcCtx.drawImage(this.originalImage, 0, 0, this.resizedWidth, this.resizedHeight);

        // Load into OpenCV Mat
        let srcMat = cv.imread(srcCanvas);
        if (this.originalMat) this.originalMat.delete();
        this.originalMat = srcMat.clone();
        srcMat.delete();

        // Reset/Clear old session results
        this.currentSession.shots = [];
        this.yoloDetections = [];
        this.yoloWarpedDetections = [];
        this.detectedHoles = [];

        // Try Target Auto-Detection immediately on load
        try {
            const corners = await this.detectTargetConcentricCircles(this.originalMat);
            if (corners.length === 4) {
                this.currentSession.calibration.autoDetected = true;

                // Sub-pixel corner refinement: refine detected corners by finding
                // the strongest Shi-Tomasi corner feature near each detected point.
                // cv.cornerSubPix is not available in this OpenCV.js build, so we use
                // cv.goodFeaturesToTrack on a local ROI around each corner instead.
                let refinedCorners = corners;
                try {
                    let grayForRefine = new cv.Mat();
                    cv.cvtColor(this.originalMat, grayForRefine, cv.COLOR_RGBA2GRAY);

                    const searchRadius = 15; // pixels to search around each detected corner
                    refinedCorners = [];

                    for (let i = 0; i < corners.length; i++) {
                        const pt = corners[i];
                        // Define ROI around the detected corner, clamped to image bounds
                        const x0 = Math.max(0, Math.round(pt.x) - searchRadius);
                        const y0 = Math.max(0, Math.round(pt.y) - searchRadius);
                        const x1 = Math.min(grayForRefine.cols, Math.round(pt.x) + searchRadius);
                        const y1 = Math.min(grayForRefine.rows, Math.round(pt.y) + searchRadius);
                        const roiW = x1 - x0;
                        const roiH = y1 - y0;

                        if (roiW > 5 && roiH > 5) {
                            let roi = grayForRefine.roi(new cv.Rect(x0, y0, roiW, roiH));
                            let localCorners = new cv.Mat();

                            // Find the single strongest corner in the ROI
                            cv.goodFeaturesToTrack(roi, localCorners, 1, 0.01, 3, new cv.Mat(), 3, false, 0.04);

                            if (localCorners.rows > 0) {
                                // Map local ROI coordinates back to image coordinates
                                const rx = localCorners.data32F[0] + x0;
                                const ry = localCorners.data32F[1] + y0;
                                // Drift guard: reject if refined corner moved too far (> 10px)
                                // from the original — prevents snapping to unrelated gradient features
                                const drift = Math.sqrt((rx - pt.x) ** 2 + (ry - pt.y) ** 2);
                                if (drift <= 10) {
                                    refinedCorners.push({ x: rx, y: ry });
                                } else {
                                    console.log(`[CornerRefine] Corner ${i} drifted ${drift.toFixed(1)}px — keeping original`);
                                    refinedCorners.push(pt);
                                }
                            } else {
                                refinedCorners.push(pt); // no better corner found, keep original
                            }

                            localCorners.delete();
                            roi.delete();
                        } else {
                            refinedCorners.push(pt); // ROI too small, keep original
                        }
                    }

                    console.log('[CornerRefine] goodFeaturesToTrack refinement applied:',
                        corners.map((c, i) => `(${c.x.toFixed(0)},${c.y.toFixed(0)})→(${refinedCorners[i].x.toFixed(2)},${refinedCorners[i].y.toFixed(2)})`).join(', '));

                    grayForRefine.delete();
                } catch (refineErr) {
                    console.warn('[CornerRefine] Corner refinement failed, using raw corners:', refineErr.message);
                    refinedCorners = corners;
                }

                this.currentSession.calibration.cornerPoints = refinedCorners.map(pt => ({
                    x: Math.round(pt.x * this.scaleX),
                    y: Math.round(pt.y * this.scaleY)
                }));
            } else {
                this.currentSession.calibration.autoDetected = false;
            }
        } catch (cvErr) {
            console.warn("Auto target detection contour fitting error on load:", cvErr);
            this.currentSession.calibration.autoDetected = false;
        }

        // Skip the manual calibration preview — go straight to analysis.
        // Corners have already been auto-detected and set above.
        this.isCalibrating = false;
        this.isWarpModeActive = false;

        // Hide calibration UI elements (no corner pins shown)
        const pinsContainer = document.getElementById('warp-pins-container');
        if (pinsContainer) pinsContainer.style.display = 'none';

        const previewGroup = document.getElementById('manual-warp-preview-group');
        if (previewGroup) previewGroup.style.display = 'none';

        const fallbackSec = document.getElementById('manual-fallback-section');
        if (fallbackSec) fallbackSec.style.display = 'none';

        const adjustToggle = document.getElementById('adjust-calibration-toggle');
        if (adjustToggle) adjustToggle.checked = false;

        // Reset stats
        this.currentSession.stats = {
            totalShots: 0,
            totalScore: 0,
            avgScore: 0,
            extremeSpread: 0,
            meanRadius: 0,
            cep: 0,
            windage: 0,
            elevation: 0,
            minScore: 0,
            maxScore: 0
        };
        this.updateStatsUI();
        this.renderShotsTableUI();

        // Automatically run full analysis — no manual step needed.
        await this.runAnalysis();
    }

    async runAnalysis() {
        if (!this.originalImage || !this.originalMat) return;

        // Show loading status badge on canvas
        const statusBadge = document.getElementById('analyzer-canvas-badge');
        const statusText = document.getElementById('analyzer-status-badge-text');
        if (statusBadge && statusText) {
            statusText.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Analyzing Target...`;
            statusBadge.className = "canvas-status-floating status-info";
            statusBadge.style.display = "block";
        }

        let cvStartTime = performance.now();

        // Compute the warped perspective matrix and warpedMat (required for YOLO/Hybrid detection)
        const pins = this.currentSession.calibration.cornerPoints;
        if (pins && pins.length === 4) {
            const srcPtsData = [];
            pins.forEach(pin => {
                srcPtsData.push(pin.x / this.scaleX);
                srcPtsData.push(pin.y / this.scaleY);
            });
            const dstPtsData = this.computeProportionalDstPoints(pins);

            let srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, srcPtsData);
            let dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, dstPtsData);
            let M = cv.getPerspectiveTransform(srcPts, dstPts);
            
            if (this.warpedMat) this.warpedMat.delete();
            this.warpedMat = new cv.Mat();
            this.cachedBlackRadius = null;
            cv.warpPerspective(this.originalMat, this.warpedMat, M, new cv.Size(900, 900));
            
            srcPts.delete();
            dstPts.delete();
            M.delete();

            // Save warped image as base64 for history caching
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = 900;
            tempCanvas.height = 900;
            cv.imshow(tempCanvas, this.warpedMat);
            this.currentSession.warpedImageBase64 = tempCanvas.toDataURL();
        }

        // 2. Run YOLO/OpenCV hole detection on original image Mat
        await this.detectImpactShots();

        this.perf.opencvTime = performance.now() - cvStartTime;

        // 3. Switch to Warped View Mode automatically
        this.isWarpModeActive = false;
        this.isCalibrating = false;

        const previewGroup = document.getElementById('manual-warp-preview-group');
        if (previewGroup) previewGroup.style.display = 'none';
        const pinsContainer = document.getElementById('warp-pins-container');
        if (pinsContainer) pinsContainer.style.display = 'none';

        const previewCheckbox = document.getElementById('manual-warp-preview');
        if (previewCheckbox) previewCheckbox.checked = true;

        // Reset the toggle switch in UI
        const adjustToggle = document.getElementById('adjust-calibration-toggle');
        if (adjustToggle) adjustToggle.checked = false;

        // Compute perspective warp and score detections
        await this.applyWarpAndImpactDetection();

        // Check if there is a saved HITL cache for this image!
        if (this.currentSession.originalImageBlob) {
            try {
                const file = this.currentSession.originalImageBlob;
                const contentHash = await this.getFileContentHash(file);
                const cacheKey = `hitl_cache_${contentHash}`;
                const cached = localStorage.getItem(cacheKey);
                if (cached) {
                    const cachedShots = JSON.parse(cached);
                    if (cachedShots && cachedShots.length > 0) {
                        // Re-score each cached shot against the current warp geometry
                        const template = this.getTargetTemplateDetails(this.currentSession.targetType);
                        for (const shot of cachedShots) {
                            const scoreObj = this.calculateAnalyticScore(
                                shot.x, shot.y, template
                            );
                            shot.score = scoreObj.score;
                            shot.distancePx = scoreObj.distancePx;
                            if (scoreObj.distanceMm !== undefined) {
                                shot.distanceReal = scoreObj.distanceMm;
                            }
                        }

                        this.currentSession.shots = cachedShots;
                        this.currentSession.shots.sort((a, b) => b.score - a.score);

                        // Regenerate YOLO detections so restored manual shots still get labels
                        this.yoloDetections = [];
                        this.yoloWarpedDetections = this.currentSession.shots.map((shot, idx) => ({
                            classId: 0,
                            className: shot.type === "Manual Entry" ? "Manual Hole" : "Hole",
                            confidence: shot.confidence !== undefined ? (shot.confidence / 100) : 1.0,
                            x1: (shot.x * 1.8) - 15,
                            y1: (shot.y * 1.8) - 15,
                            x2: (shot.x * 1.8) + 15,
                            y2: (shot.y * 1.8) + 15,
                            shotIndex: idx
                        }));

                        // Re-render UI so restored shots are visible
                        this.calculateAdvancedStats();
                        this.calculateConfidenceScores();
                        this.renderWarpedCanvas();
                        this.updateStatsUI();
                        this.renderShotsTableUI();
                        this.renderPerformanceUI();
                        console.log(`[HITL] Restored & re-scored ${cachedShots.length} cached shots (analysis path)`);
                    }
                }
            } catch (e) {
                console.warn("Failed to restore HITL cache in runAnalysis", e);
            }
        }

        // If no holes detected, show warning status badge
        if (this.currentSession.shots.length === 0) {
            if (statusBadge && statusText) {
                statusText.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> No holes detected by the custom YOLO model.`;
                statusBadge.className = "canvas-status-floating status-warning";
                statusBadge.style.display = "block";
            }
        } else {
            // Hide badge on successful analysis
            if (statusBadge) statusBadge.style.display = 'none';
        }
    }

    applyManualEntry() {
        if (!this.originalImage || !this.originalMat) {
            alert("Please upload a target image first.");
            return;
        }

        const countEl = document.getElementById('manual-holes-count');
        const distEl = document.getElementById('manual-holes-distance');
        if (!countEl || !distEl) return;

        const count = parseInt(countEl.value) || 0;
        const distMm = parseFloat(distEl.value) || 0;

        if (count <= 0) {
            alert("Please specify a valid number of holes greater than 0.");
            return;
        }

        // Hide canvas badge
        const statusBadge = document.getElementById('analyzer-canvas-badge');
        if (statusBadge) statusBadge.style.display = 'none';

        // Switch to warped view mode
        this.isWarpModeActive = false;
        this.isCalibrating = false;

        const previewGroup = document.getElementById('manual-warp-preview-group');
        if (previewGroup) previewGroup.style.display = 'none';
        const pinsContainer = document.getElementById('warp-pins-container');
        if (pinsContainer) pinsContainer.style.display = 'none';

        const previewCheckbox = document.getElementById('manual-warp-preview');
        if (previewCheckbox) previewCheckbox.checked = true;

        // Warp backing matrix
        const M = this.getWarpPerspectiveMatrix();
        if (this.warpedMat) this.warpedMat.delete();
        this.warpedMat = new cv.Mat();
        this.cachedBlackRadius = null;
        this.currentSession.detectedRingRadii = null;
        this.currentSession.detectedTargetCenter = null;
        this.currentSession._calibratedPixelsPerMm = null; // FIX: invalidate ring-scale cache
        cv.warpPerspective(this.originalMat, this.warpedMat, M, new cv.Size(900, 900));

        // Save warped image base64
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = 900;
        tempCanvas.height = 900;
        cv.imshow(tempCanvas, this.warpedMat);
        this.currentSession.warpedImageBase64 = tempCanvas.toDataURL();

        // Calculate pixels per mm
        const template = this.getTargetTemplateDetails(this.currentSession.targetType);
        const pixelsPerMm = 400.0 / template.outerRadiusMm;
        // Sync calibration object for the manual shot radius/area calculation below
        // (ring-calibrated value, if available, will already be set on the object)
        if (!this.currentSession._calibratedPixelsPerMm) {
            this.currentSession.calibration.pixelsPerMm = pixelsPerMm;
        }

        // Convert distance to pixels
        const distPx = distMm * pixelsPerMm;

        // Generate N shots spaced evenly around a circle centered at (450, 450)
        const manualShots = [];
        for (let i = 0; i < count; i++) {
            const angle = (i * 2 * Math.PI) / count;
            const cx = 450 + distPx * Math.cos(angle);
            const cy = 450 + distPx * Math.sin(angle);

            const scoreObj = this.calculateAnalyticScore(cx, cy);
            
            // Standard diameter for .22 LR (5.6mm)
            const diameterMm = 5.6; 
            const projectileType = this.getProjectileTypeByDiameter(diameterMm);

            manualShots.push({
                id: `shot-manual-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                x: Math.round(cx),
                y: Math.round(cy),
                radius: Math.round((diameterMm * pixelsPerMm) / 2),
                area: Math.round(Math.PI * ((diameterMm * pixelsPerMm) / 2) ** 2),
                distancePx: distPx,
                distanceReal: distMm,
                score: scoreObj.score,
                type: `Manual Entry`,
                confidence: 100
            });
        }

        // Save manual shots
        manualShots.sort((a, b) => b.score - a.score);
        this.currentSession.shots = manualShots;

        if (M) M.delete();

        // Recalculate stats and update UI
        this.calculateAdvancedStats();
        this.calculateConfidenceScores();
        this.renderWarpedCanvas();
        this.updateStatsUI();
        this.renderShotsTableUI();
        this.renderPerformanceUI();
    }

    addManualHoleAtCoordinates(cx, cy) {
        const scoreObj = this.calculateAnalyticScore(cx, cy);
        const center = (this.currentSession.detectedTargetCenter &&
                        this.currentSession.detectedTargetCenter.valid)
            ? this.currentSession.detectedTargetCenter
            : { x: 250, y: 250 };
        const distPx = Math.sqrt((cx - center.x) ** 2 + (cy - center.y) ** 2);
        const distReal = distPx / (this.currentSession.calibration.pixelsPerMm || 17.58);

        // Standard bullet diameter (5.6mm)
        const diameterMm = 5.6; 
        const pixelsPerMm = this.currentSession.calibration.pixelsPerMm || 17.58;

        const projX = cx * 1.8;
        const projY = cy * 1.8;
        let origX = projX;
        let origY = projY;

        const M_inv = this.getInverseWarpMatrix();
        if (M_inv && !M_inv.empty()) {
            const unproj = this.projectPoint(projX, projY, M_inv);
            origX = unproj.x;
            origY = unproj.y;
            M_inv.delete();
        }

        const newShot = {
            id: `shot-manual-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
            x: Math.round(cx),
            y: Math.round(cy),
            radius: Math.round((diameterMm * pixelsPerMm) / 2),
            area: Math.round(Math.PI * ((diameterMm * pixelsPerMm) / 2) ** 2),
            distancePx: distPx,
            distanceReal: distReal,
            score: scoreObj.score,
            type: "Manual Entry",
            confidence: 100,
            origX: origX,
            origY: origY,
            projX: projX,
            projY: projY
        };

        this.currentSession.shots.push(newShot);
        
        // Sort shots by score descending
        this.currentSession.shots.sort((a, b) => b.score - a.score);

        // Recalculate stats and update UI
        this.calculateAdvancedStats();
        this.calculateConfidenceScores();
        this.renderWarpedCanvas();
        this.updateStatsUI();
        this.renderShotsTableUI();
        this.renderPerformanceUI();
        
        this.cacheManualHoles();
    }

    // ==========================================================
    // MANUAL CENTER SETTING
    // Called when the user clicks the bullseye in "Set Center" mode.
    // Immediately rescores every existing shot from the new center.
    // ==========================================================
    setManualCenter(canvasX, canvasY) {
        // canvasX/canvasY are in 900-space; convert to 500-space for the scoring engine
        const cx500 = canvasX / 1.8;
        const cy500 = canvasY / 1.8;

        this.currentSession.detectedTargetCenter = {
            x: cx500,
            y: cy500,
            valid: true,
            _houghRan: true,     // prevent Hough from overwriting on next score call
            _manuallySet: true
        };

        // Invalidate calibrated scale so next score call re-derives it from rings
        this.currentSession._calibratedPixelsPerMm = null;

        console.log(`[ManualCenter] Set to (${cx500.toFixed(1)}, ${cy500.toFixed(1)}) in 500-space`);

        // Rescore every existing shot from the new center
        const shots = this.currentSession.shots;
        if (shots && shots.length > 0) {
            for (const shot of shots) {
                const updated = this.calculateAnalyticScore(shot.x, shot.y);
                shot.score = updated.score;
            }
            // Re-sort by score descending (ISSF convention)
            shots.sort((a, b) => b.score - a.score);
        }

        // Exit set-center mode
        this.isSetCenterMode = false;
        const btn = document.getElementById('set-center-btn');
        if (btn) {
            btn.classList.remove('active');
            btn.innerHTML = '<i class="fa-solid fa-crosshairs"></i> Set Center';
        }
        const canvas = document.getElementById('analyzer-canvas');
        if (canvas) canvas.style.cursor = 'crosshair';

        // Refresh everything
        this.renderWarpedCanvas();
        this.updateShotListUI();
        this.updateStatsUI();

        // Show a quick confirmation badge
        const statusBadge = document.getElementById('analyzer-canvas-badge');
        const statusText  = document.getElementById('analyzer-status-badge-text');
        if (statusBadge && statusText) {
            statusText.innerHTML = `<i class="fa-solid fa-circle-check"></i> Center set — scores recalculated`;
            statusBadge.className = 'canvas-status-floating status-success';
            statusBadge.style.display = 'block';
            setTimeout(() => { statusBadge.style.display = 'none'; }, 3000);
        }
    }

    toggleHoleAtCoordinates(cx, cy) {
        // Find if we clicked close to an existing shot in this session
        const clickRadius = 15; // px tolerance
        const hitIdx = this.currentSession.shots.findIndex(shot => {

            const dx = cx - shot.x;
            const dy = cy - shot.y;
            return Math.sqrt(dx*dx + dy*dy) < Math.max(shot.radius || 10, clickRadius);
        });

        if (hitIdx !== -1) {
            // Unselect it (delete)
            const shot = this.currentSession.shots[hitIdx];
            this.deleteShotFromSession(shot.id);
        } else {
            // Select it (add manual hole)
            this.addManualHoleAtCoordinates(cx, cy);
        }
    }

    detectTargetYellowCentroidAndRadius(mat) {
        let hsv = new cv.Mat();
        let mask = new cv.Mat();
        let rgb = new cv.Mat();
        try {
            cv.cvtColor(mat, rgb, cv.COLOR_RGBA2RGB);
            cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
            
            // Yellow/beige HSV range: Hue 10–40, Saturation 20–255, Value 120–255
            // Widened to catch the full beige board paper, not just the bright inner rings
            let low  = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [10, 20, 120, 0]);
            let high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [40, 255, 255, 255]);
            cv.inRange(hsv, low, high, mask);
            
            // Morphological close to fill small gaps in the yellow region
            let kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(15, 15));
            cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, kernel);
            kernel.delete();
            
            let contours = new cv.MatVector();
            let hierarchy = new cv.Mat();
            cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
            
            let maxArea = 0;
            let bestContour = null;
            
            for (let i = 0; i < contours.size(); i++) {
                let contour = contours.get(i);
                let area = cv.contourArea(contour);
                // Must be large — at least 10% of image area — to be the board, not a noise blob
                if (area > mat.rows * mat.cols * 0.10 && area > maxArea) {
                    maxArea = area;
                    if (bestContour) bestContour.delete();
                    bestContour = contour.clone();
                }
                contour.delete();
            }
            
            low.delete();
            high.delete();
            contours.delete();
            hierarchy.delete();
            
            if (bestContour) {
                // Try ellipse fitting first — crucial for angled shots
                // fitEllipse requires at least 5 points
                if (bestContour.rows >= 5) {
                    try {
                        const ellipse = cv.fitEllipse(bestContour);
                        const majorAxis = Math.max(ellipse.size.width, ellipse.size.height);
                        const minorAxis = Math.min(ellipse.size.width, ellipse.size.height);
                        const aspectRatio = majorAxis / Math.max(minorAxis, 1);

                        if (aspectRatio > 1.15) {
                            // Angled view detected — return ellipse data for perspective-aware corners
                            console.log(`[BoardDetect] Yellow mask ellipse: center=(${ellipse.center.x.toFixed(0)},${ellipse.center.y.toFixed(0)}), ` +
                                `size=(${ellipse.size.width.toFixed(0)}×${ellipse.size.height.toFixed(0)}), angle=${ellipse.angle.toFixed(1)}°, aspect=${aspectRatio.toFixed(2)}`);
                            bestContour.delete();
                            return {
                                cx: ellipse.center.x,
                                cy: ellipse.center.y,
                                r: majorAxis / 2,
                                ellipse: ellipse, // { center, size, angle }
                                isElliptical: true
                            };
                        }
                    } catch (ellipseErr) {
                        console.warn("Ellipse fitting failed, falling back to circle:", ellipseErr);
                    }
                }

                // Straight-on view — use circle as before
                let circle = cv.minEnclosingCircle(bestContour);
                const cx = circle.center.x;
                const cy = circle.center.y;
                const r  = circle.radius;
                bestContour.delete();
                console.log(`[BoardDetect] Yellow mask circle: center=(${cx.toFixed(0)},${cy.toFixed(0)}), radius=${r.toFixed(0)}px`);
                return { cx, cy, r };
            }
        } catch (err) {
            console.warn("Yellow mask target detection failed:", err);
        } finally {
            rgb.delete();
            hsv.delete();
            mask.delete();
        }
        return null;
    }


    detectTargetClassical(mat) {
        let gray = new cv.Mat();
        let blurred = new cv.Mat();
        let circles = new cv.Mat();
        try {
            cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);
            cv.GaussianBlur(gray, blurred, new cv.Size(9, 9), 2, 2);
            
            const dp = 1.2;
            const minDist = 20;
            const param1 = 70;
            const param2 = 40;
            const minRadius = Math.round(Math.min(mat.rows, mat.cols) * 0.15);
            const maxRadius = Math.round(Math.min(mat.rows, mat.cols) * 0.48);
            
            cv.HoughCircles(blurred, circles, cv.HOUGH_GRADIENT, dp, minDist, param1, param2, minRadius, maxRadius);
            
            if (circles.cols > 0) {
                const list = [];
                for (let i = 0; i < circles.cols; ++i) {
                    const x = circles.data32F[i * 3];
                    const y = circles.data32F[i * 3 + 1];
                    const r = circles.data32F[i * 3 + 2];
                    list.push({ x, y, r });
                }
                
                const groups = [];
                list.forEach(c => {
                    let foundGroup = false;
                    for (let g of groups) {
                        const dist = Math.sqrt((c.x - g.cx) ** 2 + (c.y - g.cy) ** 2);
                        if (dist < 20) {
                            g.circles.push(c);
                            g.cx = g.circles.reduce((sum, ci) => sum + ci.x, 0) / g.circles.length;
                            g.cy = g.circles.reduce((sum, ci) => sum + ci.y, 0) / g.circles.length;
                            if (c.r > g.maxR) g.maxR = c.r;
                            foundGroup = true;
                            break;
                        }
                    }
                    if (!foundGroup) {
                        groups.push({
                            cx: c.x,
                            cy: c.y,
                            maxR: c.r,
                            circles: [c]
                        });
                    }
                });
                
                groups.sort((a, b) => b.circles.length - a.circles.length);
                
                if (groups.length > 0 && groups[0].circles.length >= 2) {
                    const best = groups[0];
                    return { cx: best.cx, cy: best.cy, r: best.maxR };
                }
                
                if (list.length > 0) {
                    const imgCx = mat.cols / 2;
                    const imgCy = mat.rows / 2;
                    list.sort((a, b) => {
                        const distA = Math.sqrt((a.x - imgCx)**2 + (a.y - imgCy)**2);
                        const distB = Math.sqrt((b.x - imgCx)**2 + (b.y - imgCy)**2);
                        return distA - distB;
                    });
                    return { cx: list[0].x, cy: list[0].y, r: list[0].r };
                }
            }
        } catch (err) {
            console.warn("HoughCircles target detection failed:", err);
        } finally {
            gray.delete();
            blurred.delete();
            circles.delete();
        }
        return null;
    }

    async detectTargetConcentricCircles(mat) {
        // =============================================================
        // PRIORITY 1: Contour quad detection (best for angled shots)
        // Finds the rectangular target paper boundary directly — this
        // naturally captures perspective distortion as a trapezoid.
        // =============================================================
        let quadCorners = this._detectTargetQuadContour(mat);
        if (quadCorners && quadCorners.length === 4) {
            // Check whether the quad is actually perspective-distorted (trapezoid)
            // or just a straight-on rectangle. For straight photos, the paper boundary
            // is a rectangle with all angles ≈ 90°. Using it would apply a non-square
            // proportional warp that distorts the circular target rings.
            const isTrapezoidal = this._isQuadTrapezoidal(quadCorners);
            if (isTrapezoidal) {
                console.log('[BoardDetect] Using QUAD detection (Priority 1) — angled/trapezoidal quad');
                return this.sortCornersClockwise(quadCorners);
            } else {
                console.log('[BoardDetect] Quad detected but near-rectangular (straight photo) — skipping to circle detection');
            }
        }

        // =============================================================
        // PRIORITY 2: Ellipse fitting from HSV yellow mask
        // If the target region is detected as an ellipse (aspect > 1.15),
        // compute 4 corners from the ellipse's oriented bounding box.
        // This handles cases where the paper boundary isn't visible but
        // the concentric rings form a visible ellipse.
        // =============================================================
        let target = this.detectTargetYellowCentroidAndRadius(mat);

        if (target && target.isElliptical && target.ellipse) {
            const e = target.ellipse;
            // Get the 4 corners of the rotated bounding rectangle of the ellipse
            const corners = this._ellipseToCorners(e);
            console.log('[BoardDetect] Using ELLIPSE detection (Priority 2)');
            return this.sortCornersClockwise(corners);
        }

        // =============================================================
        // PRIORITY 3: Circle-based detection (straight-on shots)
        // Yellow centroid circle or HoughCircles → square bounding box.
        // Only suitable for straight-on / near-straight shots.
        // =============================================================
        if (!target) {
            target = this.detectTargetClassical(mat);
        }

        if (target) {
            const { cx, cy, r } = target;
            const corners = [
                { x: cx - r, y: cy - r }, // Top-Left
                { x: cx + r, y: cy - r }, // Top-Right
                { x: cx + r, y: cy + r }, // Bottom-Right
                { x: cx - r, y: cy + r }  // Bottom-Left
            ];
            console.log('[BoardDetect] Using CIRCLE detection (Priority 3)');
            return corners;
        }

        console.warn('[BoardDetect] All auto-detection strategies failed, using default corners.');
        return [];
    }

    // Helper: Extract 4 corners from an OpenCV RotatedRect (ellipse result)
    _ellipseToCorners(ellipse) {
        const cx = ellipse.center.x;
        const cy = ellipse.center.y;
        const halfW = ellipse.size.width / 2;
        const halfH = ellipse.size.height / 2;
        const angleRad = (ellipse.angle * Math.PI) / 180;
        const cosA = Math.cos(angleRad);
        const sinA = Math.sin(angleRad);

        // 4 corners of the oriented bounding box
        const offsets = [
            { dx: -halfW, dy: -halfH }, // TL in local space
            { dx:  halfW, dy: -halfH }, // TR
            { dx:  halfW, dy:  halfH }, // BR
            { dx: -halfW, dy:  halfH }  // BL
        ];

        return offsets.map(({ dx, dy }) => ({
            x: cx + dx * cosA - dy * sinA,
            y: cy + dx * sinA + dy * cosA
        }));
    }

    // Helper: Contour-based quad (rectangle) detection
    _detectTargetQuadContour(mat) {
        let gray = new cv.Mat();
        let blurred = new cv.Mat();
        let enhanced = new cv.Mat();
        let thresh = new cv.Mat();
        let detectedCorners = [];

        try {
            cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY);

            // Apply CLAHE (Contrast-Limited Adaptive Histogram Equalization)
            // to improve edge detection on angled images with uneven lighting/shadows
            try {
                const clahe = new cv.CLAHE(2.0, new cv.Size(8, 8));
                clahe.apply(gray, enhanced);
                clahe.delete();
            } catch (claheErr) {
                // CLAHE may not be available in all OpenCV.js builds — fall back to raw gray
                console.warn('[QuadDetect] CLAHE not available, using raw grayscale:', claheErr.message);
                gray.copyTo(enhanced);
            }

            cv.GaussianBlur(enhanced, blurred, new cv.Size(7, 7), 0);
            cv.adaptiveThreshold(blurred, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 41, 11);

            let contours = new cv.MatVector();
            let hierarchy = new cv.Mat();
            cv.findContours(thresh, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);

            // Proportional minimum area: 5% of image area (handles different resolutions)
            const minAreaThreshold = mat.rows * mat.cols * 0.05;
            let maxArea = 0;

            // Multi-epsilon polygon approximation: try progressively looser epsilons
            // to handle angled images where contour curves prevent exact 4-vertex match
            const epsilons = [0.02, 0.03, 0.04, 0.05, 0.06];

            for (let i = 0; i < contours.size(); i++) {
                let contour = contours.get(i);
                let area = cv.contourArea(contour);

                if (area > minAreaThreshold && area > maxArea) {
                    let perimeter = cv.arcLength(contour, true);

                    for (const eps of epsilons) {
                        let approx = new cv.Mat();
                        cv.approxPolyDP(contour, approx, eps * perimeter, true);

                        if (approx.rows === 4) {
                            // Validate convexity — reject self-intersecting quads
                            const corners = [];
                            for (let j = 0; j < 4; j++) {
                                corners.push({
                                    x: approx.data32S[j * 2],
                                    y: approx.data32S[j * 2 + 1]
                                });
                            }

                            // Check convexity via cross products (all same sign)
                            let isConvex = true;
                            let sign = 0;
                            for (let j = 0; j < 4; j++) {
                                const p0 = corners[j];
                                const p1 = corners[(j + 1) % 4];
                                const p2 = corners[(j + 2) % 4];
                                const cross = (p1.x - p0.x) * (p2.y - p1.y) - (p1.y - p0.y) * (p2.x - p1.x);
                                if (sign === 0) sign = Math.sign(cross);
                                else if (Math.sign(cross) !== sign && Math.abs(cross) > 100) {
                                    isConvex = false;
                                    break;
                                }
                            }

                            // Validate minimum interior angles (reject degenerate quads)
                            let minAngle = 180;
                            for (let j = 0; j < 4; j++) {
                                const p0 = corners[j];
                                const p1 = corners[(j + 1) % 4];
                                const p2 = corners[(j + 2) % 4];
                                const v1 = { x: p0.x - p1.x, y: p0.y - p1.y };
                                const v2 = { x: p2.x - p1.x, y: p2.y - p1.y };
                                const dot = v1.x * v2.x + v1.y * v2.y;
                                const mag1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
                                const mag2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
                                if (mag1 > 0 && mag2 > 0) {
                                    const cosAngle = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
                                    const angle = Math.acos(cosAngle) * 180 / Math.PI;
                                    minAngle = Math.min(minAngle, angle);
                                }
                            }

                            if (isConvex && minAngle > 30) {
                                maxArea = area;
                                detectedCorners = corners;
                                console.log(`[QuadDetect] Found quad with eps=${eps}, area=${area.toFixed(0)}, minAngle=${minAngle.toFixed(1)}°`);
                                approx.delete();
                                break; // accept first valid epsilon
                            }
                        }
                        approx.delete();
                    }
                }
                contour.delete();
            }

            contours.delete();
            hierarchy.delete();
        } catch (err) {
            console.warn("Quad contour detection failed:", err);
        } finally {
            gray.delete();
            blurred.delete();
            enhanced.delete();
            thresh.delete();
        }

        return detectedCorners.length === 4 ? detectedCorners : null;
    }

    // Helper: Determine if a detected quad is perspective-distorted (trapezoid)
    // or a near-perfect rectangle (straight-on photo).
    // Returns true if any interior angle deviates more than 15° from 90°,
    // indicating genuine perspective distortion that warrants quad-based warping.
    _isQuadTrapezoidal(corners) {
        if (!corners || corners.length !== 4) return false;

        const angleTolerance = 15; // degrees of deviation from 90° allowed
        let maxDeviation = 0;

        for (let j = 0; j < 4; j++) {
            const p0 = corners[j];
            const p1 = corners[(j + 1) % 4];
            const p2 = corners[(j + 2) % 4];
            const v1 = { x: p0.x - p1.x, y: p0.y - p1.y };
            const v2 = { x: p2.x - p1.x, y: p2.y - p1.y };
            const dot = v1.x * v2.x + v1.y * v2.y;
            const mag1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
            const mag2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
            if (mag1 > 0 && mag2 > 0) {
                const cosAngle = Math.max(-1, Math.min(1, dot / (mag1 * mag2)));
                const angle = Math.acos(cosAngle) * 180 / Math.PI;
                const deviation = Math.abs(angle - 90);
                maxDeviation = Math.max(maxDeviation, deviation);
            }
        }

        const isTrapezoidal = maxDeviation > angleTolerance;
        console.log(`[QuadAngle] Max angle deviation from 90°: ${maxDeviation.toFixed(1)}° → ${isTrapezoidal ? 'TRAPEZOIDAL (angled)' : 'RECTANGULAR (straight)'}`);
        return isTrapezoidal;
    }

    sortCornersClockwise(pts) {
        // Sort by y-coordinate
        const sortedY = [...pts].sort((a, b) => a.y - b.y);
        const top = [sortedY[0], sortedY[1]].sort((a, b) => a.x - b.x);
        const bottom = [sortedY[2], sortedY[3]].sort((a, b) => b.x - a.x); // clockwise bottom-right first then bottom-left
        return [top[0], top[1], bottom[0], bottom[1]]; // TL, TR, BR, BL
    }

    async applyWarpAndImpactDetection() {
        if (!this.originalImage || !this.originalMat) return;

        let cvStartTime = performance.now();

        // 1. Get perspective coordinates
        const pins = this.currentSession.calibration.cornerPoints;
        
        // Scale pin locations down to resized original Mat coordinate space
        const srcPtsData = [];
        pins.forEach(pin => {
            srcPtsData.push(pin.x / this.scaleX);
            srcPtsData.push(pin.y / this.scaleY);
        });

        const dstPtsData = this.computeProportionalDstPoints(pins);

        let srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, srcPtsData);
        let dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, dstPtsData);

        let M = cv.getPerspectiveTransform(srcPts, dstPts);
        
        if (this.warpedMat) this.warpedMat.delete();
        this.warpedMat = new cv.Mat();
        this.cachedBlackRadius = null;
        this.currentSession.detectedRingRadii = null;
        this.currentSession.detectedTargetCenter = null;
        this.currentSession._calibratedPixelsPerMm = null; // FIX: invalidate ring-scale cache
        
        cv.warpPerspective(this.originalMat, this.warpedMat, M, new cv.Size(900, 900));

        srcPts.delete();
        dstPts.delete();
        M.delete();

        // Save warped image as base64 for history caching
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = 900;
        tempCanvas.height = 900;
        cv.imshow(tempCanvas, this.warpedMat);
        this.currentSession.warpedImageBase64 = tempCanvas.toDataURL();

        // 2. Project original holes using the new perspective transform and score them
        await this.projectOriginalHolesToWarped();

        // 3. Compute advanced statistical indices
        this.calculateAdvancedStats();

        // Update benchmarks
        this.perf.opencvTime += (performance.now() - cvStartTime);
        this.perf.renderTime = 0; // calculated during rendering
        this.perf.detectedCount = this.currentSession.shots.length;

        // Recalculate and display confidence ratings
        this.calculateConfidenceScores();
        
        const previewCheckbox = document.getElementById('manual-warp-preview');
        const showWarped = previewCheckbox ? previewCheckbox.checked : false;
        
        if (this.isWarpModeActive && !showWarped) {
            this.renderCalibrationCanvas();
            this.showCornerPinsOverlay();
        } else {
            this.renderWarpedCanvas();
        }
        
        this.updateStatsUI();
        this.renderShotsTableUI();
        this.renderPerformanceUI();
    }

    runOpenCVDetection() {
        if (!this.originalMat || this.originalMat.empty()) return;

        let gray = new cv.Mat();
        let blurred = new cv.Mat();
        
        cv.cvtColor(this.originalMat, gray, cv.COLOR_RGBA2GRAY);
        cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

        // Retrieve UI settings
        const sensitivityEl = document.getElementById('analyzer-sensitivity');
        const sensitivity = sensitivityEl ? parseInt(sensitivityEl.value) : 50;
        
        const threshEl = document.getElementById('analyzer-threshold');
        const threshVal = threshEl ? parseInt(threshEl.value) : 35;
        
        const circEl = document.getElementById('analyzer-circularity');
        const minCircularity = circEl ? parseFloat(circEl.value) : 0.60;
        const template = this.getTargetTemplateDetails(this.currentSession.targetType);
        
        const pixelsPerMmFormula = 400.0 / template.outerRadiusMm;
        // Only set provisional value — ring-calibration in calculateAnalyticScore will refine this
        if (!this.currentSession._calibratedPixelsPerMm) {
            this.currentSession.calibration.pixelsPerMm = pixelsPerMmFormula;
        }
        const pixelsPerMm = this.currentSession.calibration.pixelsPerMm;

        // Dynamic thresholds based on sensitivity
        const minArea = Math.max(4, Math.round(20 - (sensitivity * 0.16))); // 1 -> 20px, 100 -> 4px
        const maxArea = Math.round(1500 + (sensitivity * 15)); // 1 -> 1515px, 100 -> 3000px
        
        // Low and high limits for Canny edge detector
        const cannyThreshLow = Math.max(10, Math.round(120 - (sensitivity * 1.0)));
        const cannyThreshHigh = cannyThreshLow * 2;

        let blockSize = Math.round(pixelsPerMm * 15);
        if (blockSize % 2 === 0) blockSize += 1;
        blockSize = Math.max(25, Math.min(101, blockSize));

        // Dual Pass Thresholding
        // Pass 1: standard/light background
        let binary1 = new cv.Mat();
        cv.adaptiveThreshold(blurred, binary1, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, blockSize, threshVal);

        // Pass 2: dark background / inner rings
        let binary2 = new cv.Mat();
        let blockSize2 = Math.round(pixelsPerMm * 8);
        if (blockSize2 % 2 === 0) blockSize2 += 1;
        blockSize2 = Math.max(15, Math.min(65, blockSize2));
        const threshVal2 = Math.max(2, Math.round(threshVal * 0.3)); // smaller offset
        cv.adaptiveThreshold(blurred, binary2, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, blockSize2, threshVal2);

        // Clean up binary masks
        let M_kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
        cv.morphologyEx(binary1, binary1, cv.MORPH_CLOSE, M_kernel);
        cv.morphologyEx(binary1, binary1, cv.MORPH_OPEN, M_kernel);
        cv.morphologyEx(binary2, binary2, cv.MORPH_CLOSE, M_kernel);
        cv.morphologyEx(binary2, binary2, cv.MORPH_OPEN, M_kernel);

        // Save combined binary mask for Threshold Debug View
        if (this.debugThresholdMat) this.debugThresholdMat.delete();
        this.debugThresholdMat = new cv.Mat();
        cv.bitwise_or(binary1, binary2, this.debugThresholdMat);

        // Pass 3: Canny Edge detection
        let edges = new cv.Mat();
        cv.Canny(blurred, edges, cannyThreshLow, cannyThreshHigh, 3, false);
        
        if (this.debugEdgeMat) this.debugEdgeMat.delete();
        this.debugEdgeMat = edges.clone();

        // Dilate edges to close contours for extraction
        let dilatedEdges = new cv.Mat();
        cv.dilate(edges, dilatedEdges, M_kernel);
        M_kernel.delete();

        const candidates = [];

        const extractCandidatesFromMat = (binaryMat, sourcePass) => {
            let contours = new cv.MatVector();
            let hierarchy = new cv.Mat();
            cv.findContours(binaryMat, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
            
            for (let i = 0; i < contours.size(); i++) {
                let contour = contours.get(i);
                let area = cv.contourArea(contour);
                
                let rect = cv.boundingRect(contour);
                let aspect = rect.height > 0 ? (rect.width / rect.height) : 0;
                
                let perimeter = cv.arcLength(contour, true);
                let circularity = perimeter > 0 ? ((4 * Math.PI * area) / (perimeter * perimeter)) : 0;
                
                let solidity = 1.0;
                let hullArea = 0;
                try {
                    let hull = new cv.Mat();
                    cv.convexHull(contour, hull, false, true);
                    hullArea = cv.contourArea(hull);
                    solidity = hullArea > 0 ? (area / hullArea) : 0;
                    hull.delete();
                } catch (hullErr) {}
                
                let moments = cv.moments(contour);
                let cx = 0, cy = 0;
                if (moments.m00 !== 0) {
                    cx = moments.m10 / moments.m00;
                    cy = moments.m01 / moments.m00;
                }
                
                let aspectScore = aspect <= 1.0 ? aspect : (1.0 / aspect);
                let candidateConfidence = Math.min(100, Math.round(
                    (circularity * 0.4 + aspectScore * 0.4 + solidity * 0.2) * 100
                ));
                
                let accepted = true;
                let rejectedReason = "";
                
                if (area < minArea || area > maxArea) {
                    accepted = false;
                    rejectedReason = "area";
                } else if (circularity < minCircularity) {
                    accepted = false;
                    rejectedReason = "circularity";
                } else if (aspect < 0.60 || aspect > 1.67) {
                    // Tighter aspect ratio: printed numbers like '1' are very tall/narrow.
                    // A genuine bullet hole is roughly circular (aspect close to 1.0).
                    accepted = false;
                    rejectedReason = "aspect";
                } else if (solidity < 0.65) {
                    accepted = false;
                    rejectedReason = "solidity";
                }
                
                if (cx < 10 || cx > this.resizedWidth - 10 || cy < 10 || cy > this.resizedHeight - 10) {
                    accepted = false;
                    rejectedReason = "border";
                }
                
                candidates.push({
                    x: cx,
                    y: cy,
                    radius: Math.round(Math.sqrt(area / Math.PI)),
                    area: area,
                    circularity: circularity,
                    solidity: solidity,
                    aspect: aspect,
                    confidence: candidateConfidence,
                    accepted: accepted,
                    rejectedReason: rejectedReason,
                    source: sourcePass
                });
                
                contour.delete();
            }
            contours.delete();
            hierarchy.delete();
        };

        // Extract from all three passes
        extractCandidatesFromMat(binary1, "Pass 1");
        extractCandidatesFromMat(binary2, "Pass 2");
        extractCandidatesFromMat(dilatedEdges, "Canny Pass");

        // Non-Maximum Suppression
        candidates.sort((a, b) => {
            if (a.accepted && !b.accepted) return -1;
            if (!a.accepted && b.accepted) return 1;
            return b.confidence - a.confidence;
        });

        const finalCandidates = [];
        candidates.forEach(candidate => {
            const isDuplicate = finalCandidates.some(selected => {
                const dist = Math.sqrt((candidate.x - selected.x) ** 2 + (candidate.y - selected.y) ** 2);
                const overlapLimit = Math.max(12, candidate.radius + selected.radius + 2);
                return dist < overlapLimit;
            });
            
            if (!isDuplicate) {
                finalCandidates.push(candidate);
            }
        });

        this.detectedHoles = finalCandidates;

        // Cleanup local mats
        gray.delete();
        blurred.delete();
        binary1.delete();
        binary2.delete();
        edges.delete();
        dilatedEdges.delete();
    }

    async detectImpactShots() {
        if (!this.originalMat || this.originalMat.empty()) return;

        const engine = document.getElementById('detection-engine')?.value || 'hybrid';
        
        this.perf.preprocessTime = 0;
        this.perf.yoloTime = 0;

        this.yoloDetections = [];
        this.yoloWarpedDetections = [];

        // Preserve manually added holes across re-analysis
        const existingManualShots = (this.currentSession.shots || []).filter(shot => shot.type === 'Manual Entry');


        if (engine === 'opencv') {
            this.runOpenCVDetection();
            await this.projectOriginalHolesToWarped();
        } else if (engine === 'yolov11m') {
            if (this.yoloModelReady) {
                const canvas = document.createElement('canvas');
                canvas.width = this.resizedWidth;
                canvas.height = this.resizedHeight;
                cv.imshow(canvas, this.originalMat);
                this.yoloDetections = await this.runYOLODetection(canvas);
            } else {
                this.runOpenCVDetection();
            }
            await this.projectOriginalHolesToWarped();
        } else if (engine === 'hybrid') {
            if (this.yoloModelReady) {
                const canvas = document.createElement('canvas');
                canvas.width = this.resizedWidth;
                canvas.height = this.resizedHeight;
                cv.imshow(canvas, this.originalMat);
                this.yoloDetections = await this.runYOLODetection(canvas);
            }
            this.runOpenCVDetection();
            await this.projectOriginalHolesToWarped();
        }

        // Restore manually added holes and re-sort
        if (existingManualShots.length > 0) {
            this.currentSession.shots = [...this.currentSession.shots, ...existingManualShots];
            this.currentSession.shots.sort((a, b) => b.score - a.score);
        }
    }

    projectPoint(x, y, M) {
        if (!M || M.empty()) return { x: x, y: y };
        const data = M.data64F;
        const w = data[6] * x + data[7] * y + data[8];
        if (Math.abs(w) < 0.0001) return { x: x, y: y };
        return {
            x: (data[0] * x + data[1] * y + data[2]) / w,
            y: (data[3] * x + data[4] * y + data[5]) / w
        };
    }

    detectArrowTip(det, warpedMat) {
        if (!warpedMat || warpedMat.empty()) return { xc: det.xc, yc: det.yc };
        
        const x1 = Math.max(0, Math.floor(det.x1));
        const y1 = Math.max(0, Math.floor(det.y1));
        const x2 = Math.min(warpedMat.cols - 1, Math.ceil(det.x2));
        const y2 = Math.min(warpedMat.rows - 1, Math.ceil(det.y2));
        
        const w = x2 - x1;
        const h = y2 - y1;
        if (w <= 2 || h <= 2) return { xc: det.xc, yc: det.yc };

        let rect = new cv.Rect(x1, y1, w, h);
        let roi = warpedMat.roi(rect);
        
        let gray = new cv.Mat();
        let blurred = new cv.Mat();
        let thresh = new cv.Mat();
        
        try {
            cv.cvtColor(roi, gray, cv.COLOR_RGBA2GRAY);
            cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0);
            cv.adaptiveThreshold(blurred, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 11, 2);
            
            let contours = new cv.MatVector();
            let hierarchy = new cv.Mat();
            cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
            
            let maxArea = 0;
            let bestContour = null;
            for (let i = 0; i < contours.size(); i++) {
                let contour = contours.get(i);
                let area = cv.contourArea(contour);
                if (area > maxArea) {
                    maxArea = area;
                    if (bestContour) bestContour.delete();
                    bestContour = contour.clone();
                }
                contour.delete();
            }
            
            let tipX = det.xc;
            let tipY = det.yc;
            
            if (bestContour && maxArea > 10) {
                let minDist = 999999;
                const sc = (this.currentSession.detectedTargetCenter &&
                            this.currentSession.detectedTargetCenter.valid)
                    ? this.currentSession.detectedTargetCenter
                    : { x: 250, y: 250 };
                const center900 = { x: sc.x * 1.8, y: sc.y * 1.8 };
                const data = bestContour.data32S;
                for (let i = 0; i < data.length; i += 2) {
                    const pxLocal = data[i];
                    const pyLocal = data[i+1];
                    const pxGlobal = x1 + pxLocal;
                    const pyGlobal = y1 + pyLocal;
                    
                    const dist = Math.sqrt((pxGlobal - center900.x)**2 + (pyGlobal - center900.y)**2);
                    if (dist < minDist) {
                        minDist = dist;
                        tipX = pxGlobal;
                        tipY = pyGlobal;
                    }
                }
            }
            
            if (bestContour) bestContour.delete();
            contours.delete();
            hierarchy.delete();
            
            return { xc: tipX, yc: tipY };
        } catch (err) {
            console.warn("Arrow tip extraction contour fitting error:", err);
            return { xc: det.xc, yc: det.yc };
        } finally {
            gray.delete();
            blurred.delete();
            thresh.delete();
            roi.delete();
        }
    }

    runOpenCVFallbackProjection(detectedShots) {
        const M = this.getWarpPerspectiveMatrix();
        const template = this.getTargetTemplateDetails(this.currentSession.targetType);
        // Only set provisional pixelsPerMm if ring-calibration hasn't run yet
        if (!this.currentSession.calibration.pixelsPerMm) {
            this.currentSession.calibration.pixelsPerMm = 250.0 / template.outerRadiusMm;
        }

        if (!M || M.empty()) {
            const scale = 500 / this.resizedWidth;
            const accepted = this.detectedHoles ? this.detectedHoles.filter(h => h.accepted) : [];
            accepted.forEach(hole => {
                const cx = hole.x * scale;
                const cy = hole.y * scale;
                const noMCenter = (this.currentSession.detectedTargetCenter &&
                                   this.currentSession.detectedTargetCenter.valid)
                    ? this.currentSession.detectedTargetCenter
                    : { x: 250, y: 250 };
                const distPx = Math.sqrt((cx - noMCenter.x) ** 2 + (cy - noMCenter.y) ** 2);
                const distReal = distPx / this.currentSession.calibration.pixelsPerMm;
                const scoreObj = this.calculateAnalyticScore(cx, cy);
                const diameterMm = (Math.sqrt(hole.area / Math.PI) * 2) / this.currentSession.calibration.pixelsPerMm;
                const projectileType = this.getProjectileTypeByDiameter(diameterMm);
                detectedShots.push({
                    id: `shot-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                    x: Math.round(cx),
                    y: Math.round(cy),
                    radius: Math.round(hole.radius * scale),
                    area: Math.round(hole.area * scale * scale),
                    distancePx: distPx,
                    distanceReal: distReal,
                    score: scoreObj.score,
                    type: projectileType,
                    confidence: hole.confidence,
                    origX: hole.x,
                    origY: hole.y,
                    projX: cx * 1.8,
                    projY: cy * 1.8
                });
            });
            if (M) M.delete();
            return;
        }

        const accepted = this.detectedHoles ? this.detectedHoles.filter(h => h.accepted) : [];
        accepted.forEach(hole => {
            const proj = this.projectPoint(hole.x, hole.y, M);
            const cx = proj.x / 1.8;
            const cy = proj.y / 1.8;

            if (cx > 5 && cx < 495 && cy > 5 && cy < 495) {
                const cvCenter = (this.currentSession.detectedTargetCenter &&
                                  this.currentSession.detectedTargetCenter.valid)
                    ? this.currentSession.detectedTargetCenter
                    : { x: 250, y: 250 };
                const distPx = Math.sqrt((cx - cvCenter.x) ** 2 + (cy - cvCenter.y) ** 2);
                if (distPx <= 250) {
                    const distReal = distPx / this.currentSession.calibration.pixelsPerMm;
                    const scoreObj = this.calculateAnalyticScore(cx, cy);
                    const diameterMm = (Math.sqrt(hole.area / Math.PI) * 2) / this.currentSession.calibration.pixelsPerMm;
                    const projectileType = this.getProjectileTypeByDiameter(diameterMm);

                    detectedShots.push({
                        id: `shot-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                        x: Math.round(cx),
                        y: Math.round(cy),
                        radius: Math.round(hole.radius * (500 / this.resizedWidth)),
                        area: Math.round(hole.area * (500 / this.resizedWidth) * (500 / this.resizedWidth)),
                        distancePx: distPx,
                        distanceReal: distReal,
                        score: scoreObj.score,
                        type: projectileType,
                        confidence: hole.confidence,
                        origX: hole.x,
                        origY: hole.y,
                        projX: proj.x,
                        projY: proj.y
                    });
                }
            }
        });
        M.delete();
    }
    validateYOLODetectionPatch(det, originalMat) {
        if (!originalMat || originalMat.empty()) return true;

        const cols = originalMat.cols;
        const rows = originalMat.rows;

        // Ensure bounding box coordinates are within bounds
        const x1 = Math.max(0, Math.min(cols - 1, Math.round(det.x1)));
        const y1 = Math.max(0, Math.min(rows - 1, Math.round(det.y1)));
        const x2 = Math.max(0, Math.min(cols - 1, Math.round(det.x2)));
        const y2 = Math.max(0, Math.min(rows - 1, Math.round(det.y2)));

        const w = x2 - x1;
        const h = y2 - y1;
        if (w < 4 || h < 4) return false;

        let gray = new cv.Mat();
        let roi = null;
        try {
            cv.cvtColor(originalMat, gray, cv.COLOR_RGBA2GRAY);
            let rect = new cv.Rect(x1, y1, w, h);
            let tempRoi = gray.roi(rect);
            roi = tempRoi.clone(); // Cloned ROI is contiguous in memory
            tempRoi.delete();

            let minMax = cv.minMaxLoc(roi);
            const minVal = minMax.minVal;
            const maxVal = minMax.maxVal;

            // Calculate border mean brightness
            let borderSum = 0;
            let borderCount = 0;
            const data = roi.data;
            for (let col = 0; col < w; col++) {
                borderSum += data[col]; // top row
                borderSum += data[(h - 1) * w + col]; // bottom row
                borderCount += 2;
            }
            for (let row = 1; row < h - 1; row++) {
                borderSum += data[row * w]; // left col
                borderSum += data[row * w + (w - 1)]; // right col
                borderCount += 2;
            }
            const borderMean = borderSum / borderCount;

            console.log(`[PatchValidation] box=[${x1},${y1},${x2},${y2}] borderMean=${borderMean.toFixed(1)} minVal=${minVal} maxVal=${maxVal}`);

            // Compute center 40% area mean brightness (used in both dark and light area checks)
            const cx_start = Math.round(w * 0.3);
            const cx_end = Math.round(w * 0.7);
            const cy_start = Math.round(h * 0.3);
            const cy_end = Math.round(h * 0.7);

            let centerSum = 0;
            let centerCount = 0;
            for (let r = cy_start; r < cy_end; r++) {
                for (let c = cx_start; c < cx_end; c++) {
                    centerSum += data[r * w + c];
                    centerCount++;
                }
            }
            const centerMean = centerCount > 0 ? centerSum / centerCount : borderMean;

            // Case 1: Dark background (e.g. black rings 7-10)
            if (borderMean < 90) {
                // White printed digits (like '8', '9') on dark backgrounds have bright maxVal
                // but their center pixels follow the surrounding bright ink — not a deep dark hole.
                // A real bullet hole punches through and looks uniformly dark even in center.
                if (maxVal > 160 && centerMean > borderMean * 0.85) {
                    console.log(`[PatchValidation] Rejected in dark area: maxVal=${maxVal} and centerMean=${centerMean.toFixed(1)} not dark vs borderMean=${borderMean.toFixed(1)} (likely white printed digit)`);
                    return false;
                }
            }

            // Case 2: Light background (e.g. white/beige rings 1-6)
            if (borderMean >= 90) {
                // A real hole must have some dark pixels compared to background
                if (minVal > borderMean - 25) {
                    console.log(`[PatchValidation] Rejected detection in light area: minVal=${minVal} > borderMean-25=${(borderMean - 25).toFixed(1)} (not dark enough)`);
                    return false;
                }

                // Center should be dark — printed digit loops ('0', '6', '8', '9') have a
                // light interior matching the paper background, unlike real holes which are dark.
                if (centerMean > borderMean * 0.85) {
                    console.log(`[PatchValidation] Rejected detection in light area: centerMean=${centerMean.toFixed(1)} vs borderMean=${borderMean.toFixed(1)} (center not dark enough, likely printed digit/text loop)`);
                    return false;
                }
            }

            return true;
        } catch (err) {
            console.warn("[PatchValidation] Error validating patch, defaulting to true:", err);
            return true;
        } finally {
            if (roi) roi.delete();
            gray.delete();
        }
    }

    debugYOLOPipeline(detections, engine, M) {
        if (!detections) detections = [];
        console.log("YOLO detections:", detections);
        console.log("Before validation:", detections.length);

        // 1. Accepted-hole validation
        const afterAccepted = [];
        for (const det of detections) {
            const name = (det.className || "").toLowerCase();
            const isValid = name === 'hole' || name === 'hit' || name === 'bullet-holes';
            if (isValid) {
                if (this.validateYOLODetectionPatch(det, this.originalMat)) {
                    afterAccepted.push(det);
                } else {
                    console.log(`[PatchValidation] Filtered out false positive YOLO detection at center=(${det.xc.toFixed(1)}, ${det.yc.toFixed(1)})`);
                }
            } else {
                console.log(`Rejected hole:\ncenter=(${det.xc.toFixed(1)}, ${det.yc.toFixed(1)})\nconfidence=${(det.confidence * 100).toFixed(0)}%\nreason=validation failed`);
            }
        }
        console.log("After accepted-hole validation:\ncount=" + afterAccepted.length);

        // 2. Calibration transform
        const afterCalibration = [];
        for (const det of afterAccepted) {
            let cx, cy;
            let projX, projY;
            let origX, origY;
            origX = det.xc;
            origY = det.yc;
            if (M && !M.empty()) {
                const proj = this.projectPoint(det.xc, det.yc, M);
                projX = proj.x;
                projY = proj.y;
                cx = proj.x / 1.8;
                cy = proj.y / 1.8;
            } else {
                const scale = 500 / this.resizedWidth;
                projX = det.xc * 1.8 * scale;
                projY = det.yc * 1.8 * scale;
                cx = det.xc * scale;
                cy = det.yc * scale;
            }
            afterCalibration.push({ det, cx, cy, origX, origY, projX, projY });
        }
        console.log("After calibration transform:\ncount=" + afterCalibration.length);

        // 3. ROI filter (Removed - trust YOLO detections anywhere on image)
        const afterROI = afterCalibration;
        console.log("After ROI filter:\ncount=" + afterROI.length);

        // 4. Scoring (including duplicate detection)
        // FIX 5: For archery targets, use arrow tip (closest point to centre)
        //        instead of bbox centre so scoring reflects the entry point.
        const afterScoring = [];
        for (let item of afterROI) {
            let { det, cx, cy, origX, origY, projX, projY } = item;
            if (this.currentSession.targetType === 'archery-10ring' &&
                this.warpedMat && !this.warpedMat.empty()) {
                // Build a correct detection object in warped 900-space by projecting original bounding box corners
                let det900;
                if (M && !M.empty()) {
                    const p1 = this.projectPoint(det.x1, det.y1, M);
                    const p2 = this.projectPoint(det.x2, det.y2, M);
                    det900 = {
                        xc: projX,
                        yc: projY,
                        x1: Math.min(p1.x, p2.x),
                        y1: Math.min(p1.y, p2.y),
                        x2: Math.max(p1.x, p2.x),
                        y2: Math.max(p1.y, p2.y)
                    };
                } else {
                    const scale = 900 / this.resizedWidth;
                    det900 = {
                        xc: det.xc * scale,
                        yc: det.yc * scale,
                        x1: det.x1 * scale,
                        y1: det.y1 * scale,
                        x2: det.x2 * scale,
                        y2: det.y2 * scale
                    };
                }
                const tip = this.detectArrowTip(det900, this.warpedMat);
                if (tip && (Math.abs(tip.xc - det900.xc) > 2 || Math.abs(tip.yc - det900.yc) > 2)) {
                    cx = tip.xc / 1.8;
                    cy = tip.yc / 1.8;
                }
            }
            const center = (this.currentSession.detectedTargetCenter &&
                            this.currentSession.detectedTargetCenter.valid)
                ? this.currentSession.detectedTargetCenter
                : { x: 250, y: 250 };
            const distPx = Math.sqrt((cx - center.x) ** 2 + (cy - center.y) ** 2);
            const distReal = distPx / this.currentSession.calibration.pixelsPerMm;
            const scoreObj = this.calculateAnalyticScore(cx, cy);
            
            let diameterPx = ((det.w + det.h) / 2) * (500 / this.resizedWidth);
            const diameterMm = diameterPx / this.currentSession.calibration.pixelsPerMm;
            const projectileType = this.getProjectileTypeByDiameter(diameterMm, det.classId);

            const isDuplicate = afterScoring.some(selected => {
                const dist = Math.sqrt((cx - selected.x) ** 2 + (cy - selected.y) ** 2);
                return dist < 5;
            });

            if (isDuplicate) {
                console.log(`Rejected hole:\ncenter=(${cx.toFixed(1)}, ${cy.toFixed(1)})\nconfidence=${(det.confidence * 100).toFixed(0)}%\nreason=duplicate`);
                continue;
            }

            afterScoring.push({
                id: `shot-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                x: Math.round(cx),
                y: Math.round(cy),
                radius: Math.round(diameterPx / 2),
                area: Math.round(Math.PI * (diameterPx / 2) ** 2),
                distancePx: distPx,
                distanceReal: distReal,
                score: scoreObj.score,
                type: projectileType,
                confidence: Math.round(det.confidence * 100),
                classId: det.classId,
                origX,
                origY,
                projX,
                projY
            });
        }
        console.log("After scoring:\ncount=" + afterScoring.length);
        console.log("this.currentSession.shots.length:", afterScoring.length);

        return afterScoring;
    }

    async projectOriginalHolesToWarped() {
        const engine = document.getElementById('detection-engine')?.value || 'hybrid';
        const detectedShots = [];
        const M = this.getWarpPerspectiveMatrix();
        const template = this.getTargetTemplateDetails(this.currentSession.targetType);

        // Pre-detect target center to ensure consistent reference for warp quality checks, tip detection, and scoring
        if (!this.currentSession.detectedTargetCenter ||
            (!this.currentSession.detectedTargetCenter._manuallySet &&
             !this.currentSession.detectedTargetCenter._autoDetected)) {
            const autoCenter = this.detectCenterMultiStrategy();
            this.currentSession.detectedTargetCenter = { ...autoCenter };
        }

        // NOTE: pixelsPerMm is now managed by calculateAnalyticScore via
        // calibratePixelsPerMmFromRings() — do NOT overwrite with the formula here.
        // We set a provisional value only so stats don't blow up before first score call.
        if (!this.currentSession.calibration.pixelsPerMm) {
            this.currentSession.calibration.pixelsPerMm = 250.0 / template.outerRadiusMm;
        }

        // FIX 4: Validate warp quality and show a warning badge if distorted
        // If warp is poor, attempt auto-fix using quad/ellipse fallback corners
        if (this.warpedMat && !this.warpedMat.empty()) {
            const warpCheck = this.validateWarpQuality(template);
            if (!warpCheck.valid) {
                console.warn('[WarpQuality] Initial warp failed:', warpCheck.reason);

                // AUTO-FIX: Try alternative detection strategies
                let autoFixed = false;
                const origCorners = [...this.currentSession.calibration.cornerPoints];

                // Try quad contour detection as fallback
                const quadCorners = this._detectTargetQuadContour(this.originalMat);
                if (quadCorners && quadCorners.length === 4) {
                    const sorted = this.sortCornersClockwise(quadCorners);
                    const scaledCorners = sorted.map(pt => ({
                        x: Math.round(pt.x * this.scaleX),
                        y: Math.round(pt.y * this.scaleY)
                    }));
                    this.currentSession.calibration.cornerPoints = scaledCorners;

                    // Re-warp with new corners
                    const srcPtsData2 = [];
                    scaledCorners.forEach(pin => {
                        srcPtsData2.push(pin.x / this.scaleX);
                        srcPtsData2.push(pin.y / this.scaleY);
                    });
                    let srcPts2 = cv.matFromArray(4, 1, cv.CV_32FC2, srcPtsData2);
                    let dstPts2 = cv.matFromArray(4, 1, cv.CV_32FC2, this.computeProportionalDstPoints(scaledCorners));
                    let M2 = cv.getPerspectiveTransform(srcPts2, dstPts2);
                    if (this.warpedMat) this.warpedMat.delete();
                    this.warpedMat = new cv.Mat();
                    this.cachedBlackRadius = null;
                    this.currentSession.detectedRingRadii = null;
                    this.currentSession._calibratedPixelsPerMm = null;
                    cv.warpPerspective(this.originalMat, this.warpedMat, M2, new cv.Size(900, 900));
                    srcPts2.delete(); dstPts2.delete(); M2.delete();

                    const recheck = this.validateWarpQuality(template);
                    if (recheck.valid) {
                        autoFixed = true;
                        console.log('[WarpQuality] Auto-fixed using QUAD contour corners.');
                    } else {
                        // Revert to original corners if quad didn't help either
                        this.currentSession.calibration.cornerPoints = origCorners;
                        
                        // Revert warpedMat to original warp as well
                        const srcPtsDataRevert = [];
                        origCorners.forEach(pin => {
                            srcPtsDataRevert.push(pin.x / this.scaleX);
                            srcPtsDataRevert.push(pin.y / this.scaleY);
                        });
                        let srcPtsR = cv.matFromArray(4, 1, cv.CV_32FC2, srcPtsDataRevert);
                        let dstPtsR = cv.matFromArray(4, 1, cv.CV_32FC2, this.computeProportionalDstPoints(origCorners));
                        let MR = cv.getPerspectiveTransform(srcPtsR, dstPtsR);
                        if (this.warpedMat) this.warpedMat.delete();
                        this.warpedMat = new cv.Mat();
                        cv.warpPerspective(this.originalMat, this.warpedMat, MR, new cv.Size(900, 900));
                        srcPtsR.delete(); dstPtsR.delete(); MR.delete();
                    }
                    
                    // Update the cached base64 image to reflect the final warp state (either fixed or reverted)
                    if (this.warpedMat && !this.warpedMat.empty()) {
                        const tempCanvas = document.createElement('canvas');
                        tempCanvas.width = 900;
                        tempCanvas.height = 900;
                        cv.imshow(tempCanvas, this.warpedMat);
                        this.currentSession.warpedImageBase64 = tempCanvas.toDataURL();
                    }
                }

                // Show warning if auto-fix also failed
                if (!autoFixed) {
                    const statusBadge = document.getElementById('analyzer-canvas-badge');
                    const statusText  = document.getElementById('analyzer-status-badge-text');
                    if (statusBadge && statusText) {
                        statusText.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Warp Warning: ${warpCheck.reason} ` +
                            `<br><small>💡 Tip: Use "Adjust Calibration Corners" to manually position the 4 corner pins on the target edges.</small>`;
                        statusBadge.className = 'canvas-status-floating status-warning';
                        statusBadge.style.display = 'block';
                    }
                    console.warn('[WarpQuality] Auto-fix failed. User should manually adjust corner pins.');
                }
            }
        }

        if (engine === 'opencv') {
            this.runOpenCVFallbackProjection(detectedShots);
            
            const uniqueShots = [];
            detectedShots.forEach(shot => {
                const isDuplicate = uniqueShots.some(selected => {
                    const dist = Math.sqrt((shot.x - selected.x) ** 2 + (shot.y - selected.y) ** 2);
                    return dist < 5;
                });
                if (!isDuplicate) {
                    uniqueShots.push(shot);
                }
            });

            uniqueShots.sort((a, b) => b.score - a.score);
            this.currentSession.shots = uniqueShots;
            if (M) M.delete();
            
        } else if (engine === 'yolov11m') {
            if (!M || M.empty()) {
                const finalShots = this.debugYOLOPipeline(this.yoloDetections, engine, null);
                this.currentSession.shots = finalShots;
                if (M) M.delete();
                return;
            }

            const finalShots = this.debugYOLOPipeline(this.yoloDetections, engine, M);
            this.currentSession.shots = finalShots;
            M.delete();

        } else if (engine === 'hybrid') {
            if (this.yoloModelReady) {
                const finalShots = this.debugYOLOPipeline(this.yoloDetections, engine, M);
                this.currentSession.shots = finalShots;
            } else {
                console.log("YOLO engine was not ready. Running OpenCV fallback detection...");
                detectedShots.length = 0; // Clear any partial detections
                this.runOpenCVFallbackProjection(detectedShots);
                
                const uniqueShots = [];
                detectedShots.forEach(shot => {
                    const isDuplicate = uniqueShots.some(selected => {
                        const dist = Math.sqrt((shot.x - selected.x) ** 2 + (shot.y - selected.y) ** 2);
                        return dist < 5;
                    });
                    if (!isDuplicate) {
                        uniqueShots.push(shot);
                    }
                });

                uniqueShots.sort((a, b) => b.score - a.score);
                this.currentSession.shots = uniqueShots;
            }
            if (M) M.delete();
        }
    }

    getWarpPerspectiveMatrix() {
        const pins = this.currentSession.calibration.cornerPoints;
        if (!pins || pins.length !== 4) return null;
        
        const srcPtsData = [];
        pins.forEach(pin => {
            srcPtsData.push(pin.x / this.scaleX);
            srcPtsData.push(pin.y / this.scaleY);
        });

        const dstPtsData = this.computeProportionalDstPoints(pins);

        let srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, srcPtsData);
        let dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, dstPtsData);
        let M = cv.getPerspectiveTransform(srcPts, dstPts);

        srcPts.delete();
        dstPts.delete();
        return M;
    }

    // ==========================================================
    // PROPORTIONAL WARP DESTINATION POINTS
    // When the detected quad is rectangular (not square), naive 900×900
    // warping stretches the image non-uniformly, distorting the circular
    // target rings into ellipses. This method computes adjusted destination
    // points that effectively:
    //   1. Warp the trapezoid to a correctly-proportioned rectangle
    //   2. Center-crop the square region containing the circular target
    // The result is a single homography that produces a 900×900 output
    // where circles remain circles.
    // ==========================================================
    computeProportionalDstPoints(pins) {
        if (!pins || pins.length !== 4) {
            return [0, 0, 900, 0, 900, 900, 0, 900];
        }

        // Always map to the full 900×900 output canvas so nothing is ever cropped.
        // Previous logic computed "proportional offsets" for portrait/landscape targets that
        // pushed warp corners outside the 900px boundary, effectively cutting the top/bottom
        // (or left/right) of the image. Returning a flat 900×900 rectangle ensures the
        // entire target — including outer ring numbers — is always fully visible.
        return [0, 0, 900, 0, 900, 900, 0, 900];
    }

    drawMatToCanvas(mat, canvas) {
        if (!mat || mat.empty()) return;
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = mat.cols;
        tempCanvas.height = mat.rows;
        cv.imshow(tempCanvas, mat);
        
        const ctx = canvas.getContext('2d');
        ctx.drawImage(tempCanvas, 0, 0, canvas.width, canvas.height);
    }

    renderDebugOverlays(ctx, isWarpedView, M) {
        const showAccepted = document.getElementById('debug-accepted')?.checked ?? true;
        const showRejected = document.getElementById('debug-rejected')?.checked ?? false;
        const showConfidence = document.getElementById('debug-confidence')?.checked ?? false;

        if (!this.detectedHoles) return;

        const warpM = M || this.getWarpPerspectiveMatrix();

        ctx.save();
        this.detectedHoles.forEach(hole => {
            // Find warped coordinates for matching
            let xcWarped = hole.x;
            let ycWarped = hole.y;
            if (warpM && !warpM.empty()) {
                const proj = this.projectPoint(hole.x, hole.y, warpM);
                xcWarped = proj.x / 1.8;
                ycWarped = proj.y / 1.8;
            }

            // A hole is considered "active" (accepted) if it matches an active shot in currentSession.shots
            const isActive = this.currentSession.shots && this.currentSession.shots.some(shot => {
                const dx = xcWarped - shot.x;
                const dy = ycWarped - shot.y;
                return Math.sqrt(dx*dx + dy*dy) < 5;
            });

            // If the user unselected it, we treat it as rejected
            const accepted = hole.accepted && isActive;

            if (accepted && !showAccepted) return;
            if (!accepted && !showRejected) return;

            let pt;
            let radius;
            if (isWarpedView) {
                pt = { x: xcWarped * 1.8, y: ycWarped * 1.8 };
                radius = Math.round(hole.radius * (500 / this.resizedWidth) * 1.8);
            } else {
                pt = this.mapRawToCanvas(hole.x, hole.y);
                radius = this.mapRawRadiusToCanvas(hole.radius);
            }

            ctx.beginPath();
            ctx.arc(pt.x, pt.y, radius, 0, Math.PI * 2);
            
            if (accepted) {
                ctx.strokeStyle = '#10b981';
                ctx.fillStyle = 'rgba(16, 185, 129, 0.2)';
                ctx.lineWidth = 2;
            } else {
                ctx.strokeStyle = '#ef4444';
                ctx.fillStyle = 'rgba(239, 68, 68, 0.1)';
                ctx.lineWidth = 1;
            }
            ctx.fill();
            ctx.stroke();

            let labelText = "";
            if (!accepted && showRejected) {
                labelText = hole.accepted ? "Manually Removed" : hole.rejectedReason;
            }
            if (showConfidence) {
                labelText = labelText ? `${labelText} (${hole.confidence}%)` : `${hole.confidence}%`;
            }

            if (labelText) {
                ctx.fillStyle = accepted ? '#34d399' : '#f87171';
                ctx.font = 'bold 9px var(--font-mono, monospace)';
                ctx.fillText(labelText, pt.x + radius + 3, pt.y + 3);
            }
        });
        ctx.restore();

        if (!M && warpM) {
            warpM.delete();
        }
    }

    renderYOLOOverlays(ctx, isWarpedView, M) {
        const showYolo = document.getElementById('layer-yolo')?.checked ?? true;
        if (!showYolo) return;

        // Determine which detections to draw
        let detections = [];
        const warpM = M || this.getWarpPerspectiveMatrix();

        if (isWarpedView) {
            if (this.yoloWarpedDetections && this.yoloWarpedDetections.length > 0) {
                const scale = 1.8;
                detections = this.yoloWarpedDetections.map(det => ({
                    x1: det.x1 * scale,
                    y1: det.y1 * scale,
                    x2: det.x2 * scale,
                    y2: det.y2 * scale,
                    xc: det.xc * scale,
                    yc: det.yc * scale,
                    w: det.w * scale,
                    h: det.h * scale,
                    classId: det.classId,
                    confidence: det.confidence,
                    className: det.className,
                    xcWarped: det.xc,
                    ycWarped: det.yc
                }));
            } else if (this.yoloDetections && this.yoloDetections.length > 0 && warpM && !warpM.empty()) {
                // Project from original detections to warped space (500x500)
                const scale = 500 / this.resizedWidth;
                detections = this.yoloDetections.map(det => {
                    const proj = this.projectPoint(det.xc, det.yc, warpM);
                    const proj_x = proj.x / 1.8;
                    const proj_y = proj.y / 1.8;
                    const w_proj = det.w * scale;
                    const h_proj = det.h * scale;
                    const drawScale = 1.8;
                    return {
                        x1: (proj_x - w_proj / 2) * drawScale,
                        y1: (proj_y - h_proj / 2) * drawScale,
                        x2: (proj_x + w_proj / 2) * drawScale,
                        y2: (proj_y + h_proj / 2) * drawScale,
                        xc: proj_x * drawScale,
                        yc: proj_y * drawScale,
                        w: w_proj * drawScale,
                        h: h_proj * drawScale,
                        classId: det.classId,
                        confidence: det.confidence,
                        className: det.className,
                        xcWarped: proj.x,
                        ycWarped: proj.y
                    };
                });
            }
        } else {
            // Map to original canvas (900x900 coordinate space)
            if (this.yoloDetections && this.yoloDetections.length > 0) {
                detections = this.yoloDetections.map(det => {
                    const x1 = (det.x1 / this.resizedWidth) * 900;
                    const y1 = (det.y1 / this.resizedHeight) * 900;
                    const x2 = (det.x2 / this.resizedWidth) * 900;
                    const y2 = (det.y2 / this.resizedHeight) * 900;
                    const xc = (det.xc / this.resizedWidth) * 900;
                    const yc = (det.yc / this.resizedHeight) * 900;
                    const w = (det.w / this.resizedWidth) * 900;
                    const h = (det.h / this.resizedHeight) * 900;
                    
                    let xcWarped = xc;
                    let ycWarped = yc;
                    if (warpM && !warpM.empty()) {
                        const proj = this.projectPoint(det.xc, det.yc, warpM);
                        xcWarped = proj.x / 1.8;
                        ycWarped = proj.y / 1.8;
                    }
                    
                    return {
                        x1, y1, x2, y2, xc, yc, w, h,
                        classId: det.classId,
                        confidence: det.confidence,
                        className: det.className,
                        xcWarped,
                        ycWarped
                    };
                });
            }
        }

        // Filter detections to only draw the ones that are still active in this.currentSession.shots
        if (this.currentSession.shots && this.currentSession.shots.length > 0) {
            detections = detections.filter(det => {
                let foundShotIndex = -1;
                const isMatched = this.currentSession.shots.some((shot, idx) => {
                    const dx = det.xcWarped - (shot.x * 1.8);
                    const dy = det.ycWarped - (shot.y * 1.8);
                    if (Math.sqrt(dx*dx + dy*dy) < 9) { // 5px in 500 space is 9px in 900 space
                        foundShotIndex = idx;
                        return true;
                    }
                    return false;
                });
                if (isMatched) {
                    det.shotIndex = foundShotIndex;
                }
                return isMatched;
            });
        } else {
            detections = [];
        }

        if (!detections || detections.length === 0) {
            if (!M && warpM) warpM.delete();
            return;
        }

        ctx.save();

        // Class colors
        const colors = {
            0: { stroke: '#f59e0b', fill: 'rgba(245, 158, 11, 0.12)' },
            1: { stroke: '#8b5cf6', fill: 'rgba(139, 92, 246, 0.12)' },
            2: { stroke: '#06b6d4', fill: 'rgba(6, 182, 212, 0.12)' },
            3: { stroke: '#f43f5e', fill: 'rgba(244, 63, 94, 0.12)' },
            4: { stroke: '#10b981', fill: 'rgba(16, 185, 129, 0.08)' }
        };
        const defaultColor = { stroke: '#3b82f6', fill: 'rgba(59, 130, 246, 0.12)' };

        detections.forEach(det => {
            const classColor = colors[det.classId] || defaultColor;

            // Draw bounding box
            ctx.strokeStyle = classColor.stroke;
            ctx.fillStyle = classColor.fill;
            ctx.lineWidth = 2;
            
            const x = det.x1;
            const y = det.y1;
            const width = det.w;
            const height = det.h;
            
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(x, y, width, height, 4);
            } else {
                ctx.rect(x, y, width, height);
            }
            ctx.fill();
            ctx.stroke();

            // Draw small crosshair/center point
            ctx.beginPath();
            ctx.arc(det.xc, det.yc, 2, 0, Math.PI * 2);
            ctx.fillStyle = classColor.stroke;
            ctx.fill();

            // Draw label
            let labelText = "";
            if (det.shotIndex !== undefined && det.shotIndex >= 0) {
                labelText = `Shot ${det.shotIndex + 1}`;
            } else {
                labelText = `Hole`;
            }
            
            ctx.font = 'bold 16px monospace';
            const textWidth = ctx.measureText(labelText).width;
            const tagHeight = 22;
            const tagWidth = textWidth + 8;
            const tagX = det.x1;
            let tagY = det.y1 - tagHeight;
            if (tagY < 0) {
                tagY = det.y1;
            }

            // Tag background
            ctx.fillStyle = classColor.stroke;
            ctx.beginPath();
            if (ctx.roundRect) {
                ctx.roundRect(tagX, tagY, tagWidth, tagHeight, [3, 3, 0, 0]);
            } else {
                ctx.rect(tagX, tagY, tagWidth, tagHeight);
            }
            ctx.fill();

            // Tag text
            ctx.fillStyle = '#ffffff';
            ctx.fillText(labelText, tagX + 4, tagY + 14);
        });

        ctx.restore();

        if (!M && warpM) {
            warpM.delete();
        }
    }

    renderPerspectiveTraceOverlays(ctx, isWarpedView, M) {
        // Default OFF — the element may not exist in the HTML.
        // The trace is a debug aid; it should not clutter the normal warped view.
        const showTrace = document.getElementById('debug-perspective-trace')?.checked ?? false;
        if (!showTrace) return;

        const shots = this.currentSession.shots;
        if (!shots || shots.length === 0) return;

        const warpM = M || this.getWarpPerspectiveMatrix();
        const M_inv = this.getInverseWarpMatrix();

        ctx.save();

        shots.forEach((shot, idx) => {
            if (shot.origX === undefined || shot.origY === undefined ||
                shot.projX === undefined || shot.projY === undefined) {
                return;
            }

            if (isWarpedView) {
                // In warped view we only need to show the PROJECTED position (where the
                // warp matrix mapped the hole to) vs the FINAL scoring position.
                // Drawing the raw original-image coords on the warped canvas is
                // meaningless and causes the "Orig scattered everywhere" bug.

                // Warped 900-space projected position (this is where the hole landed after warp)
                const pt_proj = {
                    x: shot.projX,
                    y: shot.projY
                };

                // Final scoring position (500-space → 900-space)
                const pt_score = {
                    x: shot.x * 1.8,
                    y: shot.y * 1.8
                };

                // Draw line from projected → scoring point (shows any post-warp adjustment)
                if (Math.abs(pt_proj.x - pt_score.x) > 3 || Math.abs(pt_proj.y - pt_score.y) > 3) {
                    ctx.beginPath();
                    ctx.moveTo(pt_proj.x, pt_proj.y);
                    ctx.lineTo(pt_score.x, pt_score.y);
                    ctx.strokeStyle = '#10b981'; // Green
                    ctx.lineWidth = 1.5;
                    ctx.setLineDash([3, 3]);
                    ctx.stroke();
                    ctx.setLineDash([]);
                }

                // Projected point dot (amber)
                ctx.beginPath();
                ctx.arc(pt_proj.x, pt_proj.y, 3, 0, Math.PI * 2);
                ctx.fillStyle = '#f59e0b';
                ctx.fill();

                // Shot index label near the scoring point
                ctx.fillStyle = '#ffffff';
                ctx.font = 'bold 9px monospace';
                ctx.fillText(`#${idx + 1}`, pt_score.x + 6, pt_score.y - 4);

            } else {
                // In Original (Calibration) View
                // 1. Original hole center (mapped to original canvas coordinate space)
                const pt_orig = this.mapRawToCanvas(shot.origX, shot.origY);

                // 2. Final scoring point mapped back to original canvas coordinate space using M_inv
                let pt_score;
                if (M_inv && !M_inv.empty()) {
                    const score_orig = this.projectPoint(shot.x * 1.8, shot.y * 1.8, M_inv);
                    pt_score = this.mapRawToCanvas(score_orig.x, score_orig.y);
                } else {
                    pt_score = this.mapRawToCanvas(shot.x * (this.resizedWidth / 500), shot.y * (this.resizedHeight / 500));
                }

                // Draw Line: Original Center -> Final Scoring Point (reverse mapped)
                ctx.beginPath();
                ctx.moveTo(pt_orig.x, pt_orig.y);
                ctx.lineTo(pt_score.x, pt_score.y);
                ctx.strokeStyle = 'rgba(245, 158, 11, 0.8)'; // Yellowish/Amber
                ctx.lineWidth = 1.5;
                ctx.setLineDash([3, 3]);
                ctx.stroke();
                ctx.setLineDash([]);

                // Draw Point 1: Original Center (Red circle)
                ctx.beginPath();
                ctx.arc(pt_orig.x, pt_orig.y, 4, 0, Math.PI * 2);
                ctx.fillStyle = '#ef4444';
                ctx.fill();

                // Draw Point 2: Final Scored Point (Green circle)
                ctx.beginPath();
                ctx.arc(pt_score.x, pt_score.y, 4, 0, Math.PI * 2);
                ctx.fillStyle = '#10b981';
                ctx.fill();
            }
        });

        ctx.restore();

        if (M_inv) M_inv.delete();
        if (!M && warpM) warpM.delete();
    }

    calculateConfidenceScores() {
        let targetConf = 0;
        let perspectiveConf = 0;
        let impactConf = 0;

        const calModeEl = document.getElementById('calibration-mode');
        const calMode = calModeEl ? calModeEl.value : 'auto';
        if (calMode === 'auto') {
            targetConf = this.currentSession.calibration.autoDetected ? 92 : 0;
        } else {
            targetConf = 100;
        }

        const pts = this.currentSession.calibration.cornerPoints;
        if (pts && pts.length === 4) {
            const getAngle = (p1, p2, p3) => {
                const v1 = { x: p1.x - p2.x, y: p1.y - p2.y };
                const v2 = { x: p3.x - p2.x, y: p3.y - p2.y };
                
                const dot = v1.x * v2.x + v1.y * v2.y;
                const mag1 = Math.sqrt(v1.x * v1.x + v1.y * v1.y);
                const mag2 = Math.sqrt(v2.x * v2.x + v2.y * v2.y);
                if (mag1 === 0 || mag2 === 0) return 90;
                
                const cosTheta = dot / (mag1 * mag2);
                return (Math.acos(Math.max(-1, Math.min(1, cosTheta))) * 180) / Math.PI;
            };

            const a1 = getAngle(pts[3], pts[0], pts[1]);
            const a2 = getAngle(pts[0], pts[1], pts[2]);
            const a3 = getAngle(pts[1], pts[2], pts[3]);
            const a4 = getAngle(pts[2], pts[3], pts[0]);

            const deviation = Math.abs(a1 - 90) + Math.abs(a2 - 90) + Math.abs(a3 - 90) + Math.abs(a4 - 90);
            perspectiveConf = Math.max(50, Math.min(100, Math.round(100 - (deviation * 0.83))));
        } else {
            perspectiveConf = 0;
        }

        const acceptedShots = this.currentSession.shots || [];
        let finalImpactConf = 0;
        if (acceptedShots.length > 0) {
            const sum = acceptedShots.reduce((acc, s) => acc + (s.confidence || 0), 0);
            finalImpactConf = Math.round(sum / acceptedShots.length);
        }

        const engine = document.getElementById('detection-engine')?.value || 'hybrid';
        let cvImpactConf = -1;
        let yoloImpactConf = -1;

        if (engine === 'opencv') {
            cvImpactConf = acceptedShots.length > 0 ? finalImpactConf : 0;
        } else if (engine === 'yolov11m') {
            yoloImpactConf = acceptedShots.length > 0 ? finalImpactConf : 0;
        } else if (engine === 'hybrid') {
            // In hybrid, final shots come from YOLO, but we can also show raw CV confidence if available
            yoloImpactConf = acceptedShots.length > 0 ? finalImpactConf : 0;
            if (this.detectedHoles && this.detectedHoles.length > 0) {
                const sum = this.detectedHoles.reduce((acc, h) => acc + (h.confidence || 0), 0);
                cvImpactConf = Math.round(sum / this.detectedHoles.length);
            }
        }

        let combinedConf = 0;
        let parts = 0;
        if (targetConf >= 0) { combinedConf += targetConf; parts++; }
        if (perspectiveConf >= 0) { combinedConf += perspectiveConf; parts++; }
        if (cvImpactConf >= 0) { combinedConf += cvImpactConf; parts++; }
        if (yoloImpactConf >= 0) { combinedConf += yoloImpactConf; parts++; }
        combinedConf = parts > 0 ? Math.round(combinedConf / parts) : 0;



        // Surface warp quality warning in the dedicated banner
        const warpWarningEl = document.getElementById('warp-quality-warning');
        const warpWarningTextEl = document.getElementById('warp-quality-warning-text');
        if (warpWarningEl) {
            let showWarning = false;
            let warningText = '';

            // Show warning if perspective confidence is below threshold
            if (perspectiveConf > 0 && perspectiveConf < 75) {
                showWarning = true;
                warningText = `Perspective warp confidence is low (${perspectiveConf}%). The target corners may not be accurately positioned.`;
            }

            // Also check ring spacing uniformity if warpedMat is available
            if (this.warpedMat && !this.warpedMat.empty()) {
                const template = this.getTargetTemplateDetails(this.currentSession.targetType);
                const warpCheck = this.validateWarpQuality(template);
                if (!warpCheck.valid) {
                    showWarning = true;
                    warningText = warpCheck.reason;
                }
            }

            warpWarningEl.style.display = showWarning ? 'block' : 'none';
            if (warpWarningTextEl && warningText) {
                warpWarningTextEl.textContent = warningText;
            }
        }
    }

    getProportionalMapping() {
        const w = this.originalImage ? this.originalImage.naturalWidth : 900;
        const h = this.originalImage ? this.originalImage.naturalHeight : 900;
        let scale = Math.min(900 / w, 900 / h);
        let drawW = w * scale;
        let drawH = h * scale;
        let offsetX = (900 - drawW) / 2;
        let offsetY = (900 - drawH) / 2;
        return { drawW, drawH, offsetX, offsetY };
    }

    mapRawToCanvas(x, y) {
        const m = this.getProportionalMapping();
        return {
            x: m.offsetX + (x / this.resizedWidth) * m.drawW,
            y: m.offsetY + (y / this.resizedHeight) * m.drawH
        };
    }

    mapRawRadiusToCanvas(r) {
        const m = this.getProportionalMapping();
        return (r / this.resizedWidth) * m.drawW;
    }

    calculateAnalyticScore(x, y) {
        const template = this.getTargetTemplateDetails(this.currentSession.targetType);

        // ── Robust center detection ─────────────────────────────────────────────
        if (!this.currentSession.detectedTargetCenter ||
            (!this.currentSession.detectedTargetCenter._manuallySet &&
             !this.currentSession.detectedTargetCenter._autoDetected)) {
            const autoCenter = this.detectCenterMultiStrategy();
            this.currentSession.detectedTargetCenter = { ...autoCenter };
        }
        const center = (this.currentSession.detectedTargetCenter &&
                        this.currentSession.detectedTargetCenter.valid)
            ? this.currentSession.detectedTargetCenter
            : { x: 250, y: 250 };

        const dx = x - center.x;
        const dy = y - center.y;
        const distPx = Math.sqrt(dx*dx + dy*dy);

        // ── Always use strict center-point scoring (no line-cutter radius deduction) ──
        // Score is determined purely from the Euclidean distance between the hole
        // center and the target center in the perspective-warped 500-space coordinate
        // system. The line-cutter rule is intentionally not applied here.
        const scoringDistance = distPx;

        // ── Image-derived pixelsPerMm ───────────────────────────────────────────
        let pixelsPerMm;

        if (this.currentSession.targetType === 'olympic-rifle' ||
            this.currentSession.targetType === 'olympic-pistol') {
            const blackRadiusPx = this.detectBlackCircleRadiusWarped();
            if (blackRadiusPx && blackRadiusPx > 20) {
                const blackRadiusMm = this.currentSession.targetType === 'olympic-rifle' ? 15.25 : 29.75;
                pixelsPerMm = blackRadiusPx / blackRadiusMm;
                console.log(`[PxMm] Black-circle calibration: ${pixelsPerMm.toFixed(4)} px/mm`);
            }
        }

        if (!pixelsPerMm) {
            if (!this.currentSession._calibratedPixelsPerMm) {
                this.currentSession._calibratedPixelsPerMm = this.calibratePixelsPerMmFromRings(template);
            }
            pixelsPerMm = this.currentSession._calibratedPixelsPerMm;
        }

        // Keep calibration object in sync so stats are correct
        this.currentSession.calibration.pixelsPerMm = pixelsPerMm;

        const maxScore     = template.scoreMax || 10.9;
        const ringCount    = template.ringCount || 10;

        // ── Detect actual ring boundaries in 500-space from warped image ────────
        const detectedRadii = this.detectAllRingRadiiWarped(template);
        const B = [0.0].concat(detectedRadii.slice(0, ringCount));

        // ── Scaled edge tolerance (proportional to warp ratio) ──────────────────
        const outerBoundaryPx = B.length > ringCount ? B[ringCount] : 250.0;
        const tolerancePx = 2.0 * (250.0 / Math.max(outerBoundaryPx, 50.0));

        // ── Piecewise scoring using detected ring boundaries ────────────────────
        let score = 0;
        let assigned_k = null;

        for (let k = 0; k < ringCount; k++) {
            if (k + 1 < B.length && B[k] <= scoringDistance && scoringDistance < B[k + 1]) {
                assigned_k = k;
                break;
            }
        }

        // Fallback: check with tolerance at the very outer edge
        if (assigned_k === null && B.length > ringCount) {
            if (scoringDistance - B[ringCount] <= tolerancePx) {
                assigned_k = ringCount - 1;
            }
        }

        if (assigned_k !== null) {
            // Benefit of the doubt: if very close to the inner boundary, upgrade
            if (assigned_k > 0 && (scoringDistance - B[assigned_k]) <= tolerancePx) {
                const final_k = assigned_k - 1;
                const fraction = 0.9999;
                const int_score = ringCount - final_k;
                score = int_score + 0.99 - 0.99 * fraction;
            } else {
                const final_k = assigned_k;
                const w_ring = B[final_k + 1] - B[final_k];
                let fraction = w_ring > 0 ? (scoringDistance - B[final_k]) / w_ring : 0;
                fraction = Math.max(0.0, Math.min(0.9999, fraction));
                const int_score = ringCount - final_k;
                score = int_score + 0.99 - 0.99 * fraction;
            }
            score = Math.round(score * 100) / 100;
        } else {
            score = 0.0;
        }

        // Hard limits
        score = Math.min(score, maxScore);
        score = Math.max(score, 0.0);

        console.log(`[Scoring] Center-point mode: dist=${distPx.toFixed(2)}px (no radius deduction), assigned_k=${assigned_k}, boundaries=[${B.map(b=>b.toFixed(1)).join(',')}], score=${score}`);

        return { score };
    }

    detectYellowRadiusWarped() {
        if (!this.warpedMat || this.warpedMat.empty()) return 50.0; // default nominal radius
        
        let hsv = new cv.Mat();
        let mask = new cv.Mat();
        try {
            cv.cvtColor(this.warpedMat, hsv, cv.COLOR_RGBA2RGB);
            cv.cvtColor(hsv, hsv, cv.COLOR_RGB2HSV);
            
            // Yellow HSV range
            let low = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [15, 50, 50, 0]);
            let high = new cv.Mat(hsv.rows, hsv.cols, hsv.type(), [35, 255, 255, 255]);
            cv.inRange(hsv, low, high, mask);
            
            let contours = new cv.MatVector();
            let hierarchy = new cv.Mat();
            cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
            
            let maxArea = 0;
            let yellowRadius = 50.0; // default nominal
            
            for (let i = 0; i < contours.size(); i++) {
                let contour = contours.get(i);
                let area = cv.contourArea(contour);
                if (area > 200) {
                    let rect = cv.minAreaRect(contour);
                    const cx = rect.center.x;
                    const cy = rect.center.y;
                    const center = (this.currentSession.detectedTargetCenter &&
                                    this.currentSession.detectedTargetCenter.valid)
                        ? this.currentSession.detectedTargetCenter
                        : { x: 250, y: 250 };
                    const cxCenter900 = center.x * 1.8;
                    const cyCenter900 = center.y * 1.8;
                    const distToCenter = Math.sqrt((cx - cxCenter900)**2 + (cy - cyCenter900)**2);
                    if (distToCenter < 90 && area > maxArea) {
                        maxArea = area;
                        yellowRadius = ((rect.size.width + rect.size.height) / 4) / 1.8;
                    }
                }
                contour.delete();
            }
            
            low.delete();
            high.delete();
            contours.delete();
            hierarchy.delete();
            
            return Math.max(30.0, Math.min(80.0, yellowRadius));
        } catch (e) {
            console.warn("Error detecting yellow radius:", e);
            return 50.0;
        } finally {
            hsv.delete();
            mask.delete();
        }
    }

    detectAllRingRadiiWarped(template) {
        if (this.currentSession.detectedRingRadii && this.currentSession.detectedRingRadii.length > 0) {
            return this.currentSession.detectedRingRadii;
        }

        const ringCount = template.ringCount || 10;
        let defaultSpacing = 250.0 / ringCount;
        let expectedRadii = [];
        for (let i = 1; i <= ringCount; i++) {
            expectedRadii.push(i * defaultSpacing);
        }

        if (!this.warpedMat || this.warpedMat.empty()) {
            if (!this.currentSession.detectedTargetCenter ||
                (!this.currentSession.detectedTargetCenter._manuallySet &&
                 !this.currentSession.detectedTargetCenter._autoDetected)) {
                this.currentSession.detectedTargetCenter = { x: 250, y: 250, valid: false };
            }
            return expectedRadii;
        }
        
        let gray = new cv.Mat();
        let blurred = new cv.Mat();
        let edges = new cv.Mat();
        let contours = new cv.MatVector();
        let hierarchy = new cv.Mat();
        
        let detectedRadii = [];
        let validCenters = [];

        const center = (this.currentSession.detectedTargetCenter &&
                        this.currentSession.detectedTargetCenter.valid)
            ? this.currentSession.detectedTargetCenter
            : { x: 250, y: 250 };
        const cxCenter900 = center.x * 1.8;
        const cyCenter900 = center.y * 1.8;

        try {
            cv.cvtColor(this.warpedMat, gray, cv.COLOR_RGBA2GRAY);
            cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
            cv.Canny(blurred, edges, 50, 150, 3, false);
            
            cv.findContours(edges, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);
            
            for (let i = 0; i < contours.size(); i++) {
                let contour = contours.get(i);
                if (contour.rows < 5) continue;
                
                let area = cv.contourArea(contour);
                let perimeter = cv.arcLength(contour, true);
                if (perimeter === 0) continue;
                
                let circularity = 4 * Math.PI * area / (perimeter * perimeter);
                
                if (circularity > 0.35) {
                    let rect = cv.minAreaRect(contour);
                    const cx = rect.center.x;
                    const cy = rect.center.y;
                    const distToCenter = Math.sqrt((cx - cxCenter900)**2 + (cy - cyCenter900)**2);
                    
                    if (distToCenter < 150) {
                        let radiusPx900 = (rect.size.width + rect.size.height) / 4;
                        let radiusPx500 = radiusPx900 / 1.8;
                        if (radiusPx500 > 5 && radiusPx500 < 400) {
                            detectedRadii.push(radiusPx500);
                            validCenters.push({ x: cx / 1.8, y: cy / 1.8 });
                        }
                    }
                }
            }
        } catch (e) {
            console.warn("Error detecting ring radii:", e);
        } finally {
            gray.delete();
            blurred.delete();
            edges.delete();
            contours.delete();
            hierarchy.delete();
        }

        detectedRadii.sort((a, b) => a - b);
        let clusteredRadii = [];
        for (let r of detectedRadii) {
            if (clusteredRadii.length === 0) {
                clusteredRadii.push(r);
            } else {
                let last = clusteredRadii[clusteredRadii.length - 1];
                if (r - last > 5) {
                    clusteredRadii.push(r);
                } else {
                    clusteredRadii[clusteredRadii.length - 1] = (last + r) / 2;
                }
            }
        }

        let finalRadii = [];
        if (clusteredRadii.length >= 2) {
            let spacings = [];
            for (let i = 1; i < clusteredRadii.length; i++) {
                spacings.push(clusteredRadii[i] - clusteredRadii[i - 1]);
            }
            spacings.sort((a, b) => a - b);
            let medianSpacing = spacings[Math.floor(spacings.length / 2)];
            
            for (let i = 1; i <= ringCount; i++) {
                let expectedRadius = i * medianSpacing;
                let closest = clusteredRadii.reduce((prev, curr) => 
                    Math.abs(curr - expectedRadius) < Math.abs(prev - expectedRadius) ? curr : prev
                );
                
                if (Math.abs(closest - expectedRadius) < medianSpacing * 0.35) {
                    finalRadii.push(closest);
                } else {
                    if (finalRadii.length > 0) {
                        finalRadii.push(finalRadii[finalRadii.length - 1] + medianSpacing);
                    } else {
                        finalRadii.push(expectedRadius);
                    }
                }
            }
        } else {
            finalRadii = expectedRadii;
        }

        // Validate and compute geometric center
        if (validCenters.length >= 2) {
            let avgX = 0;
            let avgY = 0;
            for (let pt of validCenters) {
                avgX += pt.x;
                avgY += pt.y;
            }
            avgX /= validCenters.length;
            avgY /= validCenters.length;

            let maxDist = 0;
            for (let pt of validCenters) {
                const dist = Math.sqrt((pt.x - avgX)**2 + (pt.y - avgY)**2);
                if (dist > maxDist) maxDist = dist;
            }

            if (maxDist < 10.0) {
                if (!this.currentSession.detectedTargetCenter ||
                    (!this.currentSession.detectedTargetCenter._manuallySet &&
                     !this.currentSession.detectedTargetCenter._autoDetected)) {
                    this.currentSession.detectedTargetCenter = { x: avgX, y: avgY, valid: true };
                }
            } else {
                console.warn(`[Scoring] Ring centers vary too much (max dev: ${maxDist.toFixed(1)}px). Falling back to previous or default center.`);
                if (!this.currentSession.detectedTargetCenter ||
                    (!this.currentSession.detectedTargetCenter._manuallySet &&
                     !this.currentSession.detectedTargetCenter._autoDetected)) {
                    this.currentSession.detectedTargetCenter = { x: 250, y: 250, valid: false };
                }
            }
        } else {
            console.warn(`[Scoring] Only ${validCenters.length} rings detected. Insufficient consensus. Falling back to previous or default center.`);
            if (!this.currentSession.detectedTargetCenter ||
                (!this.currentSession.detectedTargetCenter._manuallySet &&
                 !this.currentSession.detectedTargetCenter._autoDetected)) {
                this.currentSession.detectedTargetCenter = { x: 250, y: 250, valid: false };
            }
        }

        this.currentSession.detectedRingRadii = finalRadii;
        return finalRadii;
    }

    detectInnermostCircleWarped() {
        if (!this.warpedMat || this.warpedMat.empty()) return 10.0; // default nominal
        
        let gray = new cv.Mat();
        let blurred = new cv.Mat();
        let thresh = new cv.Mat();
        try {
            cv.cvtColor(this.warpedMat, gray, cv.COLOR_RGBA2GRAY);
            cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
            cv.adaptiveThreshold(blurred, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 21, 5);
            
            let contours = new cv.MatVector();
            let hierarchy = new cv.Mat();
            cv.findContours(thresh, contours, hierarchy, cv.RETR_TREE, cv.CHAIN_APPROX_SIMPLE);
            
            let minRadius = 999.0;
            
            for (let i = 0; i < contours.size(); i++) {
                let contour = contours.get(i);
                let area = cv.contourArea(contour);
                if (area > 30 && area < 3000) {
                    let rect = cv.minAreaRect(contour);
                    const cx = rect.center.x;
                    const cy = rect.center.y;
                    const center = (this.currentSession.detectedTargetCenter &&
                                    this.currentSession.detectedTargetCenter.valid)
                        ? this.currentSession.detectedTargetCenter
                        : { x: 250, y: 250 };
                    const cxCenter900 = center.x * 1.8;
                    const cyCenter900 = center.y * 1.8;
                    const distToCenter = Math.sqrt((cx - cxCenter900)**2 + (cy - cyCenter900)**2);
                    if (distToCenter < 54) {
                        let radius = ((rect.size.width + rect.size.height) / 4) / 1.8;
                        if (radius < minRadius) {
                            minRadius = radius;
                        }
                    }
                }
                contour.delete();
            }
            
            contours.delete();
            hierarchy.delete();
            
            if (minRadius > 5.0 && minRadius < 30.0) {
                return minRadius;
            }
            return 10.0;
        } catch (e) {
            console.warn("Error detecting innermost circle:", e);
            return 10.0;
        } finally {
            if (gray) gray.delete();
            if (blurred) blurred.delete();
            if (thresh) thresh.delete();
        }
    }

    detectBlackCircleRadiusWarped() {
        if (!this.warpedMat || this.warpedMat.empty()) return null;
        if (this.cachedBlackRadius) return this.cachedBlackRadius;
        
        let gray = new cv.Mat();
        let thresh = new cv.Mat();
        try {
            cv.cvtColor(this.warpedMat, gray, cv.COLOR_RGBA2GRAY);
            // Black circle is dark, threshold it.
            cv.threshold(gray, thresh, 80, 255, cv.THRESH_BINARY_INV);
            
            let contours = new cv.MatVector();
            let hierarchy = new cv.Mat();
            cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
            
            let maxArea = 0;
            let bestRadius = null;
            
            for (let i = 0; i < contours.size(); i++) {
                let contour = contours.get(i);
                let area = cv.contourArea(contour);
                if (area > 500) {
                    let rect = cv.minEnclosingCircle(contour);
                    let cx = rect.center.x;
                    let cy = rect.center.y;
                    const center = (this.currentSession.detectedTargetCenter &&
                                    this.currentSession.detectedTargetCenter.valid)
                        ? this.currentSession.detectedTargetCenter
                        : { x: 250, y: 250 };
                    const cxCenter900 = center.x * 1.8;
                    const cyCenter900 = center.y * 1.8;
                    let distToCenter = Math.sqrt((cx - cxCenter900)**2 + (cy - cyCenter900)**2);
                    // The black circle should be roughly centered
                    if (distToCenter < 180 && area > maxArea) {
                        maxArea = area;
                        bestRadius = rect.radius / 1.8;
                    }
                }
                contour.delete();
            }
            contours.delete();
            hierarchy.delete();
            
            this.cachedBlackRadius = bestRadius;
            return bestRadius;
        } catch (e) {
            console.warn("Error detecting black circle:", e);
            return null;
        } finally {
            if (gray) gray.delete();
            if (thresh) thresh.delete();
        }
    }

    // ==========================================================
    // ADVANCED BALLISTIC & GROUPING MATH
    // ==========================================================
    calculateAdvancedStats() {
        const shots = this.currentSession.shots;
        const total = shots.length;
        
        let totalScore = 0;
        let maxScore = 0;
        let minScore = total > 0 ? 10.9 : 0;
        let sumDist = 0;
        let sumX = 0;
        let sumY = 0;
        let extremeSpread = 0;
        let cep = 0;

        if (total > 0) {
            shots.forEach(shot => {
                totalScore += shot.score;
                sumDist += shot.distanceReal;
                sumX += shot.x;
                sumY += shot.y;
                if (shot.score > maxScore) maxScore = shot.score;
                if (shot.score < minScore) minScore = shot.score;
            });

            const avgScore = totalScore / total;
            const meanRadius = sumDist / total;
            const meanCentroidX = sumX / total;
            const meanCentroidY = sumY / total;

            // Offset windage & elevation from Center (250,250)
            const windagePx = meanCentroidX - 250;
            const elevationPx = meanCentroidY - 250;

            const pixelsPerMm = this.currentSession.calibration.pixelsPerMm;
            const windageMm = windagePx / pixelsPerMm;
            const elevationMm = elevationPx / pixelsPerMm;

            // Standard Deviations of X and Y coords
            let sqDiffX = 0;
            let sqDiffY = 0;
            shots.forEach(shot => {
                sqDiffX += (shot.x - meanCentroidX) ** 2;
                sqDiffY += (shot.y - meanCentroidY) ** 2;
            });
            const sdX = Math.sqrt(sqDiffX / total) / pixelsPerMm;
            const sdY = Math.sqrt(sqDiffY / total) / pixelsPerMm;

            // Extreme Spread (Max distance between any two shots)
            if (total > 1) {
                let maxSpread = 0;
                for (let i = 0; i < total; i++) {
                    for (let j = i + 1; j < total; j++) {
                        const dx = shots[i].x - shots[j].x;
                        const dy = shots[i].y - shots[j].y;
                        const dist = Math.sqrt(dx * dx + dy * dy);
                        if (dist > maxSpread) maxSpread = dist;
                    }
                }
                extremeSpread = maxSpread / pixelsPerMm;
            }

            // Circular Error Probable (CEP) Ballistics (approx 50% circle radius)
            cep = 0.5887 * (sdX + sdY);

            this.currentSession.stats = {
                totalShots: total,
                totalScore: totalScore,
                avgScore: avgScore,
                maxScore: maxScore,
                minScore: minScore,
                extremeSpread: extremeSpread, // mm
                meanRadius: meanRadius, // mm
                cep: cep, // mm
                windage: windageMm, // mm
                elevation: elevationMm, // mm
                sdX: sdX,
                sdY: sdY
            };

            // AI recommendations
            this.generateAiCoachingAdvice();
        } else {
            this.currentSession.stats = {
                totalShots: 0,
                totalScore: 0,
                avgScore: 0,
                maxScore: 0,
                minScore: 0,
                extremeSpread: 0,
                meanRadius: 0,
                cep: 0,
                windage: 0,
                elevation: 0,
                sdX: 0,
                sdY: 0
            };
        }
    }

    generateAiCoachingAdvice() {
        const stats = this.currentSession.stats;
        let adviceText = "";

        if (stats.totalShots < 3) {
            adviceText = "Add more shots to compile accurate ballistic distribution analysis.";
            document.getElementById('coaching-text').textContent = adviceText;
            return;
        }

        const tips = [];
        
        // 1. Sight adjustments based on group center offsets
        if (Math.abs(stats.windage) > 2.0 || Math.abs(stats.elevation) > 2.0) {
            let windDir = stats.windage > 0 ? "LEFT" : "RIGHT";
            let elevDir = stats.elevation > 0 ? "UP" : "DOWN";
            
            let sightTip = "🎯 Group centroid deviates from center. ";
            if (Math.abs(stats.windage) > 2.0) sightTip += `Adjust your rear sight clicks ${windDir} (${Math.abs(stats.windage).toFixed(1)} mm). `;
            if (Math.abs(stats.elevation) > 2.0) sightTip += `Adjust your sight elevation ${elevDir} (${Math.abs(stats.elevation).toFixed(1)} mm).`;
            tips.push(sightTip);
        }

        // 2. Breath control vertical spread analysis
        if (stats.sdY / stats.sdX > 1.45) {
            tips.push("🫁 High vertical dispersion noted. This points to vertical target climbing due to sight movement during breathing. Focus on completing your respiratory pause cycle before trigger release.");
        }

        // 3. Posture stability horizontal spread analysis
        if (stats.sdX / stats.sdY > 1.45) {
            tips.push("🧍 Large horizontal dispersion suggests lateral sway or unstable balance stance. Adjust your body position, ensure proper bone support alignment, and keep feet shoulder-width apart.");
        }

        // 4. Large extreme spread / grouping diameter
        if (stats.extremeSpread > 25.0) {
            tips.push("⚡ Large group dispersion. Work on trigger control stability, squeeze slowly without jerking, and practice consistency in your cheek weld and alignment.");
        }

        if (tips.length === 0) {
            tips.push("🏆 Excellent grouping structure and centered windage centroid! Maintain consistent posture rhythm and follow through after each release.");
        }

        document.getElementById('coaching-text').innerHTML = tips.map(tip => `<p style="margin-bottom: 0.35rem;">${tip}</p>`).join("");
    }

    // ==========================================================
    // VISUAL RENDERING CANVAS OVERLAYS
    // ==========================================================
    renderWarpedCanvas() {
        console.log('[DEBUG-RENDER] renderWarpedCanvas called! isWarpModeActive:', this.isWarpModeActive, 'isCalibrating:', this.isCalibrating, 'hasWarpedBase64:', !!this.currentSession.warpedImageBase64);
        const canvas = document.getElementById('analyzer-canvas');
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        let renderStartTime = performance.now();
        const showThreshold = document.getElementById('debug-threshold')?.checked ?? false;
        const showEdge = document.getElementById('debug-edge')?.checked ?? false;
        const M = this.getWarpPerspectiveMatrix();

        const drawBaseAndOverlays = () => {
            this.renderVisualOverlays(ctx);
            this.renderDebugOverlays(ctx, true, M);
            this.renderYOLOOverlays(ctx, true, M);
            this.renderPerspectiveTraceOverlays(ctx, true, M);
            if (M) M.delete();
            this.perf.renderTime = Math.round(performance.now() - renderStartTime);
            this.renderPerformanceUI();
        };

        if (showThreshold && this.debugThresholdMat && M && !M.empty()) {
            let warpedThreshold = new cv.Mat();
            cv.warpPerspective(this.debugThresholdMat, warpedThreshold, M, new cv.Size(900, 900));
            this.drawMatToCanvas(warpedThreshold, canvas);
            warpedThreshold.delete();
            drawBaseAndOverlays();
        } else if (showEdge && this.debugEdgeMat && M && !M.empty()) {
            let warpedEdges = new cv.Mat();
            cv.warpPerspective(this.debugEdgeMat, warpedEdges, M, new cv.Size(900, 900));
            this.drawMatToCanvas(warpedEdges, canvas);
            warpedEdges.delete();
            drawBaseAndOverlays();
        } else if (this.currentSession.warpedImageBase64) {
            const img = new Image();
            img.onload = () => {
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                drawBaseAndOverlays();
            };
            img.src = this.currentSession.warpedImageBase64;
        } else {
            window.drawTargetFace(ctx, 1.0);
            drawBaseAndOverlays();
        }
    }

    renderVisualOverlays(ctx) {
        const shots = this.currentSession.shots;

        // Toggle layer selectors
        const showRings = document.getElementById('layer-rings')?.checked ?? false;
        const showCenter = document.getElementById('layer-center')?.checked ?? true;
        const showScores = document.getElementById('layer-scores')?.checked ?? true;

        // Draw center crosshair — at the ACTUAL detected/set center, not a hardcoded point
        if (showCenter) {
            ctx.save();

            // Resolve scoring center: prefer manually set or Hough-detected center
            const sc = (this.currentSession.detectedTargetCenter &&
                        this.currentSession.detectedTargetCenter.valid)
                ? this.currentSession.detectedTargetCenter
                : { x: 250, y: 250 };

            // Scale from 500-space to 900-space
            const cx900 = sc.x * 1.8;
            const cy900 = sc.y * 1.8;

            // Cross-hair lines
            ctx.strokeStyle = 'rgba(239, 68, 68, 0.85)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(cx900, 12); ctx.lineTo(cx900, 888);
            ctx.moveTo(12, cy900); ctx.lineTo(888, cy900);
            ctx.stroke();

            // Center dot
            ctx.beginPath();
            ctx.arc(cx900, cy900, 5, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(239, 68, 68, 0.9)';
            ctx.fill();
            ctx.beginPath();
            ctx.arc(cx900, cy900, 2, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();

            // Badge label if manually set
            if (this.currentSession.detectedTargetCenter?._manuallySet) {
                ctx.fillStyle = 'rgba(239, 68, 68, 0.9)';
                ctx.font = 'bold 9px monospace';
                ctx.fillText('CENTER (manual)', cx900 + 8, cy900 - 6);
            }

            ctx.restore();
        }

        // "Set Center" cursor hint
        if (this.isSetCenterMode) {
            ctx.save();
            ctx.fillStyle = 'rgba(239, 68, 68, 0.9)';
            ctx.font = 'bold 11px monospace';
            ctx.fillText('🎯 Click on the BULLSEYE to set center', 14, 18);
            ctx.restore();
        }

        // Draw perfect target template rings to help verify warping accuracy
        if (showRings) {
            this.drawTargetTemplateRings(ctx);
        }

        // Render detected shot indicators
        shots.forEach((shot, idx) => {
            if (this.replayActive && idx >= this.replayIndex) return;

            ctx.save();
            
            const hx = shot.x * 1.8;
            const hy = shot.y * 1.8;
            
            
            // Outer circular shell (scaled from 500x500 to 900x900 by 1.8)
            ctx.beginPath();
            ctx.arc(hx, hy, shot.radius * 1.8, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(16, 185, 129, 0.45)';
            ctx.fill();
            ctx.strokeStyle = '#10b981';
            ctx.lineWidth = 2;
            ctx.stroke();

            // Inner pin core
            ctx.beginPath();
            ctx.arc(shot.x * 1.8, shot.y * 1.8, 2.5, 0, Math.PI * 2);
            ctx.fillStyle = '#ffffff';
            ctx.fill();

            // Labels overlay text
            ctx.shadowColor = 'black';
            ctx.shadowBlur = 4;
            
            let labelText = "";
            if (showScores) labelText = `${shot.score.toFixed(1)}`;

            ctx.font = 'bold 16px monospace';
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'left';
            ctx.fillText(labelText, hx + shot.radius * 1.8 + 5, hy - 5);

            ctx.restore();
        });
    }

    drawTargetTemplateRings(ctx) {
        ctx.save();
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.4)';
        ctx.lineWidth = 1.5;

        const sc = (this.currentSession.detectedTargetCenter &&
                    this.currentSession.detectedTargetCenter.valid)
            ? this.currentSession.detectedTargetCenter
            : { x: 250, y: 250 };
        const cxCenter900 = sc.x * 1.8;
        const cyCenter900 = sc.y * 1.8;

        const template = this.getTargetTemplateDetails(this.currentSession.targetType);
        const ringCount = template.ringCount || 10;

        // Use detected ring radii (from warped image edge analysis) for accurate overlays
        const detectedRadii = this.detectAllRingRadiiWarped(template);

        for (let i = 0; i < Math.min(ringCount, detectedRadii.length); i++) {
            const rPx500 = detectedRadii[i];
            if (rPx500 > 0) {
                const rPx900 = rPx500 * 1.8;
                ctx.beginPath();
                ctx.arc(cxCenter900, cyCenter900, rPx900, 0, Math.PI * 2);
                ctx.stroke();
            }
        }
        ctx.restore();
    }

    renderCalibrationCanvas() {
        console.log('[DEBUG-RENDER] renderCalibrationCanvas called! isWarpModeActive:', this.isWarpModeActive, 'isCalibrating:', this.isCalibrating, 'originalImage:', !!this.originalImage);
        const canvas = document.getElementById('analyzer-canvas');
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const showThreshold = document.getElementById('debug-threshold')?.checked ?? false;
        const showEdge = document.getElementById('debug-edge')?.checked ?? false;

        if (showThreshold && this.debugThresholdMat) {
            this.drawMatToCanvas(this.debugThresholdMat, canvas);
        } else if (showEdge && this.debugEdgeMat) {
            this.drawMatToCanvas(this.debugEdgeMat, canvas);
        } else if (this.originalImage) {
            const m = this.getProportionalMapping();
            ctx.drawImage(this.originalImage, m.offsetX, m.offsetY, m.drawW, m.drawH);
        }

        // Draw debug overlays (Accepted, Rejected, Confidence) on original canvas
        this.renderDebugOverlays(ctx, false, null);

        // Draw YOLO overlays on original canvas
        this.renderYOLOOverlays(ctx, false, null);

        // Draw perspective trace overlays on original canvas
        this.renderPerspectiveTraceOverlays(ctx, false, null);

        // Draw manual calibration corner quad lines
        const pins = this.currentSession.calibration.cornerPoints;
        if (pins && pins.length === 4) {
            ctx.save();
            ctx.strokeStyle = '#3b82f6';
            ctx.lineWidth = 2;
            ctx.beginPath();
            
            const tl = this.mapPinToCanvas(pins[0]);
            const tr = this.mapPinToCanvas(pins[1]);
            const br = this.mapPinToCanvas(pins[2]);
            const bl = this.mapPinToCanvas(pins[3]);

            ctx.moveTo(tl.x, tl.y);
            ctx.lineTo(tr.x, tr.y);
            ctx.lineTo(br.x, br.y);
            ctx.lineTo(bl.x, bl.y);
            ctx.closePath();
            ctx.stroke();

            ctx.fillStyle = 'rgba(59, 130, 246, 0.15)';
            ctx.fill();
            ctx.restore();
        }
    }

    showCornerPinsOverlay() {
        const pins = this.currentSession.calibration.cornerPoints;
        const container = document.getElementById('warp-pins-container');
        if (!container) return;

        container.style.display = 'block';

        const tl = this.mapPinToCanvas(pins[0]);
        const tr = this.mapPinToCanvas(pins[1]);
        const br = this.mapPinToCanvas(pins[2]);
        const bl = this.mapPinToCanvas(pins[3]);

        this.positionPinElement('pin-tl', tl.x, tl.y);
        this.positionPinElement('pin-tr', tr.x, tr.y);
        this.positionPinElement('pin-br', br.x, br.y);
        this.positionPinElement('pin-bl', bl.x, bl.y);
    }

    positionPinElement(id, x, y) {
        const el = document.getElementById(id);
        if (el) {
            el.style.left = `${(x / 900) * 100}%`;
            el.style.top = `${(y / 900) * 100}%`;
        }
    }

    mapPinToCanvas(pin) {
        // Map from natural image coordinates to 900x900 canvas space proportionally
        const m = this.getProportionalMapping();
        const w = this.originalImage ? this.originalImage.naturalWidth : 900;
        const h = this.originalImage ? this.originalImage.naturalHeight : 900;
        return {
            x: Math.round(m.offsetX + (pin.x / w) * m.drawW),
            y: Math.round(m.offsetY + (pin.y / h) * m.drawH)
        };
    }

    mapCanvasToPin(x, y) {
        // Map from 900x900 canvas space back to natural image coordinates
        const m = this.getProportionalMapping();
        const w = this.originalImage ? this.originalImage.naturalWidth : 900;
        const h = this.originalImage ? this.originalImage.naturalHeight : 900;
        return {
            x: Math.round(((x - m.offsetX) / m.drawW) * w),
            y: Math.round(((y - m.offsetY) / m.drawH) * h)
        };
    }

    // ==========================================================
    // REPLAY SEQUENCE VISUALIZATION
    // ==========================================================
    startShotReplay() {
        if (this.currentSession.shots.length === 0) return;

        clearInterval(this.replayInterval);
        this.replayActive = true;
        this.replayIndex = 0;
        
        const playBtn = document.getElementById('replay-play');
        playBtn.innerHTML = `<i class="fa-solid fa-pause"></i> Pause`;

        const interval = parseInt(document.getElementById('replay-speed').value);

        this.replayInterval = setInterval(() => {
            if (this.replayIndex < this.currentSession.shots.length) {
                this.replayIndex++;
                this.renderWarpedCanvas();

                // Play custom audio sync
                if (window.soundEffects) {
                    const template = this.getTargetTemplateDetails(this.currentSession.targetType);
                    const currentShot = this.currentSession.shots[this.replayIndex - 1];
                    const projType = document.getElementById('projectile-type').value;
                    window.soundEffects.play(currentShot.score > 0 ? projType : 'miss');
                }
            } else {
                this.pauseShotReplay();
            }
        }, interval);
    }

    pauseShotReplay() {
        clearInterval(this.replayInterval);
        this.replayActive = false;
        const playBtn = document.getElementById('replay-play');
        if (playBtn) playBtn.innerHTML = `<i class="fa-solid fa-play"></i> Play`;
    }

    resetShotReplay() {
        this.pauseShotReplay();
        this.replayIndex = 0;
        this.renderWarpedCanvas();
    }

    // ==========================================================
    // SESSION COMPARISON LOGIC
    // ==========================================================
    populateComparisonDropdowns() {
        const selectA = document.getElementById('compare-session-a');
        const selectB = document.getElementById('compare-session-b');
        
        if (!selectA || !selectB) return;

        const currentValA = selectA.value;
        const currentValB = selectB.value;

        selectA.innerHTML = '<option value="">-- Select Session A --</option>';
        selectB.innerHTML = '<option value="">-- Select Session B --</option>';

        this.sessionsList.forEach(session => {
            const dateStr = new Date(session.timestamp).toLocaleDateString();
            const optionText = `${session.name} (${dateStr} - ${session.shots.length} shots)`;
            
            selectA.appendChild(new Option(optionText, session.id));
            selectB.appendChild(new Option(optionText, session.id));
        });

        selectA.value = currentValA;
        selectB.value = currentValB;
    }

    runComparison() {
        const selectA = document.getElementById('compare-session-a');
        const selectB = document.getElementById('compare-session-b');
        if (!selectA || !selectB) return;

        const idA = selectA.value;
        const idB = selectB.value;

        if (!idA || !idB) {
            alert("Please select both Baseline and Comparison sessions.");
            return;
        }

        const sessionA = this.sessionsList.find(s => s.id === idA);
        const sessionB = this.sessionsList.find(s => s.id === idB);

        if (!sessionA || !sessionB) return;

        document.getElementById('comp-header-a').textContent = sessionA.name;
        document.getElementById('comp-header-b').textContent = sessionB.name;

        // Draw side by side canvases
        this.drawComparisonPaneCanvas('comparison-canvas-a', sessionA);
        this.drawComparisonPaneCanvas('comparison-canvas-b', sessionB);

        // Build comparison metrics rows
        this.renderComparisonStatsRows(sessionA, sessionB);
    }

    drawComparisonPaneCanvas(canvasId, session) {
        const canvas = document.getElementById(canvasId);
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // 1. Draw warped thumbnail background
        if (session.warpedImageBase64) {
            const img = new Image();
            img.onload = () => {
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                this.drawComparisonPaneShots(ctx, session);
            };
            img.src = session.warpedImageBase64;
        } else {
            window.drawTargetFace(ctx, 0.5); // scale target face to half size
            this.drawComparisonPaneShots(ctx, session);
        }
    }

    drawComparisonPaneShots(ctx, session) {
        ctx.save();
        session.shots.forEach((shot, idx) => {
            // Scale shot down to 450x450 size (factor = 0.5)
            const sx = shot.x * 0.5;
            const sy = shot.y * 0.5;
            const srad = shot.radius * 0.5;

            ctx.beginPath();
            ctx.arc(sx, sy, srad, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(239, 68, 68, 0.45)';
            ctx.fill();
            ctx.strokeStyle = '#ef4444';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            // Label
            ctx.font = 'bold 7px var(--font-mono)';
            ctx.fillStyle = '#ffffff';
            ctx.fillText(`${idx + 1}`, sx + srad + 2, sy - 2);
        });
        ctx.restore();
    }

    renderComparisonStatsRows(sessionA, sessionB) {
        const container = document.getElementById('comparison-rows');
        if (!container) return;

        const sA = sessionA.stats;
        const sB = sessionB.stats;

        // Metrics list: Total score, average score, mean radius, extreme spread, CEP
        const metrics = [
            { key: "totalScore", name: "Total Score", format: (v) => v.toFixed(2), betterIsLower: false },
            { key: "avgScore", name: "Average Score", format: (v) => v.toFixed(2), betterIsLower: false },
            { key: "meanRadius", name: "Mean Radius (mm)", format: (v) => v.toFixed(1), betterIsLower: true },
            { key: "extremeSpread", name: "Extreme Spread (mm)", format: (v) => v.toFixed(1), betterIsLower: true },
            { key: "cep", name: "CEP (50% Group) (mm)", format: (v) => v.toFixed(1), betterIsLower: true }
        ];

        let html = "";
        metrics.forEach(metric => {
            const valA = sA[metric.key] || 0;
            const valB = sB[metric.key] || 0;
            
            const diff = valB - valA;
            let deltaClass = "neutral";
            let deltaText = "";

            if (diff !== 0) {
                const improvement = metric.betterIsLower ? (diff < 0) : (diff > 0);
                deltaClass = improvement ? "better" : "worse";
                const sign = diff > 0 ? "+" : "";
                deltaText = `${sign}${metric.format(diff)}`;
            }

            html += `
                <div class="comparison-row">
                    <span class="metric-name">${metric.name}</span>
                    <span class="metric-val-a">${metric.format(valA)}</span>
                    <span class="metric-val-b">
                        ${metric.format(valB)}
                        ${deltaText ? `<span class="delta-badge ${deltaClass}">${deltaText}</span>` : ""}
                    </span>
                </div>
            `;
        });

        container.innerHTML = html;

        // Render comparative bar graph deltas on canvas
        this.drawComparisonVectorChart(sessionA, sessionB);
    }

    drawComparisonVectorChart(sessionA, sessionB) {
        const canvas = document.getElementById('comparison-chart');
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        const sA = sessionA.stats;
        const sB = sessionB.stats;

        // Draw simple horizontal bar comparison for Extreme Spread and Mean Radius (tightness indices)
        const metrics = [
            { name: "Extreme Spread", valA: sA.extremeSpread || 0, valB: sB.extremeSpread || 0 },
            { name: "Mean Radius", valA: sA.meanRadius || 0, valB: sB.meanRadius || 0 }
        ];

        ctx.save();
        ctx.font = '500 10px var(--font-title)';
        
        const isDark = document.body.classList.contains('dark-theme');
        const textColor = isDark ? '#9ca3af' : '#4b5563';
        const barABg = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.08)';

        metrics.forEach((m, idx) => {
            const yOffset = idx * 60 + 20;

            // Draw label
            ctx.fillStyle = textColor;
            ctx.fillText(m.name, 10, yOffset);

            // Compute scaling
            const maxVal = Math.max(m.valA, m.valB, 1);
            const scale = 200 / maxVal;

            // Bar A (Baseline)
            ctx.fillStyle = barABg;
            ctx.fillRect(10, yOffset + 8, m.valA * scale, 12);
            ctx.fillStyle = textColor;
            ctx.fillText(`${m.valA.toFixed(1)}mm`, m.valA * scale + 15, yOffset + 18);

            // Bar B (Comparison)
            ctx.fillStyle = isDark ? 'rgba(59, 130, 246, 0.4)' : 'rgba(29, 78, 216, 0.2)';
            ctx.fillRect(10, yOffset + 24, m.valB * scale, 12);
            ctx.fillStyle = isDark ? '#60a5fa' : '#1d4ed8';
            ctx.fillText(`${m.valB.toFixed(1)}mm`, m.valB * scale + 15, yOffset + 34);
        });

        ctx.restore();
    }

    // ==========================================================
    // EXPORT UTILITIES (CSV, JSON, YOLO, PDF)
    // ==========================================================
    exportCSV() {
        const shots = this.currentSession.shots;
        if (shots.length === 0) {
            alert("No data available to export.");
            return;
        }

        let csv = "data:text/csv;charset=utf-8,";
        csv += "Shot ID,Coordinates X,Coordinates Y,Score,Projectile Type,Confidence (%)\n";

        shots.forEach((shot, idx) => {
            csv += `${idx + 1},${shot.x},${shot.y},${shot.score.toFixed(2)},${shot.type},${shot.confidence}\n`;
        });

        // Add summary metrics
        const s = this.currentSession.stats;
        csv += `\nSUMMARY METRICS\n`;
        csv += `Total Score,${s.totalScore.toFixed(2)}\n`;
        csv += `Average Score,${s.avgScore.toFixed(2)}\n`;
        csv += `Extreme Spread (mm),${s.extremeSpread.toFixed(1)}\n`;
        csv += `Mean Radius (mm),${s.meanRadius.toFixed(1)}\n`;
        csv += `CEP (mm),${s.cep.toFixed(1)}\n`;

        const encodedUri = encodeURI(csv);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `bullseye_analyzer_report_${Date.now()}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    exportJSON() {
        const shots = this.currentSession.shots;
        if (shots.length === 0) {
            alert("No session data to export.");
            return;
        }

        // Build clean JSON schema
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify({
            sessionName: this.currentSession.name,
            timestamp: this.currentSession.timestamp,
            targetType: this.currentSession.targetType,
            calibration: this.currentSession.calibration,
            metrics: this.currentSession.stats,
            impacts: this.currentSession.shots
        }, null, 2));

        const link = document.createElement('a');
        link.setAttribute("href", dataStr);
        link.setAttribute("download", `bullseye_analysis_session_${Date.now()}.json`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    exportYOLOAnnotations() {
        const shots = this.currentSession.shots;
        if (shots.length === 0) {
            alert("No detected shots available for YOLO export.");
            return;
        }

        // YOLO Format: class_id x_center y_center width height (normalized 0.0 to 1.0)
        let labels = "";
        
        shots.forEach(shot => {
            const xCent = shot.x / 900.0;
            const yCent = shot.y / 900.0;
            const w = (shot.radius * 2) / 900.0;
            const h = (shot.radius * 2) / 900.0;

            const classId = Number.isInteger(shot.classId) ? shot.classId : 0;

            labels += `${classId} ${xCent.toFixed(6)} ${yCent.toFixed(6)} ${w.toFixed(6)} ${h.toFixed(6)}\n`;
        });

        // Trigger text file download
        const blob = new Blob([labels], { type: 'text/plain' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `target_annotations_${Date.now()}.txt`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    exportPDFCoachingReport() {
        if (!this.jsPdfLoaded || !window.jspdf) {
            alert("PDF generation engine jsPDF has not finished loading. Please try again.");
            return;
        }

        const { jsPDF } = window.jspdf;
        const pdf = new jsPDF('p', 'mm', 'a4');
        const s = this.currentSession.stats;

        // Header Project details
        pdf.setFillColor(11, 15, 25); // sleek dark theme background accents
        pdf.rect(0, 0, 210, 40, 'F');

        pdf.setTextColor(255, 255, 255);
        pdf.setFontSize(22);
        pdf.setFont("helvetica", "bold");
        pdf.text("BULLSEYE AI v2.0", 15, 20);
        pdf.setFontSize(10);
        pdf.setFont("helvetica", "normal");
        pdf.text("Industrial-Grade Target Precision Scoring & Ballistics Analysis", 15, 28);
        pdf.text(`Generated: ${new Date().toLocaleString()}`, 145, 28);

        // Session Information details
        pdf.setTextColor(11, 15, 25);
        pdf.setFontSize(14);
        pdf.setFont("helvetica", "bold");
        pdf.text("Session Information", 15, 55);

        pdf.setFontSize(10);
        pdf.setFont("helvetica", "normal");
        pdf.text(`Session Name: ${this.currentSession.name}`, 15, 62);
        pdf.text(`Target Face Template: ${this.getTargetTemplateDetails(this.currentSession.targetType).name}`, 15, 67);
        pdf.text(`Reliability Index: ${document.getElementById('analyzer-reliability-val').textContent}`, 15, 72);

        // Comparative Metrics
        pdf.setFontSize(14);
        pdf.setFont("helvetica", "bold");
        pdf.text("Ballistics & Dispersion Metrics", 15, 82);

        pdf.setFontSize(10);
        pdf.setFont("helvetica", "normal");
        pdf.text(`Total Score: ${s.totalScore.toFixed(2)}`, 15, 89);
        pdf.text(`Average Score: ${s.avgScore.toFixed(2)}`, 15, 94);
        pdf.text(`Extreme Spread: ${s.extremeSpread.toFixed(1)} mm`, 15, 99);
        pdf.text(`Mean Radius: ${s.meanRadius.toFixed(1)} mm`, 15, 104);
        pdf.text(`Circular Error Probable (CEP): ${s.cep.toFixed(1)} mm`, 15, 109);
        pdf.text(`Centroid Windage Offset: ${s.windage.toFixed(1)} mm`, 15, 114);
        pdf.text(`Centroid Elevation Offset: ${s.elevation.toFixed(1)} mm`, 15, 119);

        // Draw a placeholder or screenshot of the warped canvas
        const canvas = document.getElementById('analyzer-canvas');
        try {
            const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
            pdf.addImage(dataUrl, 'JPEG', 110, 50, 85, 85);
        } catch (e) {
            console.error("Could not append image to PDF:", e);
        }

        // Draw a dividing line
        pdf.setDrawColor(200, 200, 200);
        pdf.line(15, 140, 195, 140);

        // AI Coaching Advice Section
        pdf.setFontSize(14);
        pdf.setFont("helvetica", "bold");
        pdf.text("AI Coaching Recommendations", 15, 150);

        pdf.setFontSize(9.5);
        pdf.setFont("helvetica", "normal");
        
        // Split coaching text into lines to avoid overflow
        const rawCoachingText = document.getElementById('coaching-text').innerText;
        const splitText = pdf.splitTextToSize(rawCoachingText, 180);
        pdf.text(splitText, 15, 157);

        // Add second page for table
        pdf.addPage();
        
        pdf.setFillColor(11, 15, 25);
        pdf.rect(0, 0, 210, 15, 'F');
        pdf.setTextColor(255, 255, 255);
        pdf.setFontSize(12);
        pdf.setFont("helvetica", "bold");
        pdf.text("Detailed Impact Log Table", 15, 10);

        // Table headers
        pdf.setTextColor(50, 50, 50);
        pdf.setFontSize(9);
        pdf.text("Shot #", 15, 25);
        pdf.text("Coordinates (X, Y)", 40, 25);
        pdf.text("Calculated Score", 100, 25);
        pdf.text("Projectile Type", 145, 25);
        
        pdf.line(15, 28, 195, 28);

        pdf.setFont("helvetica", "normal");
        let y = 34;
        this.currentSession.shots.forEach((shot, idx) => {
            if (y > 280) {
                pdf.addPage();
                y = 20;
            }
            pdf.text(`${idx + 1}`, 15, y);
            pdf.text(`X: ${shot.x} | Y: ${shot.y}`, 40, y);
            pdf.text(`${shot.score.toFixed(2)}`, 100, y);
            pdf.text(`${shot.type}`, 145, y);
            y += 7;
        });

        pdf.save(`bullseye_coaching_report_${this.currentSession.name}.pdf`);
    }

    // ==========================================================
    // UI MANAGEMENT
    // ==========================================================
    activate() {
        this.isCalibrating = false;
        
        // Show opencv loaded state
        this.updateCvStatus(this.openCvLoaded);

        // Draw initial canvas representation
        this.renderWarpedCanvas();
        this.updateStatsUI();
        this.renderShotsTableUI();
    }

    renderPerformanceUI() {
        // No-op (benchmarks panel removed)
    }

    updateStatsUI() {
        const s = this.currentSession.stats;
        
        if (s.totalShots === undefined) return;

        // Display results
        document.getElementById('analyzer-stat-total-shots').textContent = s.totalShots;
        document.getElementById('analyzer-stat-total-score').textContent = s.totalScore.toFixed(2);
        document.getElementById('analyzer-stat-avg-score').textContent = s.avgScore.toFixed(2);
        document.getElementById('analyzer-stat-minmax').textContent = `${s.minScore.toFixed(1)} - ${s.maxScore.toFixed(1)}`;
    }

    getUnitConversionFactor(unit) {
        if (unit === 'px') return this.currentSession.calibration.pixelsPerMm || 17.58;
        if (unit === 'mm') return 1.0;
        if (unit === 'cm') return 0.1;
        if (unit === 'in') return 0.03937;
        return 1.0;
    }

    renderShotsTableUI() {
        const tbody = document.getElementById('analyzer-shot-tbody');
        if (!tbody) return;

        tbody.innerHTML = "";

        const unitName = document.getElementById('unit-system').value;
        const scale = this.getUnitConversionFactor(unitName);

        this.currentSession.shots.forEach((shot, idx) => {
            const tr = document.createElement('tr');
            
            // color mapping
            let color = '#d97706';
            if (shot.score >= 9) color = '#f5f5f5';
            else if (shot.score >= 7) color = '#1e1e1e';
            else if (shot.score >= 5) color = '#2563eb';
            else if (shot.score >= 3) color = '#ef4444';

            tr.innerHTML = `
                <td><strong>${idx + 1}</strong></td>
                <td>X: ${Math.round(shot.x)} | Y: ${Math.round(shot.y)}</td>
                <td><span class="ring-color-dot" style="background: ${color};"></span>${shot.score.toFixed(2)}</td>
                <td style="text-align: right;">
                    <button class="delete-shot-btn" data-id="${shot.id}"><i class="fa-solid fa-trash-can"></i></button>
                </td>
            `;

            tr.querySelector('.delete-shot-btn').addEventListener('click', (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                this.deleteShotFromSession(id);
            });

            tbody.appendChild(tr);
        });
    }

    deleteShotFromSession(id) {
        this.currentSession.shots = this.currentSession.shots.filter(shot => shot.id !== id);
        this.calculateAdvancedStats();
        this.renderWarpedCanvas();
        this.updateStatsUI();
        this.renderShotsTableUI();
    }

    renderSessionsListUI() {
        const container = document.getElementById('saved-sessions-list');
        if (!container) return;

        if (this.sessionsList.length === 0) {
            container.innerHTML = `<div style="color: var(--text-muted); text-align: center; padding: 0.5rem;">No saved sessions yet</div>`;
            return;
        }

        container.innerHTML = "";
        this.sessionsList.forEach(session => {
            const div = document.createElement('div');
            div.className = "session-item";
            div.innerHTML = `
                <div class="session-info-left">
                    <span class="session-title">${session.name}</span>
                    <span class="session-meta">${new Date(session.timestamp).toLocaleDateString()} — ${session.shots.length} shots</span>
                </div>
                <button class="session-delete-btn" data-id="${session.id}"><i class="fa-solid fa-trash-can"></i></button>
            `;

            // click to load
            div.addEventListener('click', (e) => {
                if (e.target.closest('.session-delete-btn')) return;
                this.loadSessionIntoActive(session.id);
            });

            // delete button
            div.querySelector('.session-delete-btn').addEventListener('click', async (e) => {
                e.stopPropagation();
                if (confirm(`Delete session "${session.name}"?`)) {
                    await this.deleteSession(session.id);
                }
            });

            container.appendChild(div);
        });
    }
}

// Global initialization
document.addEventListener('DOMContentLoaded', () => {
    // Redirect console logs to node server for debugging
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    function sendLogToServer(type, args) {
        const serializedArgs = args.map(arg => {
            if (arg instanceof Error) {
                return { message: arg.message, stack: arg.stack };
            }
            if (typeof arg === 'object') {
                try {
                    return JSON.parse(JSON.stringify(arg));
                } catch (e) {
                    return '[Unserializable Object]';
                }
            }
            return arg;
        });

        fetch('/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, args: serializedArgs })
        }).catch(() => {});
    }

    console.log = (...args) => {
        originalLog(...args);
        sendLogToServer('log', args);
    };
    console.warn = (...args) => {
        originalWarn(...args);
        sendLogToServer('warn', args);
    };
    console.error = (...args) => {
        originalError(...args);
        sendLogToServer('error', args);
    };

    window.analyzer = new TargetImageAnalyzer();
    
    // Bind all Analyzer UI controls
    const uploadZone = document.getElementById('analyzer-upload-zone');
    const fileInput = document.getElementById('analyzer-file-input');
    const placeholderBtn = document.getElementById('placeholder-upload-btn');

    // Prevent default drag/drop behaviors globally and show full-screen overlay on drag
    let dragCounter = 0;

    function isValidDrag(e) {
        if (!e.dataTransfer) return false;
        const types = e.dataTransfer.types;
        return types.includes('Files') || types.includes('text/uri-list') || types.includes('text/html') || types.includes('text/plain');
    }

    window.addEventListener('dragenter', (e) => {
        e.preventDefault();
        if (isValidDrag(e)) {
            dragCounter++;
            const overlay = document.getElementById('analyzer-drag-overlay');
            if (overlay) {
                overlay.style.display = 'flex';
                overlay.offsetHeight; // force reflow
                overlay.classList.add('active');
            }
        }
    }, false);

    window.addEventListener('dragover', (e) => {
        e.preventDefault();
    }, false);

    window.addEventListener('dragleave', (e) => {
        e.preventDefault();
        if (isValidDrag(e)) {
            dragCounter--;
            if (dragCounter <= 0) {
                dragCounter = 0;
                const overlay = document.getElementById('analyzer-drag-overlay');
                if (overlay) {
                    overlay.classList.remove('active');
                    setTimeout(() => {
                        if (!overlay.classList.contains('active')) {
                            overlay.style.display = 'none';
                        }
                    }, 300);
                }
            }
        }
    }, false);

    window.addEventListener('drop', async (e) => {
        e.preventDefault();
        dragCounter = 0;
        const overlay = document.getElementById('analyzer-drag-overlay');
        if (overlay) {
            overlay.classList.remove('active');
            overlay.style.display = 'none';
        }
        
        if (e.dataTransfer) {
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                if (window.app) {
                    window.app.switchTab('analyzer');
                }
                if (window.analyzer) {
                    window.analyzer.handleFilesAdded(e.dataTransfer.files);
                }
            } else {
                let imageUrl = '';
                if (e.dataTransfer.types.includes('text/uri-list')) {
                    imageUrl = e.dataTransfer.getData('text/uri-list');
                }
                if (!imageUrl && e.dataTransfer.types.includes('text/html')) {
                    const html = e.dataTransfer.getData('text/html');
                    const parser = new DOMParser();
                    const doc = parser.parseFromString(html, 'text/html');
                    const img = doc.querySelector('img');
                    if (img && img.src) {
                        imageUrl = img.src;
                    }
                }
                if (!imageUrl && e.dataTransfer.types.includes('text/plain')) {
                    imageUrl = e.dataTransfer.getData('text/plain');
                }
                if (imageUrl) {
                    imageUrl = imageUrl.split('\n')[0].trim();
                }
                if (imageUrl && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://') || imageUrl.startsWith('data:image/'))) {
                    if (window.app) {
                        window.app.switchTab('analyzer');
                    }
                    if (window.analyzer) {
                        await window.analyzer.handleImageUrlAdded(imageUrl);
                    }
                }
            }
        }
    }, false);

    // Initialize placeholder visibility on load
    if (window.analyzer) {
        window.analyzer.updatePlaceholderVisibility();
    }

    if (placeholderBtn && fileInput) {
        placeholderBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            fileInput.click();
        });
    }

    if (uploadZone && fileInput) {
        uploadZone.addEventListener('click', (e) => {
            // Only trigger click on fileInput if user clicked the zone but not the input itself
            if (e.target !== fileInput) {
                fileInput.click();
            }
        });
        
        // Prevent click events on the input from bubbling up to the zone, avoiding double dialog trigger
        fileInput.addEventListener('click', (e) => {
            e.stopPropagation();
        });

        fileInput.addEventListener('change', (e) => {
            window.analyzer.handleFilesAdded(e.target.files);
        });

        // Click on warped canvas to manually add a hole
        const canvas = document.getElementById('analyzer-canvas');
        if (canvas) {
            canvas.addEventListener('click', (e) => {
                if (!window.analyzer.originalImage) return;

                const rect = canvas.getBoundingClientRect();
                const cx = rect.width > 0 ? (((e.clientX - rect.left) / rect.width) * canvas.width) : (e.clientX - rect.left);
                const cy = rect.height > 0 ? (((e.clientY - rect.top) / rect.height) * canvas.height) : (e.clientY - rect.top);

                // "Set Center" mode: next click sets the scoring center
                if (window.analyzer.isSetCenterMode) {
                    window.analyzer.setManualCenter(cx, cy);
                    return;
                }

                // Normal mode: add/remove holes
                if (!window.analyzer.isCalibrating && !window.analyzer.isWarpModeActive) {
                    window.analyzer.toggleHoleAtCoordinates(cx / 1.8, cy / 1.8);
                }
            });

            canvas.addEventListener('mousemove', (e) => {
                if (window.analyzer.originalImage && !window.analyzer.isCalibrating && !window.analyzer.isWarpModeActive) {
                    canvas.style.cursor = 'crosshair';
                    const rect = canvas.getBoundingClientRect();
                    const cx = rect.width > 0 ? (((e.clientX - rect.left) / rect.width) * canvas.width) : (e.clientX - rect.left);
                    const cy = rect.height > 0 ? (((e.clientY - rect.top) / rect.height) * canvas.height) : (e.clientY - rect.top);
                    
                    // Track coordinates (normalized to 500x500 warped space)
                    const trackX = document.getElementById('analyzer-track-x');
                    const trackY = document.getElementById('analyzer-track-y');
                    if (trackX) trackX.textContent = Math.round(cx / 1.8);
                    if (trackY) trackY.textContent = Math.round(cy / 1.8);

                    // Track hover score
                    const hoverScore = document.getElementById('analyzer-hover-score');
                    if (hoverScore) {
                        const scoreObj = window.analyzer.calculateAnalyticScore(cx / 1.8, cy / 1.8);
                        hoverScore.textContent = scoreObj.score > 0 ? scoreObj.score.toFixed(2) : 'MISS';
                    }
                } else {
                    canvas.style.cursor = 'default';
                }
            });

            canvas.addEventListener('mouseleave', () => {
                const hoverScore = document.getElementById('analyzer-hover-score');
                if (hoverScore) hoverScore.textContent = '-';
            });
        }

        // Drag & drop handlers
        uploadZone.addEventListener('dragenter', (e) => {
            e.preventDefault();
            e.stopPropagation();
            uploadZone.classList.add('dragover');
        });
        uploadZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            uploadZone.classList.add('dragover');
        });
        uploadZone.addEventListener('dragleave', (e) => {
            e.preventDefault();
            e.stopPropagation();
            uploadZone.classList.remove('dragover');
        });
        uploadZone.addEventListener('drop', async (e) => {
            e.preventDefault();
            e.stopPropagation();
            uploadZone.classList.remove('dragover');
            
            if (e.dataTransfer) {
                if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                    window.analyzer.handleFilesAdded(e.dataTransfer.files);
                } else {
                    let imageUrl = '';
                    if (e.dataTransfer.types.includes('text/uri-list')) {
                        imageUrl = e.dataTransfer.getData('text/uri-list');
                    }
                    if (!imageUrl && e.dataTransfer.types.includes('text/html')) {
                        const html = e.dataTransfer.getData('text/html');
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(html, 'text/html');
                        const img = doc.querySelector('img');
                        if (img && img.src) {
                            imageUrl = img.src;
                        }
                    }
                    if (!imageUrl && e.dataTransfer.types.includes('text/plain')) {
                        imageUrl = e.dataTransfer.getData('text/plain');
                    }
                    if (imageUrl) {
                        imageUrl = imageUrl.split('\n')[0].trim();
                    }
                    if (imageUrl && (imageUrl.startsWith('http://') || imageUrl.startsWith('https://') || imageUrl.startsWith('data:image/'))) {
                        await window.analyzer.handleImageUrlAdded(imageUrl);
                    }
                }
            }
        });
    }

    // Paste from clipboard handler
    document.addEventListener('paste', (e) => {
        // Only run paste detector if the analyzer tab is active
        if (window.app && window.app.currentMode === 'analyzer') {
            const items = (e.clipboardData || e.originalEvent.clipboardData).items;
            const files = [];
            for (let i = 0; i < items.length; i++) {
                if (items[i].type.indexOf("image") === 0) {
                    files.push(items[i].getAsFile());
                }
            }
            if (files.length > 0) {
                window.analyzer.handleFilesAdded(files);
            }
        }
    });

    // Calibration elements drag handlers
    const pinsContainer = document.getElementById('warp-pins-container');
    const pinIds = ['pin-tl', 'pin-tr', 'pin-br', 'pin-bl'];

    pinIds.forEach((id, idx) => {
        const pinEl = document.getElementById(id);
        if (!pinEl) return;

        pinEl.addEventListener('mousedown', (e) => {
            e.preventDefault();
            window.analyzer.activePin = idx;
            const canvas = document.getElementById('analyzer-canvas');
            const rect = canvas.getBoundingClientRect();
            
            // Map pin coordinates to backing canvas (900x900)
            const pinBacking = window.analyzer.mapPinToCanvas(window.analyzer.currentSession.calibration.cornerPoints[idx]);
            
            // Map mouse coordinates to backing canvas (900x900)
            const mouseX = rect.width > 0 ? (((e.clientX - rect.left) / rect.width) * canvas.width) : (e.clientX - rect.left);
            const mouseY = rect.height > 0 ? (((e.clientY - rect.top) / rect.height) * canvas.height) : (e.clientY - rect.top);
            
            window.analyzer.pinOffset = {
                x: mouseX - pinBacking.x,
                y: mouseY - pinBacking.y
            };
        });
    });

    document.addEventListener('mousemove', (e) => {
        if (window.analyzer && window.analyzer.activePin !== null) {
            const canvas = document.getElementById('analyzer-canvas');
            const rect = canvas.getBoundingClientRect();
            
            // Map mouse coordinates to backing canvas (900x900)
            let mouseX = rect.width > 0 ? (((e.clientX - rect.left) / rect.width) * canvas.width) : (e.clientX - rect.left);
            let mouseY = rect.height > 0 ? (((e.clientY - rect.top) / rect.height) * canvas.height) : (e.clientY - rect.top);
            
            // Apply drag offset in 900x900 space
            let x = mouseX - window.analyzer.pinOffset.x;
            let y = mouseY - window.analyzer.pinOffset.y;

            // Constrain to canvas
            x = Math.max(0, Math.min(canvas.width, x));
            y = Math.max(0, Math.min(canvas.height, y));

            const pinId = pinIds[window.analyzer.activePin];
            window.analyzer.positionPinElement(pinId, x, y);

            // Update pin coordinate in session
            const imgCoord = window.analyzer.mapCanvasToPin(x, y);
            window.analyzer.currentSession.calibration.cornerPoints[window.analyzer.activePin] = imgCoord;

            // Redraw calibration frame lines
            window.analyzer.renderCalibrationCanvas();
        }
    });

    document.addEventListener('mouseup', async () => {
        if (window.analyzer && window.analyzer.activePin !== null) {
            window.analyzer.activePin = null;
            // Rerun perspective warp and detection on release
            await window.analyzer.applyWarpAndImpactDetection();
        }
    });

    // Replay controls
    const replayPlayBtn = document.getElementById('replay-play');
    if (replayPlayBtn) {
        replayPlayBtn.addEventListener('click', () => {
            if (window.analyzer.replayActive) {
                window.analyzer.pauseShotReplay();
            } else {
                window.analyzer.startShotReplay();
            }
        });
    }

    const replayResetBtn = document.getElementById('replay-reset');
    if (replayResetBtn) {
        replayResetBtn.addEventListener('click', () => {
            window.analyzer.resetShotReplay();
        });
    }

    // Layers visibility triggers
    const layerIds = ['layer-rings', 'layer-center', 'layer-scores', 'layer-yolo'];
    layerIds.forEach(id => {
        const checkbox = document.getElementById(id);
        if (checkbox) {
            checkbox.addEventListener('change', () => {
                const previewCheckbox = document.getElementById('manual-warp-preview');
                const isWarped = previewCheckbox ? previewCheckbox.checked : false;
                if (isWarped || !window.analyzer.isWarpModeActive) {
                    window.analyzer.renderWarpedCanvas();
                } else {
                    window.analyzer.renderCalibrationCanvas();
                }
            });
        }
    });

    // Detection Engine selector trigger
    const detectionEngine = document.getElementById('detection-engine');
    if (detectionEngine) {
        detectionEngine.addEventListener('change', async () => {
            if (window.analyzer.originalImage) {
                await window.analyzer.detectImpactShots();
                window.analyzer.calculateAdvancedStats();
                const previewCheckbox = document.getElementById('manual-warp-preview');
                const isWarped = previewCheckbox ? previewCheckbox.checked : false;
                if (isWarped || !window.analyzer.isWarpModeActive) {
                    window.analyzer.renderWarpedCanvas();
                } else {
                    window.analyzer.renderCalibrationCanvas();
                }
                window.analyzer.updateStatsUI();
                window.analyzer.renderShotsTableUI();
            }
        });
    }

    // YOLO confidence slider triggers
    const yoloSlider = document.getElementById('yolo-conf-threshold');
    const yoloVal = document.getElementById('yolo-conf-val');
    if (yoloSlider) {
        yoloSlider.addEventListener('input', (e) => {
            if (yoloVal) yoloVal.textContent = parseFloat(e.target.value).toFixed(2);
        });
        yoloSlider.addEventListener('change', async () => {
            if (window.analyzer.originalImage) {
                await window.analyzer.detectImpactShots();
                window.analyzer.calculateAdvancedStats();
                const previewCheckbox = document.getElementById('manual-warp-preview');
                const isWarped = previewCheckbox ? previewCheckbox.checked : false;
                if (isWarped || !window.analyzer.isWarpModeActive) {
                    window.analyzer.renderWarpedCanvas();
                } else {
                    window.analyzer.renderCalibrationCanvas();
                }
                window.analyzer.updateStatsUI();
                window.analyzer.renderShotsTableUI();
            }
        });
    }

    // YOLO IoU NMS slider triggers
    const yoloIouSlider = document.getElementById('yolo-iou-threshold');
    const yoloIouVal = document.getElementById('yolo-iou-val');
    if (yoloIouSlider) {
        yoloIouSlider.addEventListener('input', (e) => {
            if (yoloIouVal) yoloIouVal.textContent = parseFloat(e.target.value).toFixed(2);
        });
        yoloIouSlider.addEventListener('change', async () => {
            if (window.analyzer.originalImage) {
                await window.analyzer.detectImpactShots();
                window.analyzer.calculateAdvancedStats();
                const previewCheckbox = document.getElementById('manual-warp-preview');
                const isWarped = previewCheckbox ? previewCheckbox.checked : false;
                if (isWarped || !window.analyzer.isWarpModeActive) {
                    window.analyzer.renderWarpedCanvas();
                } else {
                    window.analyzer.renderCalibrationCanvas();
                }
                window.analyzer.updateStatsUI();
                window.analyzer.renderShotsTableUI();
            }
        });
    }

    // Unit system recalculation trigger
    const unitSelector = document.getElementById('unit-system');
    if (unitSelector) {
        unitSelector.addEventListener('change', () => {
            if (window.app && window.app.currentMode === 'analyzer') {
                window.analyzer.updateStatsUI();
                window.analyzer.renderShotsTableUI();
                window.analyzer.renderWarpedCanvas();
            }
        });
    }

    // Sensitivity and parameter slider event bindings
    const sensitivitySlider = document.getElementById('analyzer-sensitivity');
    const sensitivityVal = document.getElementById('analyzer-sensitivity-val');
    if (sensitivitySlider) {
        sensitivitySlider.addEventListener('input', (e) => {
            const sens = parseInt(e.target.value);
            if (sensitivityVal) sensitivityVal.textContent = sens;
            
            // Dynamically adjust child parameters: Threshold and Circularity
            const calcThresh = Math.max(5, Math.round(45 - (sens * 0.3)));
            const calcCirc = parseFloat((0.80 - (sens * 0.0045)).toFixed(2));
            
            const thresholdSlider = document.getElementById('analyzer-threshold');
            if (thresholdSlider) {
                thresholdSlider.value = calcThresh;
                document.getElementById('analyzer-threshold-val').textContent = calcThresh;
            }
            const circularitySlider = document.getElementById('analyzer-circularity');
            if (circularitySlider) {
                circularitySlider.value = calcCirc;
                document.getElementById('analyzer-circularity-val').textContent = calcCirc.toFixed(2);
            }
        });
        
        sensitivitySlider.addEventListener('change', async () => {
            if (window.analyzer.originalImage) {
                await window.analyzer.detectImpactShots();
                window.analyzer.calculateAdvancedStats();
                const previewCheckbox = document.getElementById('manual-warp-preview');
                const isWarped = previewCheckbox ? previewCheckbox.checked : false;
                if (isWarped || !window.analyzer.isWarpModeActive) {
                    window.analyzer.renderWarpedCanvas();
                } else {
                    window.analyzer.renderCalibrationCanvas();
                }
                window.analyzer.updateStatsUI();
                window.analyzer.renderShotsTableUI();
            }
        });
    }

    const thresholdSlider = document.getElementById('analyzer-threshold');
    const thresholdVal = document.getElementById('analyzer-threshold-val');
    if (thresholdSlider) {
        thresholdSlider.addEventListener('input', (e) => {
            thresholdVal.textContent = e.target.value;
        });
        thresholdSlider.addEventListener('change', async () => {
            if (window.analyzer.originalImage) {
                await window.analyzer.detectImpactShots();
                window.analyzer.calculateAdvancedStats();
                const previewCheckbox = document.getElementById('manual-warp-preview');
                const isWarped = previewCheckbox ? previewCheckbox.checked : false;
                if (isWarped || !window.analyzer.isWarpModeActive) {
                    window.analyzer.renderWarpedCanvas();
                } else {
                    window.analyzer.renderCalibrationCanvas();
                }
                window.analyzer.updateStatsUI();
                window.analyzer.renderShotsTableUI();
            }
        });
    }

    const circularitySlider = document.getElementById('analyzer-circularity');
    const circularityVal = document.getElementById('analyzer-circularity-val');
    if (circularitySlider) {
        circularitySlider.addEventListener('input', (e) => {
            circularityVal.textContent = parseFloat(e.target.value).toFixed(2);
        });
        circularitySlider.addEventListener('change', async () => {
            if (window.analyzer.originalImage) {
                await window.analyzer.detectImpactShots();
                window.analyzer.calculateAdvancedStats();
                const previewCheckbox = document.getElementById('manual-warp-preview');
                const isWarped = previewCheckbox ? previewCheckbox.checked : false;
                if (isWarped || !window.analyzer.isWarpModeActive) {
                    window.analyzer.renderWarpedCanvas();
                } else {
                    window.analyzer.renderCalibrationCanvas();
                }
                window.analyzer.updateStatsUI();
                window.analyzer.renderShotsTableUI();
            }
        });
    }

    // Debug Toggles
    const debugIds = ['debug-threshold', 'debug-edge', 'debug-contour', 'debug-accepted', 'debug-rejected', 'debug-confidence', 'debug-perspective-trace'];
    debugIds.forEach(id => {
        const checkbox = document.getElementById(id);
        if (checkbox) {
            checkbox.addEventListener('change', () => {
                if (window.analyzer.originalImage) {
                    const previewCheckbox = document.getElementById('manual-warp-preview');
                    const isWarped = previewCheckbox ? previewCheckbox.checked : false;
                    if (isWarped || !window.analyzer.isWarpModeActive) {
                        window.analyzer.renderWarpedCanvas();
                    } else {
                        window.analyzer.renderCalibrationCanvas();
                    }
                }
            });
        }
    });

    // Calibration settings selections
    const targetTypeSelect = document.getElementById('target-type-select');
    if (targetTypeSelect) {
        targetTypeSelect.addEventListener('change', async (e) => {
            window.analyzer.currentSession.targetType = e.target.value;
            if (e.target.value === 'custom') {
                document.getElementById('custom-target-properties').style.display = 'block';
            } else {
                document.getElementById('custom-target-properties').style.display = 'none';
            }
            if (window.analyzer.originalImage) {
                await window.analyzer.detectImpactShots();
                window.analyzer.calculateAdvancedStats();
                window.analyzer.renderWarpedCanvas();
                window.analyzer.updateStatsUI();
                window.analyzer.renderShotsTableUI();
            }
        });
    }

    const adjustCalibrationToggle = document.getElementById('adjust-calibration-toggle');
    if (adjustCalibrationToggle) {
        adjustCalibrationToggle.addEventListener('change', async (e) => {
            if (!window.analyzer.originalImage) {
                alert("Please upload a target image first.");
                e.target.checked = false;
                return;
            }
            const isChecked = e.target.checked;
            if (isChecked) {
                window.analyzer.isCalibrating = true;
                window.analyzer.isWarpModeActive = true;
                window.analyzer.renderCalibrationCanvas();
                window.analyzer.showCornerPinsOverlay();
            } else {
                window.analyzer.isCalibrating = false;
                window.analyzer.isWarpModeActive = false;
                const pinsContainer = document.getElementById('warp-pins-container');
                if (pinsContainer) pinsContainer.style.display = 'none';
                await window.analyzer.applyWarpAndImpactDetection();
            }
        });
    }

    const warpPreviewToggle = document.getElementById('manual-warp-preview');
    if (warpPreviewToggle) {
        warpPreviewToggle.addEventListener('change', (e) => {
            const showWarped = e.target.checked;
            const pinsContainer = document.getElementById('warp-pins-container');
            
            if (showWarped) {
                // Hide pins when viewing warped result
                if (pinsContainer) pinsContainer.style.display = 'none';
                window.analyzer.renderWarpedCanvas();
            } else {
                // Show pins and original canvas when adjusting
                if (window.analyzer.isWarpModeActive) {
                    window.analyzer.showCornerPinsOverlay();
                    window.analyzer.renderCalibrationCanvas();
                }
            }
        });
    }

    // Set-Center mode toggle button
    const setCenterBtn = document.getElementById('set-center-btn');
    if (setCenterBtn) {
        setCenterBtn.addEventListener('click', () => {
            if (!window.analyzer.originalImage) return;
            window.analyzer.isSetCenterMode = !window.analyzer.isSetCenterMode;
            if (window.analyzer.isSetCenterMode) {
                setCenterBtn.classList.add('active');
                setCenterBtn.innerHTML = '<i class="fa-solid fa-xmark"></i> Cancel';
                const canvas = document.getElementById('analyzer-canvas');
                if (canvas) canvas.style.cursor = 'none';
                window.analyzer.renderWarpedCanvas();
            } else {
                setCenterBtn.classList.remove('active');
                setCenterBtn.innerHTML = '<i class="fa-solid fa-crosshairs"></i> Set Center';
                const canvas = document.getElementById('analyzer-canvas');
                if (canvas) canvas.style.cursor = 'crosshair';
                window.analyzer.renderWarpedCanvas();
            }
        });
    }

    const rerunBtn = document.getElementById('rerun-analysis');
    if (rerunBtn) {
        rerunBtn.addEventListener('click', async () => {
            if (window.analyzer.originalImage) {
                await window.analyzer.applyWarpAndImpactDetection();
            }
        });
    }

    const analyzeTargetBtn = document.getElementById('analyze-target-btn');
    if (analyzeTargetBtn) {
        analyzeTargetBtn.addEventListener('click', async () => {
            if (window.analyzer.originalImage) {
                await window.analyzer.runAnalysis();
            }
        });
    }

    const manualApplyBtn = document.getElementById('manual-apply-btn');
    if (manualApplyBtn) {
        manualApplyBtn.addEventListener('click', () => {
            window.analyzer.applyManualEntry();
        });
    }

    // Exporters
    document.getElementById('analyzer-export-csv').addEventListener('click', () => window.analyzer.exportCSV());
    document.getElementById('analyzer-export-json').addEventListener('click', () => window.analyzer.exportJSON());
    const yoloExportBtn = document.getElementById('analyzer-export-yolo');
    if (yoloExportBtn) {
        yoloExportBtn.addEventListener('click', () => window.analyzer.exportYOLOAnnotations());
    }
    
    const hitlSaveBtn = document.getElementById('analyzer-save-hitl-main');
    if (hitlSaveBtn) {
        hitlSaveBtn.addEventListener('click', () => {
            window.analyzer.cacheManualHoles();
            alert("Manual edits and hole corrections saved successfully! When you re-upload this exact image, these holes will be restored automatically.");
        });
    }

    const hitlSaveBtnRight = document.getElementById('analyzer-save-hitl-right');
    if (hitlSaveBtnRight) {
        hitlSaveBtnRight.addEventListener('click', () => {
            window.analyzer.cacheManualHoles();
            alert("Manual edits and hole corrections saved successfully! When you re-upload this exact image, these holes will be restored automatically.");
        });
    }

    document.getElementById('analyzer-export-pdf').addEventListener('click', () => window.analyzer.exportPDFCoachingReport());

    // Comparison actions
    const runCompBtn = document.getElementById('run-comparison');
    if (runCompBtn) {
        runCompBtn.addEventListener('click', () => window.analyzer.runComparison());
    }

    // Save Session btn
    const saveBtn = document.getElementById('save-session-btn');
    const saveName = document.getElementById('new-session-name');
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            if (window.analyzer.currentSession.shots.length === 0) {
                alert("Cannot save an empty session. Detect shots first.");
                return;
            }
            await window.analyzer.saveSession(saveName.value);
            saveName.value = "";
            alert("Session saved successfully to history.");
        });
    }

    const clearAllBtn = document.getElementById('clear-all-sessions');
    if (clearAllBtn) {
        clearAllBtn.addEventListener('click', async () => {
            if (confirm("Delete all saved analysis sessions from history?")) {
                await window.analyzer.clearAllSessions();
            }
        });
    }
});
