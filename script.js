'use strict';
/* ==========================================================================
   🖖 LCARS DEEP SPACE DIGITAL ANALYZER v3.0
   Audio engine + vizualizace ve stylu Audio Editoru (USS Prometheus)
   ========================================================================== */

const $ = (id) => document.getElementById(id);

const fileInput = $('fileInput');
const audioElement = $('mainAudio');
const toggle3DBtn = $('toggle3D');
const exportBtn = $('exportBtn');
const exportCsvBtn = $('exportCsvBtn');

/* --------------------------------------------------------------------------
   KONFIGURACE
   -------------------------------------------------------------------------- */

// 4 patra osciloskopu (pořadí a barvy podle původního analyzéru)

// Automatické zesílení: lane.gain je minimum, lane.cur aktuální hodnota, lane.maxGain strop
 

// Pásma pro radar
const RADAR_BANDS = [
    { label: 'Sub-Bass', f0: 20,    f1: 60 },
    { label: 'Bass',     f0: 60,    f1: 250 },
    { label: 'Low-Mid',  f0: 250,   f1: 500 },
    { label: 'Mid',      f0: 500,   f1: 2000 },
    { label: 'High-Mid', f0: 2000,  f1: 6000 },
    { label: 'Treble',   f0: 6000,  f1: 12000 },
    { label: 'Air',      f0: 12000, f1: 20000, trimDb: 12 }
];

// 8 pásem pro export
const REC_BANDS = [
    { key: 'subBass',    f0: 20,    f1: 60 },
    { key: 'bass',       f0: 60,    f1: 250 },
    { key: 'lowMid',     f0: 250,   f1: 500 },
    { key: 'mid',        f0: 500,   f1: 2000 },
    { key: 'highMid',    f0: 2000,  f1: 4000 },
    { key: 'presence',   f0: 4000,  f1: 6000 },
    { key: 'brilliance', f0: 6000,  f1: 12000 },
    { key: 'air',        f0: 12000, f1: 20000 }
];

const FFT_SIZE = 8192;      // hlavní analyser (4096 binů)
const TD_SIZE = 2048;       // L/R analysery
const SCOPE_SIZE = 1024;    // osciloskop pásem
const VU_FLOOR_DB = -60;

/* --------------------------------------------------------------------------
   STAV
   -------------------------------------------------------------------------- */

let audioContext = null, source = null;
let analyser = null, peakAnalyser = null, analyserLeft = null, analyserRight = null;
let isContextReady = false;

let specData = new Float32Array(FFT_SIZE / 2).fill(-120);
let tdL = new Float32Array(TD_SIZE);
let tdR = new Float32Array(TD_SIZE);
let tdPeak = new Float32Array(FFT_SIZE);

const scopeAnalysers = {};
const scopeBuffers = {};
 

let currentFileName = 'audio';
let currentUrl = null;

// Export
let exportData = [];
let recordingInterval = null;

// Smyčka
let rafId = null;
let lastTs = 0;
let frameCount = 0;
let lastL = { peak: 0, rms: 0 };
let lastR = { peak: 0, rms: 0 };

// 3D (zatím skryté, ve vývoji)
let show3D = false;
let scene3D = null, camera3D = null, renderer3D = null;
const bars3D = [];

/* --------------------------------------------------------------------------
   POMOCNÉ FUNKCE
   -------------------------------------------------------------------------- */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const toDb = (lin) => (lin > 1e-6 ? 20 * Math.log10(lin) : -Infinity);
const isLevel = (db) => Number.isFinite(db) && db > -150;
const fmtDb = (db, digits = 1) => (isLevel(db) ? db.toFixed(digits) : '-∞');
const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };

function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

function fmtTime(sec) {
    if (!Number.isFinite(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function fmtFreq(hz) {
    if (!hz) return '--- Hz';
    return hz >= 1000 ? `${(hz / 1000).toFixed(2)} kHz` : `${Math.round(hz)} Hz`;
}

function getBinHz() {
    return (audioContext ? audioContext.sampleRate : 44100) / FFT_SIZE;
}

// Peak a RMS z časové oblasti (lineární, 0..1)
function timeStats(buf) {
    let peak = 0, sum = 0;
    for (let i = 0; i < buf.length; i++) {
        const v = buf[i];
        const a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        sum += v * v;
    }
    return { peak, rms: Math.sqrt(sum / buf.length) };
}

// Průměrná energie pásma (výkonově) v dB
function bandPowerDb(spec, binHz, f0, f1) {
    const b0 = Math.max(1, Math.floor(f0 / binHz));
    const b1 = Math.min(spec.length - 1, Math.ceil(f1 / binHz));
    let sum = 0, count = 0;
    for (let b = b0; b <= b1; b++) {
        sum += Math.pow(10, spec[b] / 10);
        count++;
    }
    return count ? 10 * Math.log10(sum / count + 1e-20) : -Infinity;
}

// Peak frekvence a spektrální centroid z aktuálních dat
function analyseSpectrum() {
    const binHz = getBinHz();
    const start = Math.max(1, Math.floor(20 / binHz));
    let maxDb = -Infinity, maxBin = 0, sumP = 0, sumFP = 0;
    for (let b = start; b < specData.length; b++) {
        const d = specData[b];
        if (d > maxDb) { maxDb = d; maxBin = b; }
        const p = Math.pow(10, d / 10);
        sumP += p;
        sumFP += p * b * binHz;
    }
    return {
        peakFreq: maxDb > -85 ? maxBin * binHz : null,
        centroid: sumP > 1e-12 ? sumFP / sumP : null
    };
}

/* --------------------------------------------------------------------------
   WAVESURFER + RADAR
   -------------------------------------------------------------------------- */

const wavesurfer = WaveSurfer.create({
    container: '#waveform',
    waveColor: '#4477ff',
    progressColor: '#ffcc00',
    cursorColor: '#ff4444',
    barWidth: 3,
    barGap: 2,
    height: 120,
    media: audioElement
});

const radarChart = new Chart($('radarChart').getContext('2d'), {
    type: 'radar',
    data: {
        labels: RADAR_BANDS.map((b) => b.label),
        datasets: [{
            label: 'Aktuální Energie',
            data: RADAR_BANDS.map(() => 0),
            backgroundColor: 'rgba(255, 204, 0, 0.4)',
            borderColor: '#ffcc00',
            borderWidth: 2,
            pointRadius: 0
        }]
    },
    options: {
        scales: {
            r: {
                min: 0,
                max: 100,
                ticks: { display: false },
                grid: { color: '#333' },
                angleLines: { color: '#333' },
                pointLabels: { color: '#aaa' }
            }
        },
        plugins: { legend: { labels: { color: '#aaa' } } },
        animation: false,
        responsive: true,
        maintainAspectRatio: false
    }
});

function updateRadar() {
    const binHz = getBinHz();
    radarChart.data.datasets[0].data = RADAR_BANDS.map((b) =>
    clamp((bandPowerDb(specData, binHz, b.f0, b.f1) + (b.trimDb || 0) + 90) / 65, 0, 1) * 100
    );
    radarChart.update('none');
}

/* --------------------------------------------------------------------------
   SPEKTRUM RENDERER (převzato z Audio Editoru)
   Logaritmické seskupení FFT binů, LCARS barvy podle pásma,
   peak-hold čárky s gravitačním pádem.
   -------------------------------------------------------------------------- */

class SpectrumRenderer {
    constructor(canvas, opts = {}) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.bars = opts.bars || 48;
        this.fmin = opts.fmin || 30;
        this.fmax = opts.fmax || 18000;
        this.labels = opts.labels !== false;
        this.gap = opts.gap !== undefined ? opts.gap : 2;
        this.dbMin = -90;
        this.dbMax = -15;
        this.levels = new Float32Array(this.bars);
        this.peaks = new Float32Array(this.bars);
        this.vel = new Float32Array(this.bars);
        this.w = 1;
        this.h = 1;
        this.resize();
    }

    resize() {
        const dpr = window.devicePixelRatio || 1;
        const rect = this.canvas.getBoundingClientRect();
        this.w = Math.max(1, Math.round(rect.width));
        this.h = Math.max(1, Math.round(rect.height));
        this.canvas.width = Math.round(this.w * dpr);
        this.canvas.height = Math.round(this.h * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    clear() {
        this.ctx.clearRect(0, 0, this.w, this.h);
    }

    reset() {
        this.levels.fill(0);
        this.peaks.fill(0);
        this.vel.fill(0);
    }

    update(spec, binHz, dt) {
        const n = this.bars;
        const ratio = Math.pow(this.fmax / this.fmin, 1 / n);
        const k = dt * 60;
        for (let i = 0; i < n; i++) {
            const f0 = this.fmin * Math.pow(ratio, i);
            const f1 = f0 * ratio;
            const b0 = Math.min(spec.length - 1, Math.floor(f0 / binHz));
            const b1 = Math.min(spec.length - 1, Math.max(b0 + 1, Math.ceil(f1 / binHz)));
            let maxDb = -120;
            for (let b = b0; b <= b1; b++) {
                if (spec[b] > maxDb) maxDb = spec[b];
            }
            const target = clamp((maxDb - this.dbMin) / (this.dbMax - this.dbMin), 0, 1);
            const prev = this.levels[i];
            const lvl = target > prev ? target : prev * 0.82 + target * 0.18;
            this.levels[i] = lvl;

            // Peak-hold s gravitačním pádem
            if (lvl >= this.peaks[i]) {
                this.peaks[i] = lvl;
                this.vel[i] = 0;
            } else {
                this.vel[i] += 0.001 * k;
                this.peaks[i] = Math.max(0, this.peaks[i] - this.vel[i] * k);
            }
        }
    }

    drawBars(x, y, w, h) {
        const ctx = this.ctx;
        const labelH = this.labels ? 16 : 0;
        const plotH = Math.max(10, h - labelH);
        const maxBar = plotH * 0.95;
        const baseY = y + plotH;
        const n = this.bars;
        const bw = Math.max(1, (w - this.gap * (n - 1)) / n);

        ctx.save();
        ctx.font = '10px "JetBrains Mono", Consolas, monospace';

        // mřížka + dB popisky
        if (this.labels) {
            ctx.lineWidth = 1;
            for (const frac of [0.25, 0.5, 0.75]) {
                const gy = Math.round(baseY - frac * maxBar) + 0.5;
                ctx.strokeStyle = 'rgba(255,255,255,0.06)';
                ctx.beginPath();
                ctx.moveTo(x, gy);
                ctx.lineTo(x + w, gy);
                ctx.stroke();
            }
        }

        // 4 gradienty podle pásma (fialová → modrá → zlatá → oranžová, špička do červena)
        const bandLo = ['#5B4A73', '#2F5978', '#8A6F1E', '#8A4E10'];
        const bandHi = ['#C297D8', '#6FA8DC', '#FFD34D', '#FF9F1C'];
        const grads = bandLo.map((lo, idx) => {
            const g = ctx.createLinearGradient(0, baseY, 0, baseY - maxBar);
            g.addColorStop(0, lo);
            g.addColorStop(0.55, bandHi[idx]);
            g.addColorStop(0.9, bandHi[idx]);
            g.addColorStop(1, '#ff4757');
            return g;
        });

        for (let i = 0; i < n; i++) {
            const t = i / n;
            const band = t < 0.25 ? 0 : t < 0.55 ? 1 : t < 0.8 ? 2 : 3;
            const bh = this.levels[i] * maxBar;
            const bx = x + i * (bw + this.gap);
            ctx.fillStyle = grads[band];
            ctx.fillRect(bx, baseY - bh, bw, bh);

            const ph = this.peaks[i] * maxBar;
            if (ph > 1) {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(bx, baseY - ph - 2, bw, 2);
            }
        }

        // dB popisky až nad sloupci, na tmavém podkladu, ať je nic nezakrývá
        if (this.labels) {
            ctx.textAlign = 'left';
            for (const frac of [0.25, 0.5, 0.75]) {
                const gy = Math.round(baseY - frac * maxBar) + 0.5;
                const txt = `${Math.round(this.dbMin + frac * (this.dbMax - this.dbMin))} dB`;
                const tw = ctx.measureText(txt).width;
                ctx.fillStyle = 'rgba(5,5,7,0.75)';
                ctx.fillRect(x + 1, gy - 13, tw + 6, 12);
                ctx.fillStyle = '#8a8a8a';
                ctx.fillText(txt, x + 4, gy - 3);
            }
        }

        // popisky frekvencí
        if (this.labels) {
            ctx.fillStyle = '#777';
            ctx.textAlign = 'center';
            const span = Math.log(this.fmax / this.fmin);
            for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
                if (f < this.fmin || f > this.fmax) continue;
                const px = x + (Math.log(f / this.fmin) / span) * w;
                ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, px, y + h - 3);
            }
        }
        ctx.restore();
    }
}

const mainSpec = new SpectrumRenderer($('spectrumCanvas'), { bars: 48, fmin: 30, fmax: 18000, labels: true, gap: 2 });
const miniSpec = new SpectrumRenderer($('miniSpectrumCanvas'), { bars: 32, fmin: 30, fmax: 16000, labels: false, gap: 1 });

function drawMainCanvas() {
    const s = mainSpec;
    const ctx = s.ctx;
    const w = s.w, h = s.h;
    s.clear();

    const specH = Math.round(h * 0.5);
    s.drawBars(0, 0, w, specH);

    // oddělovač
    ctx.save();
    ctx.strokeStyle = '#26282e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, specH + 4.5);
    ctx.lineTo(w, specH + 4.5);
    ctx.stroke();
    ctx.restore();

    // osciloskop - 4 patra se svitem
    const top = specH + 8;
    const laneH = (h - top - 2) / SCOPE_LANES.length;
    SCOPE_LANES.forEach((lane, i) => {
        const cy = top + laneH * (i + 0.5);
        const half = Math.max(2, laneH / 2 - 2);
        const buf = scopeBuffers[lane.key];
        const step = w / (buf.length - 1);

        ctx.save();
        ctx.strokeStyle = 'rgba(255,255,255,0.07)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, cy);
        ctx.lineTo(w, cy);
        ctx.stroke();

        ctx.shadowColor = lane.color;
        ctx.shadowBlur = 6;
        ctx.strokeStyle = lane.color;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        for (let j = 0; j < buf.length; j++) {
            const v = clamp(((buf[j] - 128) / 128) * lane.cur, -1, 1);
            const px = j * step;
            const py = cy - v * half;
            if (j === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.stroke();
        ctx.restore();

        ctx.save();
        ctx.fillStyle = lane.color;
        ctx.font = '600 11px "JetBrains Mono", Consolas, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(lane.label, 6, top + laneH * i + 12);
        ctx.restore();
    });
}

function drawAll() {
    drawMainCanvas();
    miniSpec.clear();
    miniSpec.drawBars(0, 0, miniSpec.w, miniSpec.h);
}

/* --------------------------------------------------------------------------
   VU METRY (RMS z časové oblasti + peak-hold značka)
   -------------------------------------------------------------------------- */

const VU = {
    L: { barId: 'vuLeft',  textId: 'vuLeftText',  boxId: 'vuLeftContainer',  shown: VU_FLOOR_DB, peak: VU_FLOOR_DB, hold: 0, marker: null },
    R: { barId: 'vuRight', textId: 'vuRightText', boxId: 'vuRightContainer', shown: VU_FLOOR_DB, peak: VU_FLOOR_DB, hold: 0, marker: null }
};

Object.values(VU).forEach((v) => {
    const box = $(v.boxId);
    if (box) {
        v.marker = document.createElement('div');
        v.marker.className = 'vu-peak';
        box.appendChild(v.marker);
    }
});

function paintVU(v) {
    const pct = clamp((v.shown - VU_FLOOR_DB) / -VU_FLOOR_DB, 0, 1) * 100;
    const bar = $(v.barId);
    if (bar) {
        bar.style.height = pct + '%';
        bar.style.background = v.shown > -6 ? '#ff0000'
            : v.shown > -12 ? '#ff9900'
            : v.shown > -20 ? '#ffff00'
            : '#00ff00';
    }
    setText(v.textId, v.shown <= VU_FLOOR_DB + 0.05 ? '-∞ dB' : v.shown.toFixed(1) + ' dB');
    if (v.marker) {
        if (v.peak <= VU_FLOOR_DB + 0.5) {
            v.marker.style.display = 'none';
        } else {
            v.marker.style.display = 'block';
            v.marker.style.bottom = clamp((v.peak - VU_FLOOR_DB) / -VU_FLOOR_DB, 0, 1) * 100 + '%';
        }
    }
}

function updateVU(v, rmsDb, peakDb, dt) {
    const target = isLevel(rmsDb) ? Math.max(VU_FLOOR_DB, rmsDb) : VU_FLOOR_DB;
    v.shown = target > v.shown ? target : Math.max(target, v.shown - 40 * dt);

    const pk = isLevel(peakDb) ? Math.max(VU_FLOOR_DB, peakDb) : VU_FLOOR_DB;
    if (pk >= v.peak) {
        v.peak = pk;
        v.hold = 1.0;
    } else if (v.hold > 0) {
        v.hold -= dt;
    } else {
        v.peak = Math.max(pk, v.peak - 20 * dt);
    }
    paintVU(v);
}

function resetVU() {
    Object.values(VU).forEach((v) => {
        v.shown = VU_FLOOR_DB;
        v.peak = VU_FLOOR_DB;
        v.hold = 0;
        paintVU(v);
    });
}

/* --------------------------------------------------------------------------
   INFO PANEL
   -------------------------------------------------------------------------- */

function updateInfoPanel() {
    const rmsLin = Math.sqrt((lastL.rms * lastL.rms + lastR.rms * lastR.rms) / 2);
    const peakLin = Math.max(lastL.peak, lastR.peak);
    const sp = analyseSpectrum();

    setText('peakFreq', fmtFreq(sp.peakFreq));
    setText('centroid', fmtFreq(sp.centroid));
    setText('curTime', fmtTime(audioElement.currentTime));
    setText('rmsLevel', fmtDb(toDb(rmsLin)) + ' dBFS');
    setText('peakLevel', fmtDb(toDb(peakLin)) + ' dBFS');

    if (lastL.rms > 1e-6 && lastR.rms > 1e-6) {
        const bal = 20 * Math.log10(lastL.rms / lastR.rms);
        setText('balance', Math.abs(bal) < 0.3 ? '0.0 dB (střed)' : `${bal > 0 ? 'L' : 'R'} ${Math.abs(bal).toFixed(1)} dB`);
    } else {
        setText('balance', '---');
    }
}

function resetInfoPanel() {
    setText('peakFreq', '--- Hz');
    setText('centroid', '--- Hz');
    setText('curTime', fmtTime(audioElement.currentTime || 0));
    setText('rmsLevel', '-∞ dBFS');
    setText('peakLevel', '-∞ dBFS');
    setText('balance', '---');
}

/* --------------------------------------------------------------------------
   AUDIO ENGINE
   -------------------------------------------------------------------------- */

function setupAudioChain() {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();

    // Hlavní analyser - spektrum v dB
    analyser = audioContext.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.smoothingTimeConstant = 0.7;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -10;
    specData = new Float32Array(analyser.frequencyBinCount);

    // Peak analyser - skutečné vzorky pro true peak
    peakAnalyser = audioContext.createAnalyser();
    peakAnalyser.fftSize = FFT_SIZE;
    peakAnalyser.smoothingTimeConstant = 0;
    tdPeak = new Float32Array(peakAnalyser.fftSize);

    // L/R analysery
    analyserLeft = audioContext.createAnalyser();
    analyserLeft.fftSize = TD_SIZE;
    analyserRight = audioContext.createAnalyser();
    analyserRight.fftSize = TD_SIZE;
    tdL = new Float32Array(TD_SIZE);
    tdR = new Float32Array(TD_SIZE);

    source = audioContext.createMediaElementSource(audioElement);

    // Filtrační kaskáda pro 4 patra osciloskopu
    const createBranch = (key, type, freq, Q = 1) => {
        const filter = audioContext.createBiquadFilter();
        filter.type = type;
        filter.frequency.value = freq;
        filter.Q.value = Q;
        const ana = audioContext.createAnalyser();
        ana.fftSize = SCOPE_SIZE;
        source.connect(filter);
        filter.connect(ana);
        scopeAnalysers[key] = ana;
    };
    createBranch('bass',   'lowpass',  150);
    createBranch('mid',    'bandpass', 500);
    createBranch('vocals', 'bandpass', 1500, 2);
    createBranch('high',   'highpass', 5000);

    // Přehrávání + analýza
    source.connect(analyser);
    analyser.connect(audioContext.destination);
    source.connect(peakAnalyser);

    // Stereo: mono zdroj se upmixuje na L=R, ať pravý VU metr nezůstane prázdný
    const stereoUp = audioContext.createGain();
    stereoUp.channelCount = 2;
    stereoUp.channelCountMode = 'explicit';
    stereoUp.channelInterpretation = 'speakers';
    const splitter = audioContext.createChannelSplitter(2);
    source.connect(stereoUp);
    stereoUp.connect(splitter);
    splitter.connect(analyserLeft, 0);
    splitter.connect(analyserRight, 1);

    setText('sampleRate', audioContext.sampleRate + ' Hz');
}

/* --------------------------------------------------------------------------
   3D (ve vývoji - tlačítko je skryté)
   -------------------------------------------------------------------------- */

function setup3D() {
    const container = $('threeContainer');
    if (typeof THREE === 'undefined' || !container || !container.clientWidth || !container.clientHeight) return false;

    scene3D = new THREE.Scene();
    camera3D = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
    renderer3D = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer3D.setSize(container.clientWidth, container.clientHeight);
    renderer3D.setClearColor(0x000000, 0);
    container.appendChild(renderer3D.domElement);
    camera3D.position.z = 50;

    for (let i = 0; i < 32; i++) {
        const bar = new THREE.Mesh(
            new THREE.BoxGeometry(1, 1, 1),
            new THREE.MeshBasicMaterial({ color: 0xffcc00 })
        );
        const angle = (i / 32) * Math.PI * 2;
        bar.position.x = Math.cos(angle) * 15;
        bar.position.z = Math.sin(angle) * 15;
        scene3D.add(bar);
        bars3D.push(bar);
    }
    return true;
}

toggle3DBtn.addEventListener('click', () => {
    if (!show3D && !renderer3D && !setup3D()) return;
    show3D = !show3D;
    toggle3DBtn.textContent = `3D View: ${show3D ? 'ON' : 'OFF'}`;
    toggle3DBtn.classList.toggle('active');
});

function render3D() {
    if (!show3D || !renderer3D) return;
    for (let i = 0; i < bars3D.length; i++) {
        const bin = Math.round(Math.pow(i / bars3D.length, 2) * 255) + 1;
        const v = clamp((specData[bin] + 100) / 85, 0, 1);
        bars3D[i].scale.y = 1 + v * 30;
        bars3D[i].material.color.setHSL(v * 0.6, 1, 0.5);
    }
    scene3D.rotation.y += 0.005;
    renderer3D.render(scene3D, camera3D);
}

/* --------------------------------------------------------------------------
   RENDER SMYČKA
   -------------------------------------------------------------------------- */

function renderFrame(dt) {
    frameCount++;

    analyser.getFloatFrequencyData(specData);
    analyserLeft.getFloatTimeDomainData(tdL);
    analyserRight.getFloatTimeDomainData(tdR);

    lastL = timeStats(tdL);
    lastR = timeStats(tdR);
    updateVU(VU.L, toDb(lastL.rms), toDb(lastL.peak), dt);
    updateVU(VU.R, toDb(lastR.rms), toDb(lastR.peak), dt);

    const binHz = getBinHz();
    mainSpec.update(specData, binHz, dt);
    miniSpec.update(specData, binHz, dt);

    SCOPE_LANES.forEach((lane) => {
        const ana = scopeAnalysers[lane.key];
        if (!ana) return;
        const buf = scopeBuffers[lane.key];
        ana.getByteTimeDomainData(buf);

        // Auto-gain: tichá pásma se zvětší, hlasitá se hned stáhnou (nic nepřetéká)
        let dev = 0;
        for (let i = 0; i < buf.length; i++) {
            const d = Math.abs(buf[i] - 128) / 128;
            if (d > dev) dev = d;
        }
        const target = clamp(0.75 / Math.max(dev, 0.015), lane.gain, lane.maxGain);
        lane.cur = target < lane.cur ? target : lane.cur + (target - lane.cur) * 0.04;
    });

    drawAll();

    if (frameCount % 3 === 0) updateRadar();
    if (frameCount % 6 === 0) updateInfoPanel();
    render3D();
}

function tick(ts) {
    rafId = null;
    if (audioElement.paused) return;
    const dt = Math.min(0.1, Math.max(0.001, (ts - lastTs) / 1000));
    lastTs = ts;
    renderFrame(dt);
    rafId = requestAnimationFrame(tick);
}

function startLoop() {
    if (rafId) return;
    lastTs = performance.now();
    rafId = requestAnimationFrame(tick);
}

function resetVisuals() {
    resetVU();
    mainSpec.reset();
    miniSpec.reset();
    SCOPE_LANES.forEach((lane) => { scopeBuffers[lane.key].fill(128); lane.cur = lane.gain; });
    radarChart.data.datasets[0].data = RADAR_BANDS.map(() => 0);
    radarChart.update('none');
    resetInfoPanel();
    drawAll();
}

/* --------------------------------------------------------------------------
   ZÁZNAM DAT PRO EXPORT (přesný interval 100 ms)
   -------------------------------------------------------------------------- */

function recordSnapshot(time) {
    if (!analyser) return;

    analyser.getFloatFrequencyData(specData);
    peakAnalyser.getFloatTimeDomainData(tdPeak);
    analyserLeft.getFloatTimeDomainData(tdL);
    analyserRight.getFloatTimeDomainData(tdR);

    const binHz = getBinHz();
    const bands = {};
    REC_BANDS.forEach((b) => { bands[b.key] = bandPowerDb(specData, binHz, b.f0, b.f1); });

    const pk = timeStats(tdPeak);
    const l = timeStats(tdL);
    const r = timeStats(tdR);

    const rmsLin = Math.sqrt((l.rms * l.rms + r.rms * r.rms) / 2);
    const peakLin = Math.max(pk.peak, l.peak, r.peak);

    exportData.push({
        t: time,
        bands,
        rms: toDb(rmsLin),
        peak: toDb(peakLin),
        crest: rmsLin > 1e-6 ? peakLin / rmsLin : 0,
        peakFreq: analyseSpectrum().peakFreq,
        balance: (l.rms > 1e-6 && r.rms > 1e-6) ? 20 * Math.log10(l.rms / r.rms) : 0
    });
}

function startRecording() {
    stopRecording();
    recordingInterval = setInterval(() => {
        if (!audioElement.paused) recordSnapshot(audioElement.currentTime);
    }, 100);
}

function stopRecording() {
    if (recordingInterval) {
        clearInterval(recordingInterval);
        recordingInterval = null;
    }
}

/* --------------------------------------------------------------------------
   UDÁLOSTI PŘEHRÁVAČE
   -------------------------------------------------------------------------- */

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;

    stopRecording();
    exportData = [];
    currentFileName = file.name;

    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = URL.createObjectURL(file);
    audioElement.src = currentUrl;
    resetVisuals();

    try {
        Promise.resolve(wavesurfer.load(currentUrl)).catch((err) => console.warn('Waveform:', err));
    } catch (err) {
        console.warn('Waveform:', err);
    }
});

audioElement.addEventListener('loadedmetadata', () => {
    setText('duration', fmtTime(audioElement.duration));
    if (audioContext) setText('sampleRate', audioContext.sampleRate + ' Hz');
});

audioElement.addEventListener('play', async () => {
    if (!isContextReady) {
        try {
            setupAudioChain();
            isContextReady = true;
        } catch (err) {
            console.error('Chyba audio řetězce:', err);
            alert('Nepodařilo se spustit audio engine: ' + err.message);
            return;
        }
    }
    if (audioContext.state === 'suspended') await audioContext.resume();

    // Navazujeme na dosavadní záznam; po přetočení zpět se přepíše jen novější část
    exportData = exportData.filter((d) => d.t < audioElement.currentTime - 0.05);
    startRecording();
    startLoop();
});

audioElement.addEventListener('pause', stopRecording);

audioElement.addEventListener('ended', () => {
    stopRecording();
    resetVisuals();
});

audioElement.addEventListener('seeked', () => {
    exportData = exportData.filter((d) => d.t < audioElement.currentTime);
    setText('curTime', fmtTime(audioElement.currentTime));
});

/* --------------------------------------------------------------------------
   RESPONZIVITA CANVASU
   -------------------------------------------------------------------------- */

function onCanvasResize() {
    mainSpec.resize();
    miniSpec.resize();
    drawAll();
}

if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(onCanvasResize);
    ro.observe($('spectrogramPlot'));
    ro.observe($('d3_viz'));
} else {
    window.addEventListener('resize', onCanvasResize);
}

/* --------------------------------------------------------------------------
   EXPORT (HTML report + CSV)
   -------------------------------------------------------------------------- */

function baseFileName() {
    return currentFileName.replace(/\.[^.]+$/, '') || 'audio';
}

function downloadBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

exportBtn.addEventListener('click', () => {
    if (exportData.length === 0) {
        alert('Nejdřív přehraj audio soubor pro záznam dat!');
        return;
    }
    const html = generateExportHTML(currentFileName);
    downloadBlob(new Blob([html], { type: 'text/html' }), `${baseFileName()}_analysis.html`);
});

exportCsvBtn.addEventListener('click', () => {
    if (exportData.length === 0) {
        alert('Nejdřív přehraj audio soubor pro záznam dat!');
        return;
    }
    const num = (v, d = 2) => (isLevel(v) ? v.toFixed(d) : '');
    const head = ['time_s', ...REC_BANDS.map((b) => b.key + '_dB'), 'rms_dBFS', 'peak_dBFS', 'crest_factor', 'peak_freq_Hz', 'stereo_balance_dB'];
    const rows = exportData.map((d) => [
        d.t.toFixed(2),
        ...REC_BANDS.map((b) => num(d.bands[b.key])),
        num(d.rms),
        num(d.peak),
        d.crest.toFixed(2),
        d.peakFreq ? Math.round(d.peakFreq) : '',
        d.balance.toFixed(2)
    ].join(','));
    const csv = '﻿' + [head.join(','), ...rows].join('\n');
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), `${baseFileName()}_analysis.csv`);
});

function generateExportHTML(fileName) {
    const rmsVals = exportData.map((d) => d.rms).filter(isLevel);
    const peakVals = exportData.map((d) => d.peak).filter(isLevel);
    const crestVals = exportData.map((d) => d.crest).filter((v) => v > 0);

    const avgRms = rmsVals.length
        ? 10 * Math.log10(rmsVals.reduce((a, v) => a + Math.pow(10, v / 10), 0) / rmsVals.length)
        : -Infinity;
    const maxPeak = peakVals.reduce((a, v) => Math.max(a, v), -Infinity);
    const avgCrest = crestVals.length ? crestVals.reduce((a, v) => a + v, 0) / crestVals.length : 0;

    // Dynamický rozsah hlasitosti: P95 - P10 z RMS v čase
    let dynRange = null;
    if (rmsVals.length >= 10) {
        const sorted = [...rmsVals].sort((a, b) => a - b);
        const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
        dynRange = q(0.95) - q(0.10);
    }

    const levelColor = (db) => {
        if (!isLevel(db)) return 'color: #333;';
        if (db > -6) return 'color: #ff0000; font-weight: bold;';
        if (db > -12) return 'color: #ff4444;';
        if (db > -18) return 'color: #ff9900;';
        if (db > -30) return 'color: #ffcc00;';
        return 'color: #00ff00;';
    };
    const bandColor = (db) => {
        if (!isLevel(db)) return 'color: #333;';
        if (db > -20) return 'color: #ff0000; font-weight: bold;';
        if (db > -30) return 'color: #ff4444;';
        if (db > -42) return 'color: #ff9900;';
        if (db > -55) return 'color: #ffcc00;';
        return 'color: #00ff00;';
    };

    const rows = exportData.map((d) => {
        const bandCells = REC_BANDS.map((b) =>
            `<td style="${bandColor(d.bands[b.key])}">${fmtDb(d.bands[b.key], 2)}</td>`).join('');
        return `
            <tr>
                <td>${d.t.toFixed(2)}</td>
                ${bandCells}
                <td style="${levelColor(d.rms)}">${fmtDb(d.rms, 2)}</td>
                <td style="${levelColor(d.peak)}">${fmtDb(d.peak, 2)}</td>
                <td>${d.crest.toFixed(2)}</td>
                <td>${d.peakFreq ? Math.round(d.peakFreq) : '-'}</td>
                <td>${d.balance.toFixed(2)}</td>
            </tr>`;
    }).join('');

    const safeName = escapeHtml(fileName);
    const sampleRate = audioContext ? audioContext.sampleRate : '?';

    return `<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <title>PRO Audio Analysis: ${safeName}</title>
    <style>
        body { background: #0a0a0a; color: white; font-family: 'Courier New', monospace; padding: 20px; }
        h1 { color: #ffcc00; text-align: center; border-bottom: 3px solid #4477ff; padding-bottom: 10px; }
        h2 { color: #4477ff; margin-top: 30px; }
        table { width: 100%; border-collapse: collapse; margin-top: 20px; font-size: 0.9em; }
        .table-container { max-height: 600px; overflow-y: auto; border: 2px solid #333; border-radius: 5px; }
        .table-container::-webkit-scrollbar { width: 12px; }
        .table-container::-webkit-scrollbar-track { background: #0a0a0a; }
        .table-container::-webkit-scrollbar-thumb { background: #ffcc00; border-radius: 6px; }
        .table-container::-webkit-scrollbar-thumb:hover { background: #ff9900; }
        th { background: #1a1a1a; color: #ffcc00; padding: 10px 8px; border: 1px solid #333; text-align: center; position: sticky; top: 0; z-index: 10; font-size: 0.85em; }
        td { padding: 8px 6px; border: 1px solid #333; text-align: center; background: #111; }
        tr:hover td { background: #1a1a1a; }
        .info { background: #1a1a1a; padding: 15px; border-left: 4px solid #ffcc00; margin: 20px 0; }
        .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin: 20px 0; }
        .stat-box { background: #1a1a1a; padding: 15px; border: 2px solid #333; border-radius: 5px; }
        .stat-label { color: #888; font-size: 0.9em; }
        .stat-value { color: #ffcc00; font-size: 1.8em; font-weight: bold; margin-top: 5px; }
        .warning { background: #331a00; border-left: 4px solid #ff9900; padding: 15px; margin: 20px 0; }
    </style>
</head>
<body>
    <h1>🖖 LCARS PRO AUDIO ANALYSIS REPORT</h1>

    <div class="info">
        <strong>📁 Soubor:</strong> ${safeName}<br>
        <strong>📊 Počet vzorků:</strong> ${exportData.length}<br>
        <strong>⏱️ Interval vzorkování:</strong> 0.10 s (100 ms)<br>
        <strong>🔬 FFT velikost:</strong> ${FFT_SIZE} (${FFT_SIZE / 2} frekvenčních binů), vzorkovací frekvence ${sampleRate} Hz<br>
        <strong>📅 Datum analýzy:</strong> ${new Date().toLocaleString('cs-CZ')}<br>
        <strong>✅ Metoda:</strong> RMS a True Peak z časové oblasti (dBFS), pásma z FFT (dB, výkonový průměr)
    </div>

    <h2>📈 Celkové statistiky</h2>
    <div class="stats">
        <div class="stat-box">
            <div class="stat-label">Průměrná RMS hlasitost</div>
            <div class="stat-value">${fmtDb(avgRms, 2)} dBFS</div>
        </div>
        <div class="stat-box">
            <div class="stat-label">Maximální True Peak</div>
            <div class="stat-value">${fmtDb(maxPeak, 2)} dBFS</div>
        </div>
        <div class="stat-box">
            <div class="stat-label">Průměrný Crest Factor</div>
            <div class="stat-value">${avgCrest.toFixed(2)}</div>
        </div>
        <div class="stat-box">
            <div class="stat-label">Dynamický rozsah (P95−P10)</div>
            <div class="stat-value">${dynRange === null ? 'N/A' : dynRange.toFixed(1) + ' dB'}</div>
        </div>
    </div>

    ${maxPeak > -1 ? `<div class="warning">
        ⚠️ <strong>VAROVÁNÍ:</strong> Detekován clipping! True Peak překračuje -1 dBFS.
        Doporučení: Snižte celkovou hlasitost nebo použijte limiter.
    </div>` : ''}

    <h2>📊 Detailní Časová Osa (Timeline)</h2>
    <p>Záznam všech 8 pásem + profesionální metriky v čase (interval 0.1 s)</p>

    <div class="table-container">
    <table>
        <thead>
            <tr>
                <th>Čas<br>(s)</th>
                <th>Sub-Bass<br>(dB)</th>
                <th>Bass<br>(dB)</th>
                <th>Low-Mid<br>(dB)</th>
                <th>Mid<br>(dB)</th>
                <th>High-Mid<br>(dB)</th>
                <th>Presence<br>(dB)</th>
                <th>Brilliance<br>(dB)</th>
                <th>Air<br>(dB)</th>
                <th>RMS<br>(dBFS)</th>
                <th>True Peak<br>(dBFS)</th>
                <th>Crest<br>Factor</th>
                <th>Peak Freq<br>(Hz)</th>
                <th>Stereo<br>Balance (dB)</th>
            </tr>
        </thead>
        <tbody>
            ${rows}
        </tbody>
    </table>
    </div>

    <div class="info" style="margin-top: 30px;">
        <strong>📖 Legenda barev - RMS a True Peak (dBFS):</strong><br>
        <span style="color: #00ff00;">🟢 Zelená: -∞ až -30 dB</span><br>
        <span style="color: #ffcc00;">🟡 Žlutá: -30 až -18 dB</span><br>
        <span style="color: #ff9900;">🟠 Oranžová: -18 až -12 dB</span><br>
        <span style="color: #ff4444;">🔴 Červená: -12 až -6 dB</span><br>
        <span style="color: #ff0000; font-weight: bold;">🔴 KRITICKÁ: nad -6 dB</span><br><br>
        <strong>📖 Legenda barev - frekvenční pásma (relativní spektrální úroveň, dB):</strong><br>
        <span style="color: #00ff00;">🟢 pod -55</span> ·
        <span style="color: #ffcc00;">🟡 -55 až -42</span> ·
        <span style="color: #ff9900;">🟠 -42 až -30</span> ·
        <span style="color: #ff4444;">🔴 -30 až -20</span> ·
        <span style="color: #ff0000; font-weight: bold;">🔴 nad -20</span>
    </div>

    <div class="info">
        <strong>📚 Vysvětlení metrik:</strong><br><br>
        <strong>RMS:</strong> Skutečná hlasitost z časové oblasti signálu (L+R)<br>
        <strong>True Peak:</strong> Nejvyšší vzorek signálu (mělo by být pod 0 dBFS!)<br>
        <strong>Crest Factor:</strong> Poměr peak/RMS (vyšší = dynamičtější mix, 2-6 je normální)<br>
        <strong>Dynamický rozsah:</strong> Rozdíl mezi hlasitými (P95) a tichými (P10) pasážemi podle RMS (vyšší = dynamičtější)<br>
        <strong>Peak Freq:</strong> Frekvence s nejvyšší energií v daném okamžiku<br>
        <strong>Stereo Balance:</strong> Rozdíl L/R v dB (0 = vyvážené, kladné = víc vlevo, záporné = víc vpravo)
    </div>
</body>
</html>`;
}

/* --------------------------------------------------------------------------
   START
   -------------------------------------------------------------------------- */

resetVU();
drawAll();
