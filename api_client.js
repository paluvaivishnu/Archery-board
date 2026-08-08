/* ==========================================================
   API CLIENT — Bridge between Bullseye AI frontend and 
   the Python YOLOv11 scoring backend.
   
   Replaces client-side OpenCV/ONNX detection with server-side
   YOLOv11 inference for accurate hole detection and 2-decimal
   precision scoring.
   ========================================================== */

class ScoringAPIClient {
    constructor(baseUrl = 'http://127.0.0.1:8000') {
        this.baseUrl = baseUrl;
        this.isHealthy = false;
        this.lastHealthCheck = null;
    }

    /**
     * Check if the backend server is running and model is loaded.
     * @returns {Promise<{ok: boolean, detail: object}>}
     */
    async checkHealth() {
        try {
            const response = await fetch(`${this.baseUrl}/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(5000),
            });
            if (response.ok) {
                const data = await response.json();
                this.isHealthy = true;
                this.lastHealthCheck = new Date();
                return { ok: true, detail: data };
            }
            this.isHealthy = false;
            return { ok: false, detail: { error: `Server returned ${response.status}` } };
        } catch (err) {
            this.isHealthy = false;
            return { ok: false, detail: { error: err.message } };
        }
    }

    /**
     * Send a target image to the backend for scoring.
     * 
     * @param {File|Blob} imageFile - The image file to analyze
     * @param {object} options - Optional settings
     * @param {boolean} options.debugCalib - Show calibration debug overlay
     * @returns {Promise<object>} Scoring results from the backend
     * 
     * Response shape:
     * {
     *   target_detected: boolean,
     *   target_center: [cx, cy],
     *   target_radius: number,
     *   calibration_source: string,
     *   arrows_count: number,
     *   arrows: [{ id, x, y, dist, score, ring, confidence }],
     *   shots: [{ x, y, score, ring, distancePx, distanceReal, type }],
     *   stats: { avgScore, extremeSpread, meanRadius, windage, elevation },
     *   annotated_image: "data:image/jpeg;base64,...",
     *   total_score: number,
     *   processing_time_ms: number,
     * }
     */
    async scoreImage(imageFile, options = {}) {
        const formData = new FormData();
        formData.append('file', imageFile);
        
        if (options.debugCalib) {
            formData.append('debug_calib', 'true');
        }

        const response = await fetch(`${this.baseUrl}/api/score`, {
            method: 'POST',
            body: formData,
        });

        if (!response.ok) {
            const errorText = await response.text();
            let detail;
            try {
                detail = JSON.parse(errorText).detail;
            } catch {
                detail = errorText;
            }
            throw new Error(`Scoring failed (${response.status}): ${detail}`);
        }

        return await response.json();
    }

    /**
     * Convenience: score from a canvas element (e.g., captured camera frame).
     * Converts the canvas to a Blob and sends it for scoring.
     * 
     * @param {HTMLCanvasElement} canvas 
     * @param {object} options
     * @returns {Promise<object>}
     */
    async scoreCanvas(canvas, options = {}) {
        return new Promise((resolve, reject) => {
            canvas.toBlob(async (blob) => {
                if (!blob) {
                    reject(new Error('Failed to convert canvas to image'));
                    return;
                }
                try {
                    const result = await this.scoreImage(blob, options);
                    resolve(result);
                } catch (err) {
                    reject(err);
                }
            }, 'image/jpeg', 0.95);
        });
    }

    /**
     * Score from a data URL (e.g., from FileReader).
     * 
     * @param {string} dataUrl 
     * @param {object} options
     * @returns {Promise<object>}
     */
    async scoreDataUrl(dataUrl, options = {}) {
        const response = await fetch(dataUrl);
        const blob = await response.blob();
        return this.scoreImage(blob, options);
    }
}

// Export as global singleton
window.scoringAPI = new ScoringAPIClient();
