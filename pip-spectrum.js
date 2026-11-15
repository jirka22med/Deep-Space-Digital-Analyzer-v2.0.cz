'use strict';
/* ==========================================================================
   🖖 LCARS PiP SPEKTRUM — samostatný modul (pip-spectrum.js)
   Plovoucí okno "Picture-in-Picture" s hlavním spektrem včetně dB popisků.

   Zapojení: v HTML načti AŽ PO script.js
       <script src="script.js"></script>
       <script src="pip-spectrum.js"></script>
   Modul nic nemění v script.js. Používá jeho globální analyser, audioContext
   a třídu SpectrumRenderer a kreslí do vlastního plátna ve vlastním okně.

   Režimy:
     1) Document Picture-in-Picture (Chrome / Edge 116+): skutečné plovoucí okno,
        které zůstává nad ostatními okny, ostré (bez video komprese).
     2) Záloha: plátno -> captureStream -> <video> -> klasické video PiP.
   ========================================================================== */
(function () {
    if (window.LcarsPipSpectrum) return;

    const CFG = {
        width: 10000, height: 10000,             // výchozí velikost plovoucího okna
        bars: 32, fmin: 30, fmax: 18000,     // 32 sloupců se do malého okna vejdou i s dB popisky
        fallbackW: 10000, fallbackH: 10000, fallbackFps: 160,
        buttonId: 'lcarsPipBtn'
    };

    let pipWin = null;                // okno z Document PiP
    let pipVideo = null;              // záloha: { video, canvas }
    let renderer = null;
    let spec = null;
    let rafId = 0, timerId = 0, lastTs = 0;
    let btn = null;

    /* ------------------------------------------------------------------
       NAPOJENÍ NA script.js (globální let/const/class z klasického <script>)
       ------------------------------------------------------------------ */
    function hooks() {
        try {
            return { analyser: analyser, audioContext: audioContext, Renderer: SpectrumRenderer };
        } catch (e) {
            return null;   // script.js není načten dřív než modul, nebo je načten jako type="module"
        }
    }

    // SpectrumRenderer z script.js, jen s vlastním měřením velikosti plátna
    // (plátno žije v jiném okně / je odpojené, takže getBoundingClientRect hlavní stránky nestačí)
    function makeRenderer(Renderer, canvas, fixed) {
        class PipRenderer extends Renderer {
            resize() {
                const view = this.canvas.ownerDocument.defaultView;
                const dpr = fixed ? 1 : ((view && view.devicePixelRatio) || 1);
                let w, h;
                if (fixed) {
                    w = fixed.w; h = fixed.h;
                } else {
                    const r = this.canvas.getBoundingClientRect();
                    w = Math.max(1, Math.round(r.width));
                    h = Math.max(1, Math.round(r.height));
                }
                this.w = w;
                this.h = h;
                this.canvas.width = Math.round(w * dpr);
                this.canvas.height = Math.round(h * dpr);
                this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
            }
        }
        return new PipRenderer(canvas, {
            bars: CFG.bars, fmin: CFG.fmin, fmax: CFG.fmax, labels: true, gap: 2
        });
    }

    /* ------------------------------------------------------------------
       KRESLENÍ JEDNOHO SNÍMKU
       ------------------------------------------------------------------ */
    function drawIdle(r) {
        r.clear();
        const ctx = r.ctx;
        ctx.save();
        ctx.fillStyle = '#8a8a8a';
        ctx.font = '13px "JetBrains Mono", Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillText('Spusť skladbu – spektrum se objeví tady', r.w / 2, r.h / 2);
        ctx.restore();
    }

    function step(dt) {
        const r = renderer;
        if (!r) return;
        const g = hooks();
        if (!g || !g.analyser || !g.audioContext) { drawIdle(r); return; }

        const a = g.analyser;
        if (!spec || spec.length !== a.frequencyBinCount) {
            spec = new Float32Array(a.frequencyBinCount).fill(-120);
        }
        a.getFloatFrequencyData(spec);
        r.update(spec, g.audioContext.sampleRate / a.fftSize, dt);
        r.clear();
        r.drawBars(0, 0, r.w, r.h);
    }

    /* ------------------------------------------------------------------
       REŽIM 1: Document Picture-in-Picture
       ------------------------------------------------------------------ */
    async function openDocumentPip() {
        const g = hooks();
        if (!g) throw new Error('script.js (SpectrumRenderer) není dostupný - načti pip-spectrum.js až po script.js jako klasický <script>');

        const win = await window.documentPictureInPicture.requestWindow({
            width: CFG.width, height: CFG.height
        });
        pipWin = win;

        const doc = win.document;
        doc.title = 'LCARS • Spektrum';
        const style = doc.createElement('style');
        style.textContent = 'html,body{margin:0;height:100%;background:#050507;overflow:hidden}' +
                            'canvas{display:block;width:100vw;height:100vh}';
        doc.head.appendChild(style);
        const canvas = doc.createElement('canvas');
        doc.body.appendChild(canvas);

        renderer = makeRenderer(g.Renderer, canvas, null);
        spec = null;

        win.addEventListener('resize', () => { if (renderer) renderer.resize(); });
        win.addEventListener('pagehide', () => cleanup());

        lastTs = win.performance.now();
        const frame = (ts) => {
            if (pipWin !== win) return;
            const dt = Math.min(0.1, Math.max(0.001, (ts - lastTs) / 1000));
            lastTs = ts;
            step(dt);
            rafId = win.requestAnimationFrame(frame);
        };
        rafId = win.requestAnimationFrame(frame);
        setState(true);
    }

    /* ------------------------------------------------------------------
       REŽIM 2 (záloha): plátno -> video -> klasické video PiP
       ------------------------------------------------------------------ */
    async function openVideoPip() {
        const g = hooks();
        if (!g) throw new Error('script.js (SpectrumRenderer) není dostupný - načti pip-spectrum.js až po script.js jako klasický <script>');
        if (!document.pictureInPictureEnabled || !HTMLCanvasElement.prototype.captureStream) {
            throw new Error('Tento prohlížeč Picture-in-Picture nepodporuje');
        }

        const hidden = 'position:fixed;left:-99999px;top:0;width:2px;height:2px;pointer-events:none';
        const canvas = document.createElement('canvas');
        canvas.style.cssText = hidden;
        document.body.appendChild(canvas);

        renderer = makeRenderer(g.Renderer, canvas, { w: CFG.fallbackW, h: CFG.fallbackH });
        spec = null;
        step(1 / CFG.fallbackFps);                     // první snímek hned, ať má stream co poslat

        const video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = canvas.captureStream(CFG.fallbackFps);
        video.style.cssText = hidden;
        document.body.appendChild(video);
        pipVideo = { video: video, canvas: canvas };

        try {
            await video.play();
            await video.requestPictureInPicture();
        } catch (e) {
            cleanup();
            throw e;
        }
        video.addEventListener('leavepictureinpicture', () => cleanup(), { once: true });
        // setInterval místo rAF: stránka, která přehrává zvuk, se nebrzdí ani v pozadí
        timerId = setInterval(() => step(1 / CFG.fallbackFps), 1000 / CFG.fallbackFps);
        setState(true);
    }

    /* ------------------------------------------------------------------
       OTEVŘENÍ / ZAVŘENÍ / ÚKLID
       ------------------------------------------------------------------ */
    function isOpen() { return !!(pipWin || pipVideo); }

    async function open() {
        if (isOpen()) return;
        try {
            if ('documentPictureInPicture' in window) {
                try {
                    await openDocumentPip();
                    return;
                } catch (e) {
                    console.warn('[PiP spektrum] Document PiP selhalo, zkouším záložní režim:', e);
                    cleanup();
                }
            }
            await openVideoPip();
        } catch (e) {
            console.warn('[PiP spektrum]', e);
            flash('PiP nelze otevřít');
        }
    }

    function cleanup() {
        if (!pipWin && !pipVideo && !renderer) return;
        const win = pipWin;
        pipWin = null;                                  // smyčka okna se tím sama zastaví
        try { if (rafId && win) win.cancelAnimationFrame(rafId); } catch (e) { /* okno už je zavřené */ }
        rafId = 0;
        if (timerId) { clearInterval(timerId); timerId = 0; }
        if (pipVideo) {
            const v = pipVideo;
            pipVideo = null;
            try { if (document.pictureInPictureElement === v.video) document.exitPictureInPicture(); } catch (e) { /* nic */ }
            try { if (v.video.srcObject) v.video.srcObject.getTracks().forEach((t) => t.stop()); } catch (e) { /* nic */ }
            v.video.remove();
            v.canvas.remove();
        }
        renderer = null;
        spec = null;
        setState(false);
    }

    function close() {
        const win = pipWin;
        cleanup();
        try { if (win) win.close(); } catch (e) { /* nic */ }
    }

    function toggle() { return isOpen() ? close() : open(); }

    /* ------------------------------------------------------------------
       TLAČÍTKO (v pravém horním rohu panelu se spektrem)
       ------------------------------------------------------------------ */
    function setState(on) {
        if (!btn) return;
        btn.textContent = on ? '✖ Zavřít PiP' : '⧉ PiP';
        btn.style.background = on ? '#6FA8DC' : '#FF9F1C';
        btn.title = on ? 'Zavřít plovoucí okno se spektrem' : 'Otevřít spektrum v plovoucím okně (Picture-in-Picture)';
    }

    function flash(text) {
        if (!btn) return;
        btn.textContent = text;
        btn.style.background = '#CC6666';
        setTimeout(() => setState(isOpen()), 2500);
    }

    function buildButton() {
        if (document.getElementById(CFG.buttonId)) return;
        const supported = ('documentPictureInPicture' in window) || !!document.pictureInPictureEnabled;

        btn = document.createElement('button');
        btn.id = CFG.buttonId;
        btn.type = 'button';
        btn.style.cssText = [
            'position:absolute', 'top:8px', 'right:10px', 'z-index:5',
            'border:none', 'border-radius:999px', 'padding:4px 14px',
            'font:700 12px "Antonio","Arial Narrow",Arial,sans-serif',
            'letter-spacing:.05em', 'text-transform:uppercase',
            'color:#000', 'cursor:pointer', 'opacity:.92'
        ].join(';');

        const host = document.getElementById('spectrogramPlot') || document.body;
        if (host === document.body) {
            btn.style.position = 'fixed';
        } else if (getComputedStyle(host).position === 'static') {
            host.style.position = 'relative';
        }
        host.appendChild(btn);

        if (!supported) {
            btn.disabled = true;
            btn.style.opacity = '.45';
            btn.style.cursor = 'not-allowed';
            btn.textContent = '⧉ PiP';
            btn.style.background = '#888';
            btn.title = 'Tento prohlížeč Picture-in-Picture nepodporuje';
            return;
        }
        btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
        btn.addEventListener('mouseleave', () => { btn.style.opacity = '.92'; });
        btn.addEventListener('click', toggle);
        setState(false);
    }

    window.addEventListener('pagehide', close);
    window.LcarsPipSpectrum = { open: open, close: close, toggle: toggle, isOpen: isOpen, config: CFG };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', buildButton);
    } else {
        buildButton();
    }
})();
