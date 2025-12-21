const fileInput = document.getElementById('fileInput');
    const audioElement = document.getElementById('mainAudio');
    const toggle3DBtn = document.getElementById('toggle3D');
    const toggleEffectBtn = document.getElementById('toggleEffect');
    const reverbSlider = document.getElementById('reverbLevel');
    const exportBtn = document.getElementById('exportBtn');
    
    let audioContext, analyser, source, dataArray;
    let analyserLeft, analyserRight, splitter;
    let dataArrayLeft, dataArrayRight;
    let peakAnalyser, peakDataArray; // Pro true peak detection
    let isContextReady = false;
    let show3D = false;
    let effectActive = false;
    
    // Data pro export
    let exportData = [];
    let isRecording = false;
    let recordingStartTime = 0;
    let recordingInterval = null;
    
    // Tone.js setup
    let reverb, player;
    
    // Three.js variables
    let scene, camera, renderer, bars3D = [];
    
    // Spectrogram data
    let spectrogramData = [];
    let spectrogramTime = [];
    
    // Wavesurfer
    const wavesurfer = WaveSurfer.create({
        container: '#waveform',
        waveColor: '#4477ff',
        progressColor: '#ffcc00',
        cursorColor: '#ff4444',
        barWidth: 3,
        barGap: 2,
        height: 120,
        media: audioElement,
        backend: 'WebAudio'
    });

    // Force waveform to load when audio is ready
    audioElement.addEventListener('loadedmetadata', () => {
        wavesurfer.load(audioElement.src);
    });

    // Chart.js Radar
    const radarCtx = document.getElementById('radarChart').getContext('2d');
    const radarChart = new Chart(radarCtx, {
        type: 'radar',
        data: {
            labels: ['Sub-Bass', 'Bass', 'Low-Mid', 'Mid', 'High-Mid', 'Treble', 'Air'],
            datasets: [{
                label: 'Aktuální Energie',
                data: [0, 0, 0, 0, 0, 0, 0],
                backgroundColor: 'rgba(255, 204, 0, 0.4)',
                borderColor: '#ffcc00',
                borderWidth: 2,
                pointRadius: 0
            }]
        },
        options: {
            scales: { r: { min: 0, max: 255, ticks: { display: false }, grid: { color: '#333' } } },
            animation: false,
            responsive: true,
            maintainAspectRatio: false
        }
    });

    // File input
    fileInput.addEventListener('change', function(e) {
        const file = e.target.files[0];
        if (file) {
            const objectUrl = URL.createObjectURL(file);
            audioElement.src = objectUrl;
            spectrogramData = [];
            spectrogramTime = [];
        }
    });

    // Audio metadata
    audioElement.onloadedmetadata = () => {
        const mins = Math.floor(audioElement.duration / 60);
        const secs = Math.floor(audioElement.duration % 60);
        document.getElementById('duration').textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
        
        // Zobrazit sample rate když je context ready
        if (audioContext) {
            document.getElementById('sampleRate').textContent = audioContext.sampleRate + ' Hz';
        }
    };

    // Play handler
    audioElement.onplay = () => {
        if (!isContextReady) {
            setupAudioChain();
            setupToneJS();
            setup3D();
            isContextReady = true;
        }
        if (audioContext.state === 'suspended') audioContext.resume();
        
        // Start recording s PŘESNÝM intervalem
        isRecording = true;
        recordingStartTime = audioElement.currentTime;
        exportData = [];
        
        // Přesný interval 100ms (ne závislý na FPS!)
        recordingInterval = setInterval(() => {
            if (isRecording && !audioElement.paused) {
                recordDataSnapshot(audioElement.currentTime);
            }
        }, 100); // PŘESNĚ 100ms
        
        renderLoop();
    };

    audioElement.onpause = () => {
        isRecording = false;
        if (recordingInterval) {
            clearInterval(recordingInterval);
            recordingInterval = null;
        }
    };

    audioElement.onended = () => {
        isRecording = false;
        if (recordingInterval) {
            clearInterval(recordingInterval);
            recordingInterval = null;
        }
    };

    /* ==========================================================================
   KOMPLETNÍ AUDIO ENGINE - JIŘÍKŮV UPGRADE (VŠECH 207+ ŘÁDKŮ)
   ========================================================================== */

// Globální proměnné pro filtry a samostatné analyzéry pro 4 patra
let anaBass, anaMid, anaVocals, anaHigh;

function setupAudioChain() {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    
    // Hlavní analyser pro spektrum - ZVÝŠENÁ PŘESNOST
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048; 
    analyser.smoothingTimeConstant = 0.3;
    dataArray = new Uint8Array(analyser.frequencyBinCount);

    // Peak analyser pro TRUE PEAK detection
    peakAnalyser = audioContext.createAnalyser();
    peakAnalyser.fftSize = 8192; 
    peakAnalyser.smoothingTimeConstant = 0;
    peakDataArray = new Uint8Array(peakAnalyser.frequencyBinCount);

    // Stereo routing pro VU Metry
    splitter = audioContext.createChannelSplitter(2);
    
    // Levy kanal analyser
    analyserLeft = audioContext.createAnalyser();
    analyserLeft.fftSize = 2048;
    analyserLeft.smoothingTimeConstant = 0.3;
    dataArrayLeft = new Uint8Array(analyserLeft.frequencyBinCount);
    
    // Pravy kanal analyser
    analyserRight = audioContext.createAnalyser();
    analyserRight.fftSize = 2048;
    analyserRight.smoothingTimeConstant = 0.3;
    dataArrayRight = new Uint8Array(analyserRight.frequencyBinCount);

    source = audioContext.createMediaElementSource(audioElement);
    
    // --- JIŘÍKOVA NOVINKA: FILTRAČNÍ KASKÁDA PRO 4 PATRA OSCILOSKOPU ---
    const createBranch = (type, freq, Q = 1) => {
        const filter = audioContext.createBiquadFilter();
        filter.type = type;
        filter.frequency.value = freq;
        filter.Q.value = Q;
        const ana = audioContext.createAnalyser();
        ana.fftSize = 1024;
        source.connect(filter);
        filter.connect(ana);
        return ana;
    };

    anaBass = createBranch('lowpass', 150);     // Červená: Basy
    anaMid = createBranch('bandpass', 500);     // Zelená: Středy
    anaVocals = createBranch('bandpass', 1500, 2); // Oranžová: Vokály
    anaHigh = createBranch('highpass', 5000);   // Modrá: Výšky

    // Routing: source -> analysers (Zachování původní funkčnosti)
    source.connect(analyser);
    source.connect(peakAnalyser);
    analyser.connect(audioContext.destination);
    
    // Routing: source -> splitter -> L/R analysers
    source.connect(splitter);
    splitter.connect(analyserLeft, 0);
    splitter.connect(analyserRight, 1);
}

function setupToneJS() {
    Tone.setContext(audioContext);
    reverb = new Tone.Reverb({ decay: 3, wet: 0 }).toDestination();
    
    reverbSlider.addEventListener('input', (e) => {
        reverb.wet.value = e.target.value / 100;
    });
}

function setup3D() {
    const container = document.getElementById('threeContainer');
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(75, container.clientWidth / container.clientHeight, 0.1, 1000);
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(container.clientWidth, container.clientHeight);
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);

    camera.position.z = 50;

    // Create 32 bars in circle
    for (let i = 0; i < 32; i++) {
        const geometry = new THREE.BoxGeometry(1, 1, 1);
        const material = new THREE.MeshBasicMaterial({ color: 0xffcc00 });
        const bar = new THREE.Mesh(geometry, material);
        const angle = (i / 32) * Math.PI * 2;
        bar.position.x = Math.cos(angle) * 15;
        bar.position.z = Math.sin(angle) * 15;
        scene.add(bar);
        bars3D.push(bar);
    }
}

// Toggle 3D
toggle3DBtn.addEventListener('click', () => {
    show3D = !show3D;
    toggle3DBtn.textContent = `3D View: ${show3D ? 'ON' : 'OFF'}`;
    toggle3DBtn.classList.toggle('active');
});

// Toggle Effect
toggleEffectBtn.addEventListener('click', () => {
    effectActive = !effectActive;
    toggleEffectBtn.textContent = `Effect: ${effectActive ? 'ON' : 'OFF'}`;
    toggleEffectBtn.classList.toggle('active');
    
    if (effectActive && reverb) {
        source.disconnect();
        source.connect(analyser);
        const toneNode = audioContext.createMediaStreamDestination();
        source.connect(toneNode);
        reverb.connect(audioContext.destination);
    } else if (reverb) {
        reverb.wet.value = 0;
    }
});

let frameCount = 0;
function renderLoop() {
    if (!audioElement.paused) {
        requestAnimationFrame(renderLoop);
        
        // 1. Získání dat pro všechny kanály
        analyser.getByteFrequencyData(dataArray);
        analyserLeft.getByteFrequencyData(dataArrayLeft);
        analyserRight.getByteFrequencyData(dataArrayRight);
        
        frameCount++;
        
        // 2. D3 Bars (Celkové spektrum)
        const d3Container = document.getElementById('d3_viz');
        d3Container.innerHTML = '';
        for (let i = 0; i < 32; i++) {
            const val = dataArray[i];
            const bar = document.createElement('div');
            bar.className = 'bar';
            bar.style.height = (val / 2.55) + '%';
            bar.style.backgroundColor = `hsl(${val}, 100%, 50%)`;
            d3Container.appendChild(bar);
        }

        // 3. VU METRY - NYNÍ SYNCHRONNÍ A PŘESNÉ
        // Počítáme průměrnou energii z celého spektra pro každý kanál zvlášť
        const leftLevel = dataArrayLeft.reduce((a, b) => a + b, 0) / dataArrayLeft.length;
        const rightLevel = dataArrayRight.reduce((a, b) => a + b, 0) / dataArrayRight.length;
        
        // Zesílení pro vizualizaci (aby to pořádně skákalo)
        const vuGain = 1.2; 
        updateVUMeter('vuLeft', 'vuLeftText', Math.min(255, leftLevel * vuGain));
        updateVUMeter('vuRight', 'vuRightText', Math.min(255, rightLevel * vuGain));

        // 4. Radar Chart
        const bands = [
            dataArray[1], dataArray[3], dataArray[8], dataArray[16],
            dataArray[24], dataArray[32], dataArray[48] || 0
        ];
        radarChart.data.datasets[0].data = bands;
        radarChart.update();

        // 5. 3D Vizualizace a Osciloskop (ty už máš v pořádku)
        if (show3D && bars3D.length > 0) {
            for (let i = 0; i < 32; i++) {
                const val = dataArray[i] / 1; 
                bars3D[i].scale.y = val || 1;
                bars3D[i].material.color.setHSL((dataArray[i] / 255) * 0.6, 1, 0.5);
            }
            scene.rotation.y += 0.005;
            renderer.render(scene, camera);
        }

        if (frameCount % 2 === 0) {
            updateSpectrogram();
        }
    }
}

function updateSpectrogram() {
    if (!anaBass) return;

    const getWave = (targetAnalyser) => {
        const data = new Uint8Array(targetAnalyser.fftSize);
        targetAnalyser.getByteTimeDomainData(data);
        return Array.from(data);
    };

    const createLine = (yOffset, color, waveData, gain = 1.0) => {
        return {
            x: Array.from({length: waveData.length}, (_, i) => i),
            y: waveData.map(v => ((v - 128) * gain) + yOffset),
            type: 'scatter',
            mode: 'lines',
            line: { color: color, width: 2, shape: 'spline' }
        };
    };

    const traceBass = createLine(180, '#ff4444', getWave(anaBass), 2.5);
    const traceMids = createLine(120, '#00ff88', getWave(anaMid), 1.5);
    const traceHigh = createLine(60, '#4477ff', getWave(anaHigh), 2.8);
    const traceVocals = createLine(20, '#ff9900', getWave(anaVocals), 2.0);

    const layout = {
        paper_bgcolor: 'rgba(0,0,0,0)',
        plot_bgcolor: 'rgba(0,0,0,0)',
        showlegend: false,
        // AUTOMATICKÉ ROZTAŽENÍ OSY X
        autosize: true, 
        xaxis: { 
            visible: false, 
            autorange: true // Zajistí, že vlnovky vyplní celou šířku grafu
        },
        yaxis: { range: [-40, 280], visible: false },
        margin: { t: 0, b: 0, l: 0, r: 120 }, // Minimalizované okraje pro maximální šířku
        annotations: [
            { x: 1.02, xref: 'paper', y: 180, yref: 'y', text: '🔴 <b>BASY</b>', showarrow: false, xanchor: 'left', font: {color: '#ff4444', size: 14} },
            { x: 1.02, xref: 'paper', y: 120, yref: 'y', text: '🟢 <b>STŘEDY</b>', showarrow: false, xanchor: 'left', font: {color: '#00ff88', size: 14} },
            { x: 1.02, xref: 'paper', y: 60, yref: 'y', text: '🔵 <b>VÝŠKY</b>', showarrow: false, xanchor: 'left', font: {color: '#4477ff', size: 14} },
            { x: 1.02, xref: 'paper', y: 20, yref: 'y', text: '🟠 <b>VOKÁLY</b>', showarrow: false, xanchor: 'left', font: {color: '#ff9900', size: 14} }
        ]
    };

    // Konfigurace pro responzivitu
    const config = { responsive: true, displayModeBar: false };

    Plotly.react('spectrogramPlot', [traceBass, traceMids, traceHigh, traceVocals], layout, config);
}

function updateVUMeter(barId, textId, level) {
    const bar = document.getElementById(barId);
    const text = document.getElementById(textId);
    const percentage = (level / 255) * 100;
    bar.style.height = percentage + '%';
    
    if (percentage < 60) bar.style.background = '#00ff00';
    else if (percentage < 80) bar.style.background = '#ffff00';
    else if (percentage < 95) bar.style.background = '#ff9900';
    else bar.style.background = '#ff0000';
    
    const dbValue = 20 * Math.log10(level / 255);
    text.textContent = dbValue.toFixed(1) + ' dB';
}

    // Zaznamenat snapshot frekvenčních pásem - MAXIMÁLNÍ PŘESNOST
    function recordDataSnapshot(time) {
        // Aktuální data z analyserů
        analyser.getByteFrequencyData(dataArray);
        peakAnalyser.getByteFrequencyData(peakDataArray);
        analyserLeft.getByteFrequencyData(dataArrayLeft);
        analyserRight.getByteFrequencyData(dataArrayRight);
        
        // Frekvence pro každé pásmo (s FFT 2048 máme 1024 binů)
        const binWidth = audioContext.sampleRate / analyser.fftSize;
        
        // Přesné mapování pásem na frekvenční bins
        const getBandAverage = (startFreq, endFreq) => {
            const startBin = Math.floor(startFreq / binWidth);
            const endBin = Math.ceil(endFreq / binWidth);
            let sum = 0;
            let count = 0;
            for (let i = startBin; i <= endBin && i < dataArray.length; i++) {
                sum += dataArray[i];
                count++;
            }
            return count > 0 ? sum / count : 0;
        };
        
        // 8 pásem podle profesionálních standardů
        const bands = {
            subBass: getBandAverage(20, 60),      // Sub-Bass
            bass: getBandAverage(60, 250),        // Bass
            lowMid: getBandAverage(250, 500),     // Low-Mid
            mid: getBandAverage(500, 2000),       // Mid
            highMid: getBandAverage(2000, 4000),  // High-Mid
            presence: getBandAverage(4000, 6000), // Presence
            brilliance: getBandAverage(6000, 12000), // Brilliance
            air: getBandAverage(12000, 20000)     // Air
        };
        
        // RMS pro každé pásmo (skutečná hlasitost)
        const calculateRMS = (values) => {
            const sumSq = values.reduce((sum, val) => sum + val * val, 0);
            return Math.sqrt(sumSq / values.length);
        };
        
        const overallRMS = calculateRMS(Array.from(dataArray));
        
        // TRUE PEAK detection
        const truePeak = Math.max(...peakDataArray);
        
        // Crest Factor (peak-to-RMS ratio) - indikátor kvality mixu
        const crestFactor = truePeak / (overallRMS || 1);
        
        // Dynamic Range
        const minLevel = Math.min(...dataArray.filter(v => v > 0)) || 1;
        const maxLevel = truePeak;
        const dynamicRange = 20 * Math.log10(maxLevel / minLevel);
        
        // Stereo info
        const leftRMS = calculateRMS(Array.from(dataArrayLeft));
        const rightRMS = calculateRMS(Array.from(dataArrayRight));
        const stereoBalance = leftRMS / (rightRMS || 1);
        
        // Převod na dBFS (decibels Full Scale) - profesionální standard
        const toDBFS = (value) => {
            if (value <= 0) return -Infinity;
            return 20 * Math.log10(value / 255);
        };
        
        const dataPoint = {
            time: time.toFixed(2),
            subBass: toDBFS(bands.subBass).toFixed(2),
            bass: toDBFS(bands.bass).toFixed(2),
            lowMid: toDBFS(bands.lowMid).toFixed(2),
            mid: toDBFS(bands.mid).toFixed(2),
            highMid: toDBFS(bands.highMid).toFixed(2),
            presence: toDBFS(bands.presence).toFixed(2),
            brilliance: toDBFS(bands.brilliance).toFixed(2),
            air: toDBFS(bands.air).toFixed(2),
            rms: toDBFS(overallRMS).toFixed(2),
            truePeak: toDBFS(truePeak).toFixed(2),
            crestFactor: crestFactor.toFixed(2),
            dynamicRange: (dynamicRange > 0 && dynamicRange < 200 ? dynamicRange.toFixed(1) : 'N/A'),
            stereoBalance: stereoBalance.toFixed(2)
        };
        
        exportData.push(dataPoint);
    }

    // Export do HTML
    exportBtn.addEventListener('click', () => {
        if (exportData.length === 0) {
            alert('Nejdřív přehraj audio soubor pro záznam dat!');
            return;
        }
        
        const fileName = fileInput.files[0]?.name || 'audio';
        const html = generateExportHTML(fileName);
        
        const blob = new Blob([html], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${fileName}_analysis.html`;
        a.click();
        URL.revokeObjectURL(url);
    });

    function generateExportHTML(fileName) {
        // Vypočítat celkové statistiky
        const allRMS = exportData.map(d => parseFloat(d.rms)).filter(v => v > -Infinity);
        const allPeaks = exportData.map(d => parseFloat(d.truePeak)).filter(v => v > -Infinity);
        const avgRMS = (allRMS.reduce((a, b) => a + b, 0) / allRMS.length).toFixed(2);
        const maxPeak = Math.max(...allPeaks).toFixed(2);
        const avgCrest = (exportData.map(d => parseFloat(d.crestFactor)).reduce((a, b) => a + b, 0) / exportData.length).toFixed(2);
        
        let rows = '';
        exportData.forEach(data => {
            const getColor = (val) => {
                const num = parseFloat(val);
                if (num === -Infinity || isNaN(num)) return 'color: #333;';
                if (num > -6) return 'color: #ff0000; font-weight: bold;'; // KRITICKÉ!
                if (num > -12) return 'color: #ff4444;'; // Červená
                if (num > -18) return 'color: #ff9900;'; // Oranžová
                if (num > -30) return 'color: #ffcc00;'; // Žlutá
                return 'color: #00ff00;'; // Zelená
            };
            
            rows += `
            <tr>
                <td>${data.time}</td>
                <td style="${getColor(data.subBass)}">${data.subBass}</td>
                <td style="${getColor(data.bass)}">${data.bass}</td>
                <td style="${getColor(data.lowMid)}">${data.lowMid}</td>
                <td style="${getColor(data.mid)}">${data.mid}</td>
                <td style="${getColor(data.highMid)}">${data.highMid}</td>
                <td style="${getColor(data.presence)}">${data.presence}</td>
                <td style="${getColor(data.brilliance)}">${data.brilliance}</td>
                <td style="${getColor(data.air)}">${data.air}</td>
                <td style="${getColor(data.rms)}">${data.rms}</td>
                <td style="${getColor(data.truePeak)}">${data.truePeak}</td>
                <td>${data.crestFactor}</td>
                <td>${data.dynamicRange}</td>
                <td>${data.stereoBalance}</td>
            </tr>`;
        });
        
        return `<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <title>PRO Audio Analysis: ${fileName}</title>
    <style>
        body {
            background: #0a0a0a;
            color: white;
            font-family: 'Courier New', monospace;
            padding: 20px;
        }
        h1 {
            color: #ffcc00;
            text-align: center;
            border-bottom: 3px solid #4477ff;
            padding-bottom: 10px;
        }
        h2 {
            color: #4477ff;
            margin-top: 30px;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
            font-size: 0.9em;
        }
        .table-container {
            max-height: 600px;
            overflow-y: auto;
            border: 2px solid #333;
            border-radius: 5px;
        }
        .table-container::-webkit-scrollbar {
            width: 12px;
        }
        .table-container::-webkit-scrollbar-track {
            background: #0a0a0a;
        }
        .table-container::-webkit-scrollbar-thumb {
            background: #ffcc00;
            border-radius: 6px;
        }
        .table-container::-webkit-scrollbar-thumb:hover {
            background: #ff9900;
        }
        th {
            background: #1a1a1a;
            color: #ffcc00;
            padding: 10px 8px;
            border: 1px solid #333;
            text-align: center;
            position: sticky;
            top: 0;
            z-index: 10;
            font-size: 0.85em;
        }
        td {
            padding: 8px 6px;
            border: 1px solid #333;
            text-align: center;
            background: #111;
        }
        tr:hover {
            background: #1a1a1a;
        }
        .info {
            background: #1a1a1a;
            padding: 15px;
            border-left: 4px solid #ffcc00;
            margin: 20px 0;
        }
        .stats {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 15px;
            margin: 20px 0;
        }
        .stat-box {
            background: #1a1a1a;
            padding: 15px;
            border: 2px solid #333;
            border-radius: 5px;
        }
        .stat-label {
            color: #888;
            font-size: 0.9em;
        }
        .stat-value {
            color: #ffcc00;
            font-size: 1.8em;
            font-weight: bold;
            margin-top: 5px;
        }
        .warning {
            background: #331a00;
            border-left: 4px solid #ff9900;
            padding: 15px;
            margin: 20px 0;
        }
    </style>
</head>
<body>
    <h1>🖖 LCARS PRO AUDIO ANALYSIS REPORT</h1>
    
    <div class="info">
        <strong>📁 Soubor:</strong> ${fileName}<br>
        <strong>📊 Celková délka záznamu:</strong> ${exportData.length} vzorků<br>
        <strong>⏱️ Interval vzorkování:</strong> 0.10s (přesný timer, 100ms)<br>
        <strong>🔬 FFT velikost:</strong> 2048 (1024 frekvenčních binů)<br>
        <strong>📅 Datum analýzy:</strong> ${new Date().toLocaleString('cs-CZ')}<br>
        <strong>✅ Metoda:</strong> dBFS (decibels Full Scale) - profesionální standard
    </div>
    
    <h2>📈 Celkové statistiky</h2>
    <div class="stats">
        <div class="stat-box">
            <div class="stat-label">Průměrná RMS hlasitost</div>
            <div class="stat-value">${avgRMS} dB</div>
        </div>
        <div class="stat-box">
            <div class="stat-label">Maximální True Peak</div>
            <div class="stat-value">${maxPeak} dB</div>
        </div>
        <div class="stat-box">
            <div class="stat-label">Průměrný Crest Factor</div>
            <div class="stat-value">${avgCrest}</div>
        </div>
    </div>
    
    ${parseFloat(maxPeak) > -1 ? `<div class="warning">
        ⚠️ <strong>VAROVÁNÍ:</strong> Detekován clipping! True Peak překračuje -1 dBFS. 
        Doporučení: Snižte celkovou hlasitost nebo použijte limiter.
    </div>` : ''}
    
    <h2>📊 Detailní Časová Osa (Timeline)</h2>
    <p>Záznam všech 8 pásem + profesionální metriky v čase (interval 0.1s)</p>
    
    <div class="table-container">
    <table>
        <thead>
            <tr>
                <th>Čas<br>(s)</th>
                <th>Sub-Bass<br>(dBFS)</th>
                <th>Bass<br>(dBFS)</th>
                <th>Low-Mid<br>(dBFS)</th>
                <th>Mid<br>(dBFS)</th>
                <th>High-Mid<br>(dBFS)</th>
                <th>Presence<br>(dBFS)</th>
                <th>Brilliance<br>(dBFS)</th>
                <th>Air<br>(dBFS)</th>
                <th>RMS<br>(dBFS)</th>
                <th>True Peak<br>(dBFS)</th>
                <th>Crest<br>Factor</th>
                <th>Dynamic<br>Range</th>
                <th>Stereo<br>Balance</th>
            </tr>
        </thead>
        <tbody>
            ${rows}
        </tbody>
    </table>
    </div>
    
    <div class="info" style="margin-top: 30px;">
        <strong>📖 Legenda barev (dBFS):</strong><br>
        <span style="color: #00ff00;">🟢 Zelená: -∞ až -30 dB (nízká úroveň)</span><br>
        <span style="color: #ffcc00;">🟡 Žlutá: -30 až -18 dB (střední úroveň)</span><br>
        <span style="color: #ff9900;">🟠 Oranžová: -18 až -12 dB (vysoká úroveň)</span><br>
        <span style="color: #ff4444;">🔴 Červená: -12 až -6 dB (velmi vysoká úroveň)</span><br>
        <span style="color: #ff0000; font-weight: bold;">🔴 KRITICKÁ: -6 dB a více (CLIPPING!)</span>
    </div>
    
    <div class="info">
        <strong>📚 Vysvětlení metrik:</strong><br><br>
        <strong>RMS (Root Mean Square):</strong> Skutečná hlasitost, jak ji vnímá lidské ucho<br>
        <strong>True Peak:</strong> Absolutní maximum signálu (mělo by být pod 0 dBFS!)<br>
        <strong>Crest Factor:</strong> Poměr peak/RMS (vyšší = dynamičtější mix, 2-6 je normální)<br>
        <strong>Dynamic Range:</strong> Rozdíl mezi nejhlasitějším a nejtišším (vyšší = lepší)<br>
        <strong>Stereo Balance:</strong> Poměr L/R kanálů (1.0 = perfektně vyvážené)
    </div>
</body>
</html>`;
    }