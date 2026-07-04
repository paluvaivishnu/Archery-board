/* ==========================================================
   BULLSEYE AI - INTERACTIVE TARGET CORE APPLICATION SCRIPT
   ========================================================== */

// Shared target drawing function (accessible by dataset generator)
window.drawTargetFace = function(ctx, scale = 1.0) {
    const cx = 450 * scale;
    const cy = 450 * scale;
    
    // Ring profiles: radius, fill color, text color, border color, name, score
    const rings = [
        { r: 440, fill: '#FFFFFF', text: '#2B2B2B', border: '#D0D4DC', name: 'MISS', score: 0 },
        { r: 400, fill: '#F5F5F5', text: '#2B2B2B', border: '#D0D4DC', name: '10', score: 10 },
        { r: 360, fill: '#F5F5F5', text: '#2B2B2B', border: '#D0D4DC', name: '9', score: 9 },
        { r: 320, fill: '#1E1E1E', text: '#FFFFFF', border: '#444444', name: '8', score: 8 },
        { r: 280, fill: '#1E1E1E', text: '#FFFFFF', border: '#444444', name: '7', score: 7 },
        { r: 240, fill: '#0066CC', text: '#FFFFFF', border: '#004A99', name: '6', score: 6 },
        { r: 200, fill: '#0066CC', text: '#FFFFFF', border: '#004A99', name: '5', score: 5 },
        { r: 160, fill: '#D11919', text: '#FFFFFF', border: '#A60000', name: '4', score: 4 },
        { r: 120, fill: '#D11919', text: '#FFFFFF', border: '#A60000', name: '3', score: 3 },
        { r: 80, fill: '#FFE600', text: '#2B2B2B', border: '#C0B000', name: '2', score: 2 },
        { r: 40, fill: '#FFE600', text: '#2B2B2B', border: '#C0B000', name: '1', score: 1 }
    ];

    // White backing
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.arc(cx, cy, 450 * scale, 0, Math.PI * 2);
    ctx.fill();

    // Concentric rings from outer to inner
    rings.forEach(ring => {
        ctx.beginPath();
        ctx.arc(cx, cy, ring.r * scale, 0, Math.PI * 2);
        ctx.fillStyle = ring.fill;
        ctx.fill();
        
        ctx.strokeStyle = ring.border;
        ctx.lineWidth = Math.max(1, 1.5 * scale);
        ctx.stroke();
    });

    // Sub-crosshairs
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
    ctx.lineWidth = Math.max(0.5, 0.75 * scale);
    ctx.beginPath();
    ctx.moveTo(cx, cy - 440 * scale);
    ctx.lineTo(cx, cy + 440 * scale);
    ctx.moveTo(cx - 440 * scale, cy);
    ctx.lineTo(cx + 440 * scale, cy);
    ctx.stroke();

    // Divider accent line inside black rings
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    ctx.lineWidth = Math.max(1, 1 * scale);
    ctx.beginPath();
    ctx.arc(cx, cy, 280 * scale, 0, Math.PI * 2);
    ctx.stroke();
};


class BullseyeApp {
    constructor() {
        this.canvas = document.getElementById('target-canvas');
        this.ctx = this.canvas.getContext('2d');
        
        // App States
        this.shots = [];
        this.currentMode = 'simulator'; 
        this.projectileRadius = 2.25; // default pellet size
        this.unitScale = 1.0; 
        this.unitName = 'px';
        this.scoringRule = 'line-cutter';
        this.heatmapActive = false;
        this.draggedShotIndex = null;

        this.init();
    }

    init() {
        this.registerEvents();
        this.renderTarget();
        this.updateStats();
    }

    registerEvents() {
        // Tab switching
        const tabBtns = document.querySelectorAll('.app-tabs .tab-btn');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const tab = btn.getAttribute('data-tab');
                this.switchTab(tab);
            });
        });

        // Toggle Theme
        const themeToggle = document.getElementById('theme-toggle');
        if (themeToggle) {
            themeToggle.addEventListener('click', () => {
                document.body.classList.toggle('dark-theme');
                const icon = themeToggle.querySelector('i');
                if (document.body.classList.contains('dark-theme')) {
                    icon.className = 'fa-solid fa-sun';
                } else {
                    icon.className = 'fa-solid fa-moon';
                }
                this.renderTarget();
            });
        }

        // Projectile Type selection
        const projSelect = document.getElementById('projectile-type');
        projSelect.addEventListener('change', (e) => {
            const opt = e.target.options[e.target.selectedIndex];
            if (e.target.value === 'custom') {
                document.getElementById('custom-radius-group').style.display = 'flex';
                this.projectileRadius = parseFloat(document.getElementById('custom-radius').value);
            } else {
                document.getElementById('custom-radius-group').style.display = 'none';
                this.projectileRadius = parseFloat(opt.getAttribute('data-radius'));
            }
            this.recalculateAllShots();
        });

        // Custom Radius slider
        const customRadSlider = document.getElementById('custom-radius');
        const customRadVal = document.getElementById('custom-radius-val');
        customRadSlider.addEventListener('input', (e) => {
            customRadVal.textContent = parseFloat(e.target.value).toFixed(1) + 'px';
            this.projectileRadius = parseFloat(e.target.value);
            this.recalculateAllShots();
        });

        // Scoring Rules
        const ruleSelect = document.getElementById('scoring-rule');
        ruleSelect.addEventListener('change', (e) => {
            this.scoringRule = e.target.value;
            this.recalculateAllShots();
        });

        // Measurement Units
        const unitSelect = document.getElementById('unit-system');
        unitSelect.addEventListener('change', (e) => {
            this.unitName = e.target.value;
            if (this.unitName === 'px') this.unitScale = 1.0;
            else if (this.unitName === 'mm') this.unitScale = 1.0; 
            else if (this.unitName === 'cm') this.unitScale = 0.1; 
            else if (this.unitName === 'in') this.unitScale = 0.03937; 
            
            this.recalculateAllShots();
        });

        // Audio Toggle
        const soundToggle = document.getElementById('sound-toggle');
        soundToggle.addEventListener('change', (e) => {
            if (window.soundEffects) {
                window.soundEffects.enabled = e.target.checked;
            }
        });

        // Clear Board
        document.getElementById('clear-board').addEventListener('click', () => {
            this.shots = [];
            this.renderTarget();
            this.updateStats();
            this.renderShotLog();
        });

        // Random Shot
        document.getElementById('add-random-shot').addEventListener('click', () => {
            this.addRandomShot();
        });

        // Heatmap toggle
        const heatmapBtn = document.getElementById('toggle-heatmap');
        heatmapBtn.addEventListener('click', () => {
            this.heatmapActive = !this.heatmapActive;
            heatmapBtn.className = this.heatmapActive ? 'btn btn-primary' : 'btn btn-secondary';
            heatmapBtn.innerHTML = `<i class="fa-solid fa-fire"></i> Heatmap: ${this.heatmapActive ? 'On' : 'Off'}`;
            this.renderTarget();
        });

        // Exporters
        document.getElementById('export-csv').addEventListener('click', () => this.exportCSV());
        document.getElementById('export-image').addEventListener('click', () => this.exportImage());

        // Target Board clicks and dragging events
        this.canvas.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        this.canvas.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.canvas.addEventListener('mouseup', (e) => this.handleMouseUp(e));
        this.canvas.addEventListener('mouseleave', () => {
            document.getElementById('magnifier').style.display = 'none';
        });


    }

    switchTab(tab) {
        if (tab === 'generator') return; // Handled by generator script opening modal
        this.currentMode = tab;
        const tabBtns = document.querySelectorAll('.app-tabs .tab-btn');
        tabBtns.forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
        });

        // Hide all sidebars, viewports, and stats dashboards
        document.getElementById('simulator-sidebar-content').style.display = 'none';
        document.getElementById('analyzer-sidebar-content').style.display = 'none';
        document.getElementById('comparison-sidebar-content').style.display = 'none';

        document.getElementById('viewport-simulator').style.display = 'none';
        document.getElementById('viewport-analyzer').style.display = 'none';
        document.getElementById('viewport-comparison').style.display = 'none';

        document.getElementById('simulator-stats-dashboard').style.display = 'none';
        document.getElementById('simulator-history-section').style.display = 'none';
        document.getElementById('analyzer-stats-dashboard').style.display = 'none';
        document.getElementById('analyzer-history-section').style.display = 'none';
        document.getElementById('comparison-stats-dashboard').style.display = 'none';

        // Show the selected mode components
        if (tab === 'simulator') {
            document.getElementById('simulator-sidebar-content').style.display = 'flex';
            document.getElementById('viewport-simulator').style.display = 'block';
            document.getElementById('simulator-stats-dashboard').style.display = 'block';
            document.getElementById('simulator-history-section').style.display = 'block';
            this.renderTarget();
        } else if (tab === 'analyzer') {
            document.getElementById('analyzer-sidebar-content').style.display = 'flex';
            document.getElementById('viewport-analyzer').style.display = 'block';
            document.getElementById('analyzer-stats-dashboard').style.display = 'block';
            document.getElementById('analyzer-history-section').style.display = 'block';
            
            // Initialize analyzer if not already done
            if (window.analyzer && typeof window.analyzer.activate === 'function') {
                window.analyzer.activate();
            }
        } else if (tab === 'comparison') {
            document.getElementById('comparison-sidebar-content').style.display = 'flex';
            document.getElementById('viewport-comparison').style.display = 'block';
            document.getElementById('comparison-stats-dashboard').style.display = 'block';
            
            // Refresh sessions dropdown
            if (window.analyzer && typeof window.analyzer.populateComparisonDropdowns === 'function') {
                window.analyzer.populateComparisonDropdowns();
            }
        }
    }

    // Mathematical coordinate calculations (Euclidean & decimal ratios)
    calculateScoreAndDistance(x, y) {
        let center = { x: 450, y: 450 };
        const dx = x - center.x;
        const dy = y - center.y;
        const distPx = Math.sqrt(Math.pow(dx, 2) + Math.pow(dy, 2));

        // Handle line cutter rules
        let scoringDistance = distPx;
        if (this.scoringRule === 'line-cutter') {
            scoringDistance = Math.max(0, distPx - this.projectileRadius);
        }

        // Determine score using Euclidean distance logic
        let score = 0;
        if (scoringDistance <= 440) {
            score = 11 - (scoringDistance / 40);
        }

        // Restrict bounds
        if (score < 1.0) score = 0.0;
        if (score > 10.9) score = 10.9;

        // Convert units
        const distReal = distPx * this.unitScale;

        return {
            distancePx: distPx,
            distanceReal: distReal,
            score: score
        };
    }

    recalculateAllShots() {
        this.shots.forEach(shot => {
            const math = this.calculateScoreAndDistance(shot.x, shot.y);
            shot.score = math.score;
            shot.distanceReal = math.distanceReal;
            shot.distancePx = math.distancePx;
        });
        
        this.renderTarget();
        this.updateStats();
        this.renderShotLog();
    }

    addShot(x, y) {
        const math = this.calculateScoreAndDistance(x, y);
        const newShot = {
            id: Date.now() + Math.random().toString(36).substr(2, 5),
            x: x,
            y: y,
            distancePx: math.distancePx,
            distanceReal: math.distanceReal,
            score: math.score,
            radius: this.projectileRadius,
            timestamp: new Date()
        };

        this.shots.push(newShot);
        
        // Play Audio Feedback
        if (window.soundEffects) {
            const projType = document.getElementById('projectile-type').value;
            window.soundEffects.play(math.score > 0 ? projType : 'miss');
        }

        this.renderTarget();
        this.updateStats();
        this.renderShotLog();
    }

    addRandomShot() {
        const r = Math.random() * 420;
        const theta = Math.random() * Math.PI * 2;
        const cx = 450;
        const cy = 450;
        const x = cx + r * Math.cos(theta);
        const y = cy + r * Math.sin(theta);
        this.addShot(x, y);
    }

    deleteShot(id) {
        this.shots = this.shots.filter(shot => shot.id !== id);
        this.renderTarget();
        this.updateStats();
        this.renderShotLog();
    }

    // Main Renderer Loop
    renderTarget() {
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // Draw vector target face
        window.drawTargetFace(this.ctx, 1.0);

        // Draw Heatmap Overlay if active
        if (this.heatmapActive && this.shots.length > 0) {
            this.renderHeatmap();
        }

        // Draw Placed Shot Circles
        this.shots.forEach((shot, idx) => {
            this.ctx.save();
            
            // Outer shadow torn paper margin
            this.ctx.beginPath();
            this.ctx.arc(shot.x, shot.y, shot.radius, 0, Math.PI * 2);
            this.ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
            this.ctx.fill();
            this.ctx.strokeStyle = 'rgba(255, 255, 255, 0.4)';
            this.ctx.lineWidth = 1.5;
            this.ctx.stroke();

            // Inner lead strike core
            this.ctx.beginPath();
            this.ctx.arc(shot.x, shot.y, shot.radius * 0.4, 0, Math.PI * 2);
            this.ctx.fillStyle = '#333333';
            this.ctx.fill();

            // Shot index tag with score
            this.ctx.font = 'bold 9px var(--font-mono)';
            this.ctx.fillStyle = '#ffffff';
            this.ctx.textAlign = 'center';
            this.ctx.textBaseline = 'middle';
            this.ctx.shadowColor = 'black';
            this.ctx.shadowBlur = 4;
            const scoreVal = (shot.score !== undefined && shot.score !== null) ? shot.score : 0.0;
            const scoreText = `${idx + 1} (${scoreVal.toFixed(1)})`;
            this.ctx.fillText(scoreText, shot.x + shot.radius * 1.8, shot.y - shot.radius * 1.8);
            
            this.ctx.restore();
        });
    }

    renderHeatmap() {
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = this.canvas.width;
        tempCanvas.height = this.canvas.height;
        const tempCtx = tempCanvas.getContext('2d');

        // Draw radial gradients on temp canvas
        this.shots.forEach(shot => {
            const rad = 65; 
            const grad = tempCtx.createRadialGradient(shot.x, shot.y, 0, shot.x, shot.y, rad);
            grad.addColorStop(0, 'rgba(0, 0, 0, 1)'); 
            grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
            tempCtx.fillStyle = grad;
            tempCtx.beginPath();
            tempCtx.arc(shot.x, shot.y, rad, 0, Math.PI * 2);
            tempCtx.fill();
        });

        // Overlay heatmap color gradient map
        const imgData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
        const data = imgData.data;

        for (let i = 0; i < data.length; i += 4) {
            const alpha = data[i+3]; // retrieve density
            if (alpha > 0) {
                // Color mapping logic: Blue -> Green -> Yellow -> Red
                const ratio = alpha / 255;
                let r = 0, g = 0, b = 0;

                if (ratio < 0.25) {
                    // Blue to Cyan
                    b = 255;
                    g = Math.round(ratio * 4 * 255);
                } else if (ratio < 0.5) {
                    // Cyan to Green
                    g = 255;
                    b = Math.round((1.0 - (ratio - 0.25) * 4) * 255);
                } else if (ratio < 0.75) {
                    // Green to Yellow
                    g = 255;
                    r = Math.round((ratio - 0.5) * 4 * 255);
                } else {
                    // Yellow to Red
                    r = 255;
                    g = Math.round((1.0 - (ratio - 0.75) * 4) * 255);
                }

                data[i] = r;
                data[i+1] = g;
                data[i+2] = b;
                data[i+3] = Math.round(alpha * 0.55); // translucency
            }
        }

        tempCtx.putImageData(imgData, 0, 0);
        this.ctx.drawImage(tempCanvas, 0, 0);
    }

    // Magnifying Loupe rendering
    updateMagnifier(visualX, visualY, x, y) {
        const zoomCheckbox = document.getElementById('zoom-toggle').checked;
        const magnifier = document.getElementById('magnifier');
        
        if (!zoomCheckbox) {
            magnifier.style.display = 'none';
            return;
        }

        magnifier.style.display = 'block';
        
        // Position magnifier 25px offset to top-right of cursor
        const lensOffset = 25;
        magnifier.style.left = (visualX + lensOffset) + 'px';
        magnifier.style.top = (visualY - magnifier.offsetHeight - lensOffset) + 'px';

        const magCanvas = document.getElementById('magnifier-canvas');
        const magCtx = magCanvas.getContext('2d');
        magCtx.clearRect(0, 0, magCanvas.width, magCanvas.height);

        // Crop 60x60px region from canvas, scale up to 120x120px
        const cropSize = 60;
        const size = 120;
        magCtx.drawImage(this.canvas, x - cropSize/2, y - cropSize/2, cropSize, cropSize, 0, 0, size, size);

        // Draw center crosshairs on magnifier lens
        magCtx.strokeStyle = 'rgba(239, 68, 68, 0.8)'; // Red crosshair
        magCtx.lineWidth = 1;
        magCtx.beginPath();
        magCtx.moveTo(size/2, 0);
        magCtx.lineTo(size/2, size);
        magCtx.moveTo(0, size/2);
        magCtx.lineTo(size, size/2);
        magCtx.stroke();
    }

    getCanvasCoordinates(e) {
        const rect = this.canvas.getBoundingClientRect();
        const visualX = e.clientX - rect.left;
        const visualY = e.clientY - rect.top;
        
        // Translate to backing canvas dimensions
        const x = (visualX / rect.width) * this.canvas.width;
        const y = (visualY / rect.height) * this.canvas.height;
        return { visualX, visualY, x, y };
    }

    handleMouseDown(e) {
        const coords = this.getCanvasCoordinates(e);

        // Check if user clicked on an existing shot to drag it
        const clickRadius = 15; // picking offset buffer
        const hitIdx = this.shots.findIndex(shot => {
            const dx = coords.x - shot.x;
            const dy = coords.y - shot.y;
            return Math.sqrt(dx*dx + dy*dy) < (shot.radius + clickRadius);
        });

        if (hitIdx !== -1) {
            this.draggedShotIndex = hitIdx;
            this.canvas.style.cursor = 'grabbing';
        } else {
            this.addShot(coords.x, coords.y);
        }
    }

    handleMouseMove(e) {
        const coords = this.getCanvasCoordinates(e);

        // Hover trackers
        document.getElementById('track-x').textContent = Math.round(coords.x);
        document.getElementById('track-y').textContent = Math.round(coords.y);
        
        // Hover score bubble preview
        const hoverMath = this.calculateScoreAndDistance(coords.x, coords.y);
        const scoreText = hoverMath.score > 0 ? hoverMath.score.toFixed(2) : 'MISS';
        document.getElementById('hover-score').textContent = scoreText;

        // If dragging shot, update values
        if (this.draggedShotIndex !== null) {
            const shot = this.shots[this.draggedShotIndex];
            shot.x = coords.x;
            shot.y = coords.y;
            const newMath = this.calculateScoreAndDistance(coords.x, coords.y);
            shot.distancePx = newMath.distancePx;
            shot.distanceReal = newMath.distanceReal;
            shot.score = newMath.score;
            
            this.renderTarget();
            this.updateStats();
            this.renderShotLog();
        }

        this.updateMagnifier(coords.visualX, coords.visualY, coords.x, coords.y);
    }

    handleMouseUp() {
        if (this.draggedShotIndex !== null) {
            this.draggedShotIndex = null;
            this.canvas.style.cursor = 'crosshair';
        }
    }

    // Analytics dashboard statistics calculations
    updateStats() {
        const totalShots = this.shots.length;
        let totalScore = 0;
        let avgScore = 0;
        let extremeSpread = 0;
        let meanRadius = 0;
        let avgX = 0;
        let avgY = 0;

        if (totalShots > 0) {
            let sumDist = 0;
            let sumX = 0;
            let sumY = 0;

            this.shots.forEach(shot => {
                totalScore += shot.score;
                sumDist += shot.distanceReal;
                sumX += shot.x;
                sumY += shot.y;
            });

            avgScore = totalScore / totalShots;
            meanRadius = sumDist / totalShots;

            // Offset windage coordinates (relative to center)
            avgX = (sumX / totalShots) - 450;
            avgY = (sumY / totalShots) - 450;

            // Extreme Spread (max distance between any two shots)
            if (totalShots > 1) {
                let maxDist = 0;
                for (let i = 0; i < this.shots.length; i++) {
                    for (let j = i + 1; j < this.shots.length; j++) {
                        const dx = this.shots[i].x - this.shots[j].x;
                        const dy = this.shots[i].y - this.shots[j].y;
                        const d = Math.sqrt(dx*dx + dy*dy);
                        if (d > maxDist) maxDist = d;
                    }
                }
                extremeSpread = maxDist * this.unitScale;
            }
        }

        // Display results
        document.getElementById('stat-total-shots').textContent = totalShots;
        document.getElementById('stat-total-score').textContent = totalScore.toFixed(2);
        document.getElementById('stat-avg-score').textContent = avgScore.toFixed(2);
        document.getElementById('stat-extreme-spread').textContent = extremeSpread.toFixed(1) + ' ' + this.unitName;
        document.getElementById('stat-mean-radius').textContent = meanRadius.toFixed(1) + ' ' + this.unitName;
        
        const windageVal = document.getElementById('stat-windage');
        const windXSymbol = avgX >= 0 ? '+' : '';
        const windYSymbol = avgY >= 0 ? '+' : '';
        windageVal.textContent = `X: ${windXSymbol}${(avgX * this.unitScale).toFixed(1)}, Y: ${windYSymbol}${(avgY * this.unitScale).toFixed(1)} ${this.unitName}`;
    }

    renderShotLog() {
        const tbody = document.getElementById('shot-log-tbody');
        tbody.innerHTML = "";

        this.shots.forEach((shot, idx) => {
            const tr = document.createElement('tr');
            
            // Score ring color dot mapping
            let color = '#d97706'; // gold/yellow default
            if (shot.score >= 9) color = '#f5f5f5'; // white/grey
            else if (shot.score >= 7) color = '#1e1e1e'; // black
            else if (shot.score >= 5) color = '#2563eb'; // blue
            else if (shot.score >= 3) color = '#ef4444'; // red
            
            tr.innerHTML = `
                <td><strong>${idx + 1}</strong></td>
                <td>X: ${Math.round(shot.x)} | Y: ${Math.round(shot.y)}</td>
                <td>${shot.distanceReal.toFixed(1)} ${this.unitName}</td>
                <td><span class="ring-color-dot" style="background: ${color};"></span>${shot.score.toFixed(2)}</td>
                <td style="text-align: right;">
                    <button class="delete-shot-btn" data-id="${shot.id}"><i class="fa-solid fa-trash-can"></i></button>
                </td>
            `;

            // Delete specific button
            tr.querySelector('.delete-shot-btn').addEventListener('click', (e) => {
                const id = e.currentTarget.getAttribute('data-id');
                this.deleteShot(id);
            });

            tbody.appendChild(tr);
        });
    }

    exportCSV() {
        if (this.shots.length === 0) {
            alert("No shots to export.");
            return;
        }

        let csvContent = "data:text/csv;charset=utf-8,";
        csvContent += "Shot Number,X Coordinate,Y Coordinate,Distance (px),Distance (converted),Score,Timestamp\n";

        this.shots.forEach((shot, idx) => {
            csvContent += `${idx + 1},${shot.x.toFixed(1)},${shot.y.toFixed(1)},${shot.distancePx.toFixed(2)},${shot.distanceReal.toFixed(2)},${shot.score.toFixed(2)},${shot.timestamp.toISOString()}\n`;
        });

        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `bullseye_shot_log_${Date.now()}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    exportImage() {
        const link = document.createElement('a');
        link.download = `bullseye_target_capture_${Date.now()}.png`;
        link.href = this.canvas.toDataURL();
        link.click();
    }

}

// Instantiate globally when DOM loaded
document.addEventListener('DOMContentLoaded', () => {
    window.app = new BullseyeApp();
});
