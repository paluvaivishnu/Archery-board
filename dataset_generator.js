/* ==========================================================
   BULLSEYE AI - DATASET GENERATOR & YOLO ANNOTATION EXPORTER
   ========================================================== */

class DatasetGenerator {
    constructor() {
        this.zip = null;
        this.previewCanvas = document.getElementById('gen-preview-canvas');
        this.previewCtx = this.previewCanvas.getContext('2d');
        
        this.initializeEvents();
    }

    initializeEvents() {
        const runBtn = document.getElementById('run-generator');
        const downloadBtn = document.getElementById('download-dataset');
        const closeBtn = document.querySelector('.close-generator-btn');
        const tabBtn = document.querySelector('[data-tab="generator"]');
        const modal = document.getElementById('generator-modal');
        const shotsRange = document.getElementById('gen-shots-per-target');
        const shotsVal = document.getElementById('gen-shots-val');

        // Sync shots range slider label
        if (shotsRange && shotsVal) {
            shotsRange.addEventListener('input', (e) => {
                shotsVal.textContent = e.target.value;
            });
        }

        // Open modal when generator tab clicked
        if (tabBtn && modal) {
            tabBtn.addEventListener('click', () => {
                modal.style.display = 'flex';
                // Trigger an initial preview render
                this.generateSinglePreview();
            });
        }

        // Close modal
        if (closeBtn && modal) {
            closeBtn.addEventListener('click', () => {
                modal.style.display = 'none';
                // Switch tab back to simulator
                const simTab = document.querySelector('[data-tab="simulator"]');
                if (simTab) simTab.click();
            });
        }

        // Run generator
        if (runBtn) {
            runBtn.addEventListener('click', () => this.generateDataset());
        }

        // Download zip
        if (downloadBtn) {
            downloadBtn.addEventListener('click', () => this.downloadZip());
        }
    }

    // Generate single visual preview on the UI canvas
    generateSinglePreview() {
        const shotsCount = parseInt(document.getElementById('gen-shots-per-target').value) || 0;
        const noiseLevel = document.getElementById('gen-noise').value;
        const distortionType = document.getElementById('gen-distortion').value;
        const drawBoxes = document.getElementById('gen-yolo-draw').checked;

        // Render target onto the preview canvas (450x450px)
        const size = 450;
        this.previewCanvas.width = size;
        this.previewCanvas.height = size;
        this.previewCtx.clearRect(0, 0, size, size);

        // Generate synthetic target image parameters
        const params = this.drawSyntheticTarget(this.previewCtx, size, shotsCount, noiseLevel, distortionType);

        // If checkbox is ticked, draw bounding boxes around bullet holes
        if (drawBoxes && params.annotations.length > 0) {
            const colors = {
                0: '#3b82f6', // 9mm Bullet Hole (Blue)
                1: '#10b981', // .45 ACP Bullet Hole (Green)
                2: '#f59e0b', // .22 LR Bullet Hole (Orange)
                3: '#8b5cf6', // Shotgun Pellet (Purple)
                4: '#ef4444'  // Bullseye (Red)
            };
            
            const classNames = {
                0: '9mm_bullet',
                1: '45acp_bullet',
                2: '22lr_bullet',
                3: 'shotgun_pellet',
                4: 'bullseye'
            };

            this.previewCtx.lineWidth = 1.5;
            params.annotations.forEach(ann => {
                // YOLO annotations are: class_id, x_center, y_center, width, height (normalized)
                const w = ann.w * size;
                const h = ann.h * size;
                const x = (ann.x * size) - (w / 2);
                const y = (ann.y * size) - (h / 2);
                
                this.previewCtx.strokeStyle = colors[ann.classId] || '#ffffff';
                this.previewCtx.strokeRect(x, y, w, h);
                
                // Draw label index
                this.previewCtx.fillStyle = colors[ann.classId] || '#ffffff';
                this.previewCtx.font = 'bold 8px var(--font-mono)';
                this.previewCtx.fillText(`${ann.classId}: ${classNames[ann.classId]}`, x, y - 3);
            });
        }

        // Render annotations inside the preview box
        const previewCode = document.getElementById('yolo-annotations-preview');
        if (previewCode) {
            if (params.annotations.length === 0) {
                previewCode.textContent = "// Target is clean. No shots detected.";
            } else {
                let codeStr = "";
                params.annotations.forEach(ann => {
                    codeStr += `${ann.classId} ${ann.x.toFixed(6)} ${ann.y.toFixed(6)} ${ann.w.toFixed(6)} ${ann.h.toFixed(6)}\n`;
                });
                previewCode.textContent = codeStr;
            }
        }
    }

    // Main draw algorithm for synthetic targets (supports noise & perspective skews)
    drawSyntheticTarget(ctx, size, shotsCount, noiseLevel, distortionType) {
        ctx.save();

        const cx = size / 2;
        const cy = size / 2;
        
        // 1. Draw solid background
        ctx.fillStyle = '#f1f5f9'; // off-white
        ctx.fillRect(0, 0, size, size);

        // Apply transformations if distortion is set
        if (distortionType !== 'none') {
            ctx.translate(cx, cy);
            
            // Random mild rotation
            const maxAngle = distortionType === 'mild' ? 0.08 : 0.25; // radians
            const angle = (Math.random() * 2 - 1) * maxAngle;
            ctx.rotate(angle);

            // Random skew/scale (perspective simulation)
            const skewFactor = distortionType === 'mild' ? 0.04 : 0.15;
            const skewX = (Math.random() * 2 - 1) * skewFactor;
            const skewY = (Math.random() * 2 - 1) * skewFactor;
            ctx.transform(1, skewY, skewX, 1, 0, 0);

            ctx.translate(-cx, -cy);
        }

        // 2. Draw standard concentric rings
        const baseScale = size / 900; // standard backing is 900px
        const rings = [
            { r: 440, fill: '#FFFFFF', border: '#cbd5e1' },
            { r: 400, fill: '#F1F5F9', border: '#cbd5e1' },
            { r: 360, fill: '#F1F5F9', border: '#cbd5e1' },
            { r: 320, fill: '#1E293B', border: '#334155' },
            { r: 280, fill: '#1E293B', border: '#334155' },
            { r: 240, fill: '#2563EB', border: '#1D4ED8' },
            { r: 200, fill: '#2563EB', border: '#1D4ED8' },
            { r: 160, fill: '#EF4444', border: '#DC2626' },
            { r: 120, fill: '#EF4444', border: '#DC2626' },
            { r: 80, fill: '#F59E0B', border: '#D97706' },
            { r: 40, fill: '#F59E0B', border: '#D97706' }
        ];

        rings.forEach(ring => {
            ctx.beginPath();
            ctx.arc(cx, cy, ring.r * baseScale, 0, Math.PI * 2);
            ctx.fillStyle = ring.fill;
            ctx.fill();
            ctx.strokeStyle = ring.border;
            ctx.lineWidth = 1;
            ctx.stroke();
        });

        // Sub-crosshairs
        ctx.strokeStyle = 'rgba(0,0,0,0.08)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(cx, cy - 440 * baseScale);
        ctx.lineTo(cx, cy + 440 * baseScale);
        ctx.moveTo(cx - 440 * baseScale, cy);
        ctx.lineTo(cx + 440 * baseScale, cy);
        ctx.stroke();

        // 3. Draw random shots and construct YOLO annotations
        const annotations = [];

        // Include bullseye center if checked
        const includeBullseyeEl = document.getElementById('gen-include-bullseye');
        const includeBullseye = includeBullseyeEl ? includeBullseyeEl.checked : true;
        if (includeBullseye) {
            let bx = 0.5;
            let by = 0.5;
            if (ctx.getTransform) {
                const matrix = ctx.getTransform();
                if (matrix && matrix.transformPoint) {
                    const pt = matrix.transformPoint({ x: cx, y: cy });
                    bx = pt.x / size;
                    by = pt.y / size;
                }
            }
            annotations.push({
                classId: 4, // Class 4: bullseye_center
                x: bx,
                y: by,
                w: 80 / 900,
                h: 80 / 900
            });
        }

        const impactTypeEl = document.getElementById('gen-impact-type');
        const impactType = impactTypeEl ? impactTypeEl.value : 'mixed';

        for (let i = 0; i < shotsCount; i++) {
            // Pick uniform random point on target face
            const r = Math.random() * 400 * baseScale;
            const theta = Math.random() * Math.PI * 2;
            const hx = cx + r * Math.cos(theta);
            const hy = cy + r * Math.sin(theta);

            // Determine class ID
            let itemClassId = 0;
            if (impactType === 'bullet_9mm') itemClassId = 0;
            else if (impactType === 'bullet_45acp') itemClassId = 1;
            else if (impactType === 'bullet_22lr') itemClassId = 2;
            else if (impactType === 'shotgun_pellet') itemClassId = 3;
            else {
                itemClassId = Math.floor(Math.random() * 4); // Class 0-3
            }

            // Determine size based on class
            let holeRadius = 6.5 * baseScale;
            if (itemClassId === 0) holeRadius = 8.5 * baseScale; // 9mm
            else if (itemClassId === 1) holeRadius = 11.5 * baseScale; // .45 ACP
            else if (itemClassId === 2) holeRadius = 5.6 * baseScale; // .22 LR
            else if (itemClassId === 3) holeRadius = 2.5 * baseScale; // Shotgun Pellet

            ctx.save();
            if (itemClassId === 0) {
                // Class 0: 9mm Bullet Hole (Medium grease ring)
                ctx.beginPath();
                ctx.arc(hx, hy, holeRadius * 1.35, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
                ctx.fill();

                ctx.beginPath();
                ctx.arc(hx, hy, holeRadius, 0, Math.PI * 2);
                ctx.fillStyle = '#090d16';
                ctx.fill();
            } else if (itemClassId === 1) {
                // Class 1: .45 ACP Bullet Hole (Large soot and lead-in ring)
                ctx.beginPath();
                ctx.arc(hx, hy, holeRadius * 1.45, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
                ctx.fill();

                ctx.beginPath();
                ctx.arc(hx, hy, holeRadius, 0, Math.PI * 2);
                ctx.fillStyle = '#05070a';
                ctx.fill();
            } else if (itemClassId === 2) {
                // Class 2: .22 LR Bullet Hole (Small grease ring)
                ctx.beginPath();
                ctx.arc(hx, hy, holeRadius * 1.3, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
                ctx.fill();

                ctx.beginPath();
                ctx.arc(hx, hy, holeRadius, 0, Math.PI * 2);
                ctx.fillStyle = '#0b0f1a';
                ctx.fill();
            } else if (itemClassId === 3) {
                // Class 3: Shotgun Pellet (Tiny marks, minimal ring)
                ctx.beginPath();
                ctx.arc(hx, hy, holeRadius * 1.25, 0, Math.PI * 2);
                ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
                ctx.fill();

                ctx.beginPath();
                ctx.arc(hx, hy, holeRadius, 0, Math.PI * 2);
                ctx.fillStyle = '#0e1219';
                ctx.fill();
            }

            // Tiny shatter ring margins
            ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
            ctx.lineWidth = 0.5;
            ctx.stroke();
            ctx.restore();

            // Calculate bounding box in canvas coordinates
            const bboxSize = (holeRadius * 2.8) / size; // normalized box size
            let nx = hx / size;
            let ny = hy / size;
            if (ctx.getTransform) {
                const matrix = ctx.getTransform();
                if (matrix && matrix.transformPoint) {
                    const pt = matrix.transformPoint({ x: hx, y: hy });
                    nx = pt.x / size;
                    ny = pt.y / size;
                }
            }

            annotations.push({
                classId: itemClassId,
                x: nx,
                y: ny,
                w: bboxSize,
                h: bboxSize
            });
        }

        ctx.restore();

        // 4. Apply pixel visual noise / paper texture
        if (noiseLevel !== 'clean') {
            const imgData = ctx.getImageData(0, 0, size, size);
            const data = imgData.data;
            let intensity = 10;
            if (noiseLevel === 'medium') intensity = 22;
            if (noiseLevel === 'high') intensity = 45;

            for (let j = 0; j < data.length; j += 4) {
                const noiseVal = (Math.random() - 0.5) * intensity;
                data[j] = Math.min(255, Math.max(0, data[j] + noiseVal));     // R
                data[j+1] = Math.min(255, Math.max(0, data[j+1] + noiseVal)); // G
                data[j+2] = Math.min(255, Math.max(0, data[j+2] + noiseVal)); // B
            }
            ctx.putImageData(imgData, 0, 0);
        }

        return { annotations };
    }

    validateAnnotations(annotations) {
        let errors = [];
        annotations.forEach((ann, idx) => {
            if (ann.classId < 0 || ann.classId > 4 || !Number.isInteger(ann.classId)) {
                errors.push(`Annotation ${idx}: Invalid classId ${ann.classId}`);
            }
            if (ann.x < 0 || ann.x > 1) {
                errors.push(`Annotation ${idx} (Class ${ann.classId}): x center ${ann.x.toFixed(4)} out of bounds [0, 1]`);
            }
            if (ann.y < 0 || ann.y > 1) {
                errors.push(`Annotation ${idx} (Class ${ann.classId}): y center ${ann.y.toFixed(4)} out of bounds [0, 1]`);
            }
            if (ann.w <= 0 || ann.w > 1) {
                errors.push(`Annotation ${idx} (Class ${ann.classId}): width ${ann.w.toFixed(4)} out of bounds (0, 1]`);
            }
            if (ann.h <= 0 || ann.h > 1) {
                errors.push(`Annotation ${idx} (Class ${ann.classId}): height ${ann.h.toFixed(4)} out of bounds (0, 1]`);
            }
        });
        return {
            isValid: errors.length === 0,
            errors: errors
        };
    }

    // Bulk dataset generation and packaging inside ZIP archive
    async generateDataset() {
        const runBtn = document.getElementById('run-generator');
        const downloadBtn = document.getElementById('download-dataset');
        
        runBtn.disabled = true;
        runBtn.innerHTML = `<i class="fa-solid fa-spinner animate-pulse"></i> Generating...`;

        try {
            const count = parseInt(document.getElementById('gen-images-count').value) || 10;
            const shotsCount = parseInt(document.getElementById('gen-shots-per-target').value) || 0;
            const noiseLevel = document.getElementById('gen-noise').value;
            const distortionType = document.getElementById('gen-distortion').value;

            this.zip = new JSZip();
            const imgFolder = this.zip.folder("dataset/images/train");
            const labelFolder = this.zip.folder("dataset/labels/train");

            // Create offscreen high-res canvas (900x900px)
            const offCanvas = document.createElement('canvas');
            offCanvas.width = 900;
            offCanvas.height = 900;
            const offCtx = offCanvas.getContext('2d');

            // Class distribution counters
            const classCounts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
            let totalAnnotationsCount = 0;
            let validatedCount = 0;
            let validationPass = true;

            for (let i = 1; i <= count; i++) {
                offCtx.clearRect(0, 0, 900, 900);
                const params = this.drawSyntheticTarget(offCtx, 900, shotsCount, noiseLevel, distortionType);

                // Validate generated labels
                const validation = this.validateAnnotations(params.annotations);
                if (!validation.isValid) {
                    validationPass = false;
                    console.error(`Validation failed for image ${i}:`, validation.errors);
                } else {
                    validatedCount++;
                }

                // Convert canvas to image blob (png)
                const imgBlob = await new Promise(resolve => offCanvas.toBlob(resolve, 'image/png'));
                const fileNum = String(i).padStart(3, '0');
                
                // Add png image to ZIP
                imgFolder.file(`target_${fileNum}.png`, imgBlob);

                // Add YOLO coordinates annotations to ZIP
                let annotationStr = "";
                params.annotations.forEach(ann => {
                    annotationStr += `${ann.classId} ${ann.x.toFixed(6)} ${ann.y.toFixed(6)} ${ann.w.toFixed(6)} ${ann.h.toFixed(6)}\n`;
                    classCounts[ann.classId]++;
                    totalAnnotationsCount++;
                });
                labelFolder.file(`target_${fileNum}.txt`, annotationStr);

                // Render first generated item on screen as live preview
                if (i === 1) {
                    this.generateSinglePreview();
                }
            }

            // Create dataset config yaml file in ZIP
            const dataYaml = 
`path: ../dataset
train: images/train
val: images/train

names:
  0: bullet-hole
  1: pellet-hole
  2: arrow-impact
  3: dart-impact
  4: bullseye-center
`;
            this.zip.file("dataset/data.yaml", dataYaml);

            // Update training dataset assistant stats in UI
            let statsDiv = document.getElementById('dataset-assistant-stats');
            if (!statsDiv) {
                const panel = document.getElementById('dataset-assistant-panel');
                statsDiv = document.createElement('div');
                statsDiv.id = 'dataset-assistant-stats';
                statsDiv.style.marginTop = '0.5rem';
                statsDiv.style.borderTop = '1px solid var(--border-color)';
                statsDiv.style.paddingTop = '0.5rem';
                statsDiv.innerHTML = `
                    <strong style="color: var(--text-primary);">Exported Class Distribution:</strong>
                    <div id="dataset-assistant-counts" style="font-family: var(--font-mono); margin-top: 0.25rem; color: #34d399; line-height: 1.4;"></div>
                `;
                panel.appendChild(statsDiv);
            }
            
            statsDiv.style.display = 'block';
            const countsDiv = document.getElementById('dataset-assistant-counts');
            if (countsDiv) {
                countsDiv.innerHTML = `
                    Bullet (Cls 0): ${classCounts[0]}<br>
                    Pellet (Cls 1): ${classCounts[1]}<br>
                    Arrow (Cls 2): ${classCounts[2]}<br>
                    Dart (Cls 3): ${classCounts[3]}<br>
                    Bullseye (Cls 4): ${classCounts[4]}<br>
                    <span style="color: ${validationPass ? '#10b981' : '#ef4444'}; font-weight: bold; margin-top: 0.25rem; display: inline-block;">
                        Label Validation: ${validationPass ? '✓ 100% Validated' : '✗ Errors in log'}
                    </span>
                `;
            }

            downloadBtn.disabled = false;
            alert(`Synthetic dataset successfully generated with ${count} target boards! Click 'Download Dataset' to save the ZIP file.`);
        } catch (err) {
            console.error(err);
            alert("An error occurred during dataset generation.");
        } finally {
            runBtn.disabled = false;
            runBtn.innerHTML = `<i class="fa-solid fa-play"></i> Generate Synthetic Dataset`;
        }
    }

    downloadZip() {
        if (!this.zip) return;
        this.zip.generateAsync({type: "blob"}).then(content => {
            const link = document.createElement('a');
            link.href = URL.createObjectURL(content);
            link.download = "archery_target_yolo_dataset.zip";
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        });
    }
}

// Instantiate globally when DOM loaded
document.addEventListener('DOMContentLoaded', () => {
    window.datasetGenerator = new DatasetGenerator();
});
