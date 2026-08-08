import re

js_file = '/Users/vardhan/Documents/projects/Archery Board/image_analyzer.js'

with open(js_file, 'r') as f:
    content = f.read()

# Replace runAnalysis with a streamlined API call
new_run_analysis = """    async runAnalysis() {
        if (!this.originalImageBlob) {
            console.error("No image blob available for backend scoring");
            return;
        }

        const statusBadge = document.getElementById('analyzer-canvas-badge');
        const statusText = document.getElementById('analyzer-status-badge-text');
        if (statusBadge && statusText) {
            statusText.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Analyzing via Backend...`;
            statusBadge.className = "canvas-status-floating status-info";
            statusBadge.style.display = "block";
        }

        try {
            // Check if backend is available
            await window.scoringAPI.checkHealth();
            if (!window.scoringAPI.isHealthy) {
                throw new Error("Backend scoring server is not running at " + window.scoringAPI.baseUrl);
            }

            // Call the python backend API
            const result = await window.scoringAPI.scoreImage(this.originalImageBlob);
            
            // Map the results back to the frontend session state
            this.currentSession.shots = result.shots;
            this.currentSession.stats = result.stats;
            this.currentSession.stats.totalScore = result.total_score;
            this.currentSession.stats.totalShots = result.arrows_count;

            // Load the annotated image returned by the backend onto the canvas
            if (result.annotated_image) {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.getElementById('analyzer-canvas');
                    const ctx = canvas.getContext('2d');
                    canvas.width = img.width;
                    canvas.height = img.height;
                    ctx.drawImage(img, 0, 0);
                    
                    if (statusBadge && statusText) {
                        statusText.innerHTML = `<i class="fa-solid fa-check"></i> Analysis Complete`;
                        statusBadge.className = "canvas-status-floating status-success";
                        setTimeout(() => statusBadge.style.display = 'none', 3000);
                    }
                };
                img.src = result.annotated_image;
                this.currentSession.warpedImageBase64 = result.annotated_image; // Treat this as the display image
            }

            this.isWarpModeActive = false;
            this.isCalibrating = false;

            const previewGroup = document.getElementById('manual-warp-preview-group');
            if (previewGroup) previewGroup.style.display = 'none';
            const pinsContainer = document.getElementById('warp-pins-container');
            if (pinsContainer) pinsContainer.style.display = 'none';

            this.updateStatsUI();
            this.renderShotsTableUI();

        } catch (err) {
            console.error("Backend scoring failed:", err);
            if (statusBadge && statusText) {
                statusText.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> Error: ${err.message}`;
                statusBadge.className = "canvas-status-floating status-error";
            }
        }
    }"""

# Use regex to replace the function definition
content = re.sub(
    r'async runAnalysis\(\)\s*\{[\s\S]*?(?=\s+async runCVAnalysisPipeline\(\))',
    new_run_analysis + "\n\n",
    content
)

# Also capture the blob when adding files
# We need to find where originalImageBlob is set, or make sure we set it.
content = content.replace(
    'this.originalImage = img;',
    'this.originalImage = img;\n                    // Added for backend integration\n                    fetch(imgUrl).then(res => res.blob()).then(blob => { this.originalImageBlob = blob; });'
)

# Specifically for the file input
content = content.replace(
    'const file = files[0];',
    'const file = files[0];\n        this.originalImageBlob = file;'
)


with open(js_file, 'w') as f:
    f.write(content)

print("Replaced runAnalysis successfully.")
