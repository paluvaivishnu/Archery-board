/* ==========================================================
   BULLSEYE AI - WEB AUDIO IMPACT SOUND SYNTHESIZER
   ========================================================== */

class SoundEffects {
    constructor() {
        this.ctx = null;
        this.enabled = true;
    }

    init() {
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (this.ctx.state === 'suspended') {
            this.ctx.resume();
        }
    }

    play(type) {
        if (!this.enabled) return;
        
        try {
            this.init();
            
            // Generate synthetic physical sounds using Web Audio API nodes
            switch(type) {
                case 'bullet-9mm':
                case 'bullet-45acp':
                case 'bullet-22lr':
                    this.playBulletImpact();
                    break;
                case 'air-rifle':
                case 'shotgun-pellet':
                    this.playPelletImpact();
                    break;
                case 'arrow-carbon':
                    this.playArrowImpact();
                    break;
                case 'dart':
                    this.playDartImpact();
                    break;
                case 'custom':
                    this.playCustomImpact();
                    break;
                case 'miss':
                default:
                    this.playMissImpact();
                    break;
            }
        } catch(e) {
            console.warn("Failed to play audio impact: ", e);
        }
    }

    playBulletImpact() {
        const osc = this.ctx.createOscillator();
        const noise = this.createNoiseBufferNode();
        const oscGain = this.ctx.createGain();
        const noiseGain = this.ctx.createGain();
        const filter = this.ctx.createBiquadFilter();
        const mainGain = this.ctx.createGain();

        // Oscillators mix (impact shockwave)
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(140, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(40, this.ctx.currentTime + 0.12);

        oscGain.gain.setValueAtTime(0.65, this.ctx.currentTime);
        oscGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.15);

        // Noise element (splinter/metal resonance)
        noiseGain.gain.setValueAtTime(0.7, this.ctx.currentTime);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.35);

        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(600, this.ctx.currentTime);
        filter.frequency.exponentialRampToValueAtTime(150, this.ctx.currentTime + 0.3);
        filter.Q.value = 4.0;

        mainGain.gain.setValueAtTime(0.7, this.ctx.currentTime);
        mainGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.4);

        // Connections
        osc.connect(oscGain);
        oscGain.connect(mainGain);

        if (noise) {
            noise.connect(filter);
            filter.connect(noiseGain);
            noiseGain.connect(mainGain);
        }

        mainGain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.2);
        if (noise) {
            noise.start();
            noise.stop(this.ctx.currentTime + 0.4);
        }
    }

    playPelletImpact() {
        const osc = this.ctx.createOscillator();
        const oscGain = this.ctx.createGain();
        const highOsc = this.ctx.createOscillator();
        const highGain = this.ctx.createGain();
        const mainGain = this.ctx.createGain();

        // High frequency "ping" of small metal pellet on target plate
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(800, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(250, this.ctx.currentTime + 0.08);

        oscGain.gain.setValueAtTime(0.5, this.ctx.currentTime);
        oscGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.08);

        highOsc.type = 'sine';
        highOsc.frequency.setValueAtTime(3200, this.ctx.currentTime);
        highOsc.frequency.exponentialRampToValueAtTime(1500, this.ctx.currentTime + 0.04);

        highGain.gain.setValueAtTime(0.4, this.ctx.currentTime);
        highGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.04);

        mainGain.gain.setValueAtTime(0.5, this.ctx.currentTime);
        mainGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.12);

        osc.connect(oscGain);
        highOsc.connect(highGain);
        oscGain.connect(mainGain);
        highGain.connect(mainGain);
        
        mainGain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.1);
        highOsc.start();
        highOsc.stop(this.ctx.currentTime + 0.05);
    }

    playArrowImpact() {
        const osc = this.ctx.createOscillator();
        const oscGain = this.ctx.createGain();
        const lowVibe = this.ctx.createOscillator();
        const vibeGain = this.ctx.createGain();
        const filter = this.ctx.createBiquadFilter();
        const mainGain = this.ctx.createGain();

        // Deeper "thunk" resonance of arrow sinking into foam
        osc.type = 'sine';
        osc.frequency.setValueAtTime(100, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(50, this.ctx.currentTime + 0.12);

        oscGain.gain.setValueAtTime(0.8, this.ctx.currentTime);
        oscGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.15);

        // Residual target board vibration sound
        lowVibe.type = 'triangle';
        lowVibe.frequency.setValueAtTime(65, this.ctx.currentTime);
        // Add frequency modulation to sound like string rattle
        lowVibe.frequency.linearRampToValueAtTime(55, this.ctx.currentTime + 0.35);

        vibeGain.gain.setValueAtTime(0.4, this.ctx.currentTime);
        vibeGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.4);

        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(120, this.ctx.currentTime);

        mainGain.gain.setValueAtTime(0.8, this.ctx.currentTime);
        mainGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.45);

        osc.connect(oscGain);
        lowVibe.connect(filter);
        filter.connect(vibeGain);
        
        oscGain.connect(mainGain);
        vibeGain.connect(mainGain);

        mainGain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.18);
        lowVibe.start();
        lowVibe.stop(this.ctx.currentTime + 0.45);
    }

    playDartImpact() {
        const osc = this.ctx.createOscillator();
        const oscGain = this.ctx.createGain();
        const highOsc = this.ctx.createOscillator();
        const highGain = this.ctx.createGain();
        const mainGain = this.ctx.createGain();

        // Sharp dart hit on sisal board (wood/dry texture)
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(350, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(80, this.ctx.currentTime + 0.05);

        oscGain.gain.setValueAtTime(0.6, this.ctx.currentTime);
        oscGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.06);

        highOsc.type = 'triangle';
        highOsc.frequency.setValueAtTime(1500, this.ctx.currentTime);
        highOsc.frequency.exponentialRampToValueAtTime(600, this.ctx.currentTime + 0.02);

        highGain.gain.setValueAtTime(0.35, this.ctx.currentTime);
        highGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.02);

        mainGain.gain.setValueAtTime(0.6, this.ctx.currentTime);
        mainGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.08);

        osc.connect(oscGain);
        highOsc.connect(highGain);
        oscGain.connect(mainGain);
        highGain.connect(mainGain);

        mainGain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.07);
        highOsc.start();
        highOsc.stop(this.ctx.currentTime + 0.03);
    }

    playCustomImpact() {
        const osc = this.ctx.createOscillator();
        const oscGain = this.ctx.createGain();
        const mainGain = this.ctx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(250, this.ctx.currentTime);
        osc.frequency.exponentialRampToValueAtTime(60, this.ctx.currentTime + 0.15);

        oscGain.gain.setValueAtTime(0.5, this.ctx.currentTime);
        oscGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.15);

        mainGain.gain.setValueAtTime(0.5, this.ctx.currentTime);
        mainGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.2);

        osc.connect(oscGain);
        oscGain.connect(mainGain);
        mainGain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.2);
    }

    playMissImpact() {
        const osc = this.ctx.createOscillator();
        const oscGain = this.ctx.createGain();
        const filter = this.ctx.createBiquadFilter();
        const mainGain = this.ctx.createGain();

        // Lower frequency dull "thud" with heavy lowpass (hitting wood support or back wall)
        osc.type = 'sine';
        osc.frequency.setValueAtTime(90, this.ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(45, this.ctx.currentTime + 0.22);

        oscGain.gain.setValueAtTime(0.9, this.ctx.currentTime);
        oscGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.25);

        filter.type = 'lowpass';
        filter.frequency.value = 85;

        mainGain.gain.setValueAtTime(0.7, this.ctx.currentTime);
        mainGain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + 0.3);

        osc.connect(filter);
        filter.connect(oscGain);
        oscGain.connect(mainGain);
        
        mainGain.connect(this.ctx.destination);

        osc.start();
        osc.stop(this.ctx.currentTime + 0.28);
    }

    createNoiseBufferNode() {
        if (!this.ctx) return null;
        const bufferSize = this.ctx.sampleRate * 0.5; // 0.5 seconds buffer
        const buffer = this.ctx.createBuffer(1, bufferSize, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        
        // Populate with white noise values
        for (let i = 0; i < bufferSize; i++) {
            data[i] = Math.random() * 2 - 1;
        }

        const noiseNode = this.ctx.createBufferSource();
        noiseNode.buffer = buffer;
        return noiseNode;
    }
}

// Instantiate globally
window.soundEffects = new SoundEffects();
