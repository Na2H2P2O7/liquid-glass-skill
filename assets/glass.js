// Liquid glass renderer: the window is one rounded sheet of glass over the
// desktop wallpaper, and every [data-glass] panel is a thicker glass layer on
// top. The wallpaper image and the window's on-screen position come from
// Python (see Api.get_glass_backdrop / setWindowPos), so refraction lines up
// with the real desktop and follows the window while it is dragged.
//
// Outside the rounded sheet the shader outputs alpha 0 — with the pywebview
// window created transparent, those corners show the actual desktop.
(function () {
    'use strict';

    const MAX_PANELS = 12;
    const FRAME_INTERVAL = 1000 / 30;
    const THEME_LERP_MS = 400;
    const SHEET_RADIUS_CSS = 14;
    const SHEET_WARP = 0.12;
    const SHEET_BLUR_CSS = 8.0;
    const PANEL_WARP = 0.30;
    const PANEL_BLUR_CSS = 2.5;
    // "Pressed glass": the pointer locally deforms the sheet, bending the
    // refraction underneath. Radius/strength of the press in css px.
    const PRESS_SIGMA = 50.0;
    const PRESS_BASE = 0.42;
    const PRESS_BOOST = 0.34;

    const VERT_SRC = `
attribute vec2 aPos;
void main() {
    gl_Position = vec4(aPos, 0.0, 1.0);
}`;

    const FRAG_SRC = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif

#define MAX_PANELS ${MAX_PANELS}

uniform sampler2D uTex;
uniform vec2 uRes;          // canvas size, physical px
uniform float uDpr;
uniform vec2 uWinPos;       // window top-left on screen, css px
uniform vec2 uScreen;       // screen size, css px
uniform float uImgAspect;   // wallpaper aspect (w/h)
uniform float uSheetRadius; // physical px
uniform vec4 uSheetTint;    // rgb + amount
uniform vec4 uPanelTint;    // rgb + amount
uniform float uRim;
uniform int uPanelCount;
uniform vec4 uPanelRect[MAX_PANELS];    // center.xy, halfSize.xy (physical, y-up)
uniform vec4 uPanelParams[MAX_PANELS];  // radius, warp, highlight, blur css px
uniform vec4 uPress;                    // pointer css pos (y-down), strength, press boost

float sdRoundRect(vec2 p, vec2 halfSize, float r) {
    vec2 q = abs(p) - halfSize + r;
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

float dither(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453) - 0.5;
}

// Screen uv -> wallpaper uv with cover fit (wallpaper fills the screen).
vec2 coverUv(vec2 suv) {
    float sa = uScreen.x / uScreen.y;
    vec2 s = sa > uImgAspect ? vec2(1.0, uImgAspect / sa) : vec2(sa / uImgAspect, 1.0);
    return (suv - 0.5) * s + 0.5;
}

vec3 sampleWall(vec2 cssPos, float blurCss) {
    vec2 suv = (uWinPos + cssPos) / uScreen;
    vec2 st = vec2(blurCss) / uScreen;
    vec3 acc = vec3(0.0);
    for (int x = -1; x <= 1; x++) {
        for (int y = -1; y <= 1; y++) {
            acc += texture2D(uTex, coverUv(suv + vec2(float(x), float(y)) * st)).rgb;
        }
    }
    return acc / 9.0;
}

void main() {
    vec2 fragPx = gl_FragCoord.xy;
    vec2 cssPos = vec2(fragPx.x, uRes.y - fragPx.y) / uDpr; // css px, y-down
    vec2 halfRes = uRes * 0.5;

    float sdSheet = sdRoundRect(fragPx - halfRes, halfRes, uSheetRadius);
    float sheetMask = smoothstep(0.75, -0.75, sdSheet);
    if (sheetMask < 0.004) {
        gl_FragColor = vec4(0.0);
        return;
    }

    // Pressed glass: a gaussian bulge under the pointer bends the sampling
    // of the backdrop — the same refraction the sheet already does, locally
    // deepened, as if a fingertip were deforming the pane. Zero shift at the
    // press center, strongest pull in a ring around it.
    vec2 pv = cssPos - uPress.xy;
    float bulge = exp(-dot(pv, pv) / (2.0 * ${PRESS_SIGMA.toFixed(1)} * ${PRESS_SIGMA.toFixed(1)}));
    vec2 pressDisp = -pv * bulge * uPress.z *
        (${PRESS_BASE.toFixed(2)} + ${PRESS_BOOST.toFixed(2)} * uPress.w);

    // Window sheet: gentle lens warp near the window edge + frost.
    vec2 cssCenter = halfRes / uDpr;
    float innerS = clamp(-sdSheet / (26.0 * uDpr), 0.0, 1.0);
    float profS = (1.0 - innerS) * (1.0 - innerS);
    vec2 warpedS = cssCenter + (cssPos - cssCenter) * (1.0 - ${SHEET_WARP.toFixed(3)} * profS);
    vec3 col = sampleWall(warpedS + pressDisp, ${SHEET_BLUR_CSS.toFixed(1)});
    col = mix(col, uSheetTint.rgb, uSheetTint.a);
    float rimS = smoothstep(-2.5, -0.6, sdSheet) * smoothstep(0.75, -0.2, sdSheet);
    col += vec3(1.0) * rimS * uRim;

    // Panels: thicker glass — stronger warp, more blur, extra tint, rim light.
    for (int i = 0; i < MAX_PANELS; i++) {
        if (i >= uPanelCount) break;

        vec2 center = uPanelRect[i].xy;
        vec2 halfSize = uPanelRect[i].zw;
        vec2 p = fragPx - center;
        float sd = sdRoundRect(p, halfSize, uPanelParams[i].x);
        if (sd < 1.0) {
            float body = smoothstep(0.75, -0.75, sd);
            float highlight = uPanelParams[i].z;

            float edgeZone = min(min(halfSize.x, halfSize.y), 26.0 * uDpr) + 6.0 * uDpr;
            float inner = clamp(-sd / edgeZone, 0.0, 1.0);
            float prof = (1.0 - inner) * (1.0 - inner);
            float warp = uPanelParams[i].y * (1.0 + 0.6 * highlight) * prof;

            vec2 cCss = vec2(center.x, uRes.y - center.y) / uDpr;
            vec2 warped = cCss + (cssPos - cCss) * (1.0 - warp);

            // The press deforms the shared pane, so panels refract through
            // it too — slightly amplified, glass-on-glass.
            vec3 glass = sampleWall(warped + pressDisp * 1.4, uPanelParams[i].w);
            glass = mix(glass, uSheetTint.rgb, uSheetTint.a * 0.6);
            glass = mix(glass, uPanelTint.rgb, uPanelTint.a * (1.0 + 0.4 * highlight));

            float rim = smoothstep(-2.5, -0.6, sd) * smoothstep(0.75, -0.2, sd);
            float topBias = 0.5 + 0.5 * clamp(p.y / max(halfSize.y, 1.0), -1.0, 1.0);
            glass += vec3(1.0) * rim * (uRim + 0.22 * highlight) * (0.4 + 0.6 * topBias);

            col = mix(col, glass, body);
        }
    }

    col += dither(fragPx) / 255.0;
    col = clamp(col, 0.0, 1.0);
    gl_FragColor = vec4(col * sheetMask, sheetMask); // premultiplied alpha
}`;

    // Flattened theme vector: sheetTint rgba, panelTint rgba, rim.
    const THEMES = {
        light: [1.0, 1.0, 1.0, 0.50, 1.0, 1.0, 1.0, 0.12, 0.22],
        dark: [0.075, 0.075, 0.09, 0.54, 0.05, 0.05, 0.06, 0.16, 0.16],
    };

    const state = {
        gl: null,
        canvas: null,
        program: null,
        quad: null,
        tex: null,
        imgAspect: 1,
        panels: [],
        highlights: new Map(),
        themeCurrent: THEMES.light.slice(),
        themeTarget: THEMES.light.slice(),
        winPos: [0, 0],
        screen: [0, 0],
        sheetRadiusCss: SHEET_RADIUS_CSS,
        hasBackdrop: false,
        mode: 'wallpaper',
        frameToken: 0,
        // Pressed-glass state: raw pointer target, smoothed position (the
        // press trails the cursor slightly, like deforming real material),
        // eased strength (in-window) and boost (mouse held down).
        press: { x: -9999, y: -9999, sx: -9999, sy: -9999, strength: 0, targetStrength: 0, boost: 0, targetBoost: 0 },
        // Adaptive ink: low-res luminance copy of the backdrop + the text
        // elements whose color flips with the glass brightness behind them.
        lum: null,          // { data, w, h }
        inkTargets: [],
        lastInkCheck: 0,
        startTime: performance.now(),
        dpr: 1,
        lastFrame: 0,
        rafId: 0,
        pendingFrames: 30,
        contextLost: false,
        rectData: new Float32Array(MAX_PANELS * 4),
        paramData: new Float32Array(MAX_PANELS * 4),
        pointerData: new Float32Array(MAX_PANELS * 4),
    };

    // The render loop parks itself when nothing is animating; markDirty wakes
    // it up. Idle cost is therefore zero (no rAF ticks at all).
    function markDirty(frames) {
        state.pendingFrames = Math.max(state.pendingFrames, frames || 2);
        if (!state.rafId && !document.hidden && state.gl && !state.contextLost) {
            state.rafId = requestAnimationFrame(render);
        }
    }

    // Ease the press toward its targets; returns true while still settling
    // (the render loop keeps running until the glass has relaxed).
    function easePress(dt) {
        const p = state.press;
        const k = 1 - Math.exp(-dt / 70);
        if (p.sx < -9000) { p.sx = p.x; p.sy = p.y; }
        p.sx += (p.x - p.sx) * k;
        p.sy += (p.y - p.sy) * k;
        p.strength += (p.targetStrength - p.strength) * k * 0.7;
        p.boost += (p.targetBoost - p.boost) * k * 0.7;
        return Math.abs(p.x - p.sx) > 0.5 || Math.abs(p.y - p.sy) > 0.5 ||
               Math.abs(p.targetStrength - p.strength) > 0.005 ||
               Math.abs(p.targetBoost - p.boost) > 0.005;
    }

    function fallbackToCSS() {
        document.body.classList.add('no-webgl');
        if (state.canvas) state.canvas.style.display = 'none';
        if (state.rafId) cancelAnimationFrame(state.rafId);
    }

    function compile(gl, type, src) {
        const sh = gl.createShader(type);
        gl.shaderSource(sh, src);
        gl.compileShader(sh);
        if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
            console.error('Glass shader error:', gl.getShaderInfoLog(sh));
            gl.deleteShader(sh);
            return null;
        }
        return sh;
    }

    function initGL() {
        const gl = state.canvas.getContext('webgl', {
            alpha: true,
            premultipliedAlpha: true,
            depth: false,
            stencil: false,
            antialias: false,
            preserveDrawingBuffer: false,
        });
        if (!gl) return false;
        if (gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS) < 48) return false;
        state.gl = gl;

        const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
        const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
        if (!vs || !fs) return false;
        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
            console.error('Glass program link error:', gl.getProgramInfoLog(prog));
            return false;
        }
        const uniforms = {};
        [
            'uTex', 'uRes', 'uDpr', 'uWinPos', 'uScreen', 'uImgAspect',
            'uSheetRadius', 'uSheetTint', 'uPanelTint', 'uRim',
            'uPanelCount', 'uPanelRect[0]', 'uPanelParams[0]', 'uPress',
        ].forEach((name) => {
            uniforms[name] = gl.getUniformLocation(prog, name);
        });
        state.program = { prog, uniforms };

        state.quad = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, state.quad);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

        state.tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, state.tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        uploadPlaceholder();
        return true;
    }

    // Soft neutral gradient shown until the real wallpaper arrives (and in
    // browsers without the pywebview bridge).
    function uploadPlaceholder() {
        const gl = state.gl;
        const c = document.createElement('canvas');
        c.width = c.height = 64;
        const ctx = c.getContext('2d');
        const grad = ctx.createLinearGradient(0, 0, 64, 64);
        const dark = document.body.getAttribute('data-theme') === 'dark';
        grad.addColorStop(0, dark ? '#2c2c31' : '#e8e2f4');
        grad.addColorStop(0.5, dark ? '#1d1d21' : '#dde7f2');
        grad.addColorStop(1, dark ? '#141417' : '#efe9dd');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, 64, 64);
        gl.bindTexture(gl.TEXTURE_2D, state.tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
        state.imgAspect = 1;
    }

    function resizeCanvas() {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.max(1, Math.round(window.innerWidth * dpr));
        const h = Math.max(1, Math.round(window.innerHeight * dpr));
        if (state.canvas.width === w && state.canvas.height === h && state.dpr === dpr) return;
        state.dpr = dpr;
        state.canvas.width = w;
        state.canvas.height = h;
        markDirty(2);
    }

    function scanPanels() {
        state.panels = Array.from(document.querySelectorAll('[data-glass]'))
            .slice(0, MAX_PANELS)
            .map((el) => ({
                el,
                strength: parseFloat(el.dataset.glassStrength || '1') || 1,
                radius: parseFloat(getComputedStyle(el).borderRadius) || 0,
            }));

        state.panels.forEach((panel) => {
            if (!panel.el.hasAttribute('data-glass-hot')) return;
            const h = { current: 0, target: 0 };
            state.highlights.set(panel.el, h);
            const set = (v) => { h.target = v; markDirty(30); };
            panel.el.addEventListener('pointerenter', () => set(0.6));
            panel.el.addEventListener('pointerleave', () => set(0.0));
            panel.el.addEventListener('pointerdown', () => set(1.0));
            panel.el.addEventListener('pointerup', () => set(0.6));
            panel.el.addEventListener('pointercancel', () => set(0.0));
        });
    }

    function refreshRadii() {
        state.panels.forEach((panel) => {
            panel.radius = parseFloat(getComputedStyle(panel.el).borderRadius) || 0;
        });
    }

    function updatePanelUniforms(dt) {
        const { dpr, rectData, paramData } = state;
        const canvasH = state.canvas.height;
        const smooth = 1 - Math.exp(-dt / 90);
        let count = 0;
        let animating = false;

        for (const panel of state.panels) {
            const rect = panel.el.getBoundingClientRect();
            if (rect.width < 2 || rect.height < 2) continue;

            const h = state.highlights.get(panel.el);
            if (h) {
                h.current += (h.target - h.current) * smooth;
                if (Math.abs(h.target - h.current) > 0.002) animating = true;
            }

            const i = count * 4;
            rectData[i] = (rect.left + rect.width / 2) * dpr;
            rectData[i + 1] = canvasH - (rect.top + rect.height / 2) * dpr;
            rectData[i + 2] = (rect.width / 2) * dpr;
            rectData[i + 3] = (rect.height / 2) * dpr;
            paramData[i] = Math.min(panel.radius * dpr, rectData[i + 2], rectData[i + 3]);
            paramData[i + 1] = PANEL_WARP * panel.strength;
            paramData[i + 2] = h ? h.current : 0;
            paramData[i + 3] = PANEL_BLUR_CSS;
            count++;
        }
        if (animating) markDirty(2);
        return count;
    }

    function lerpTheme(dt) {
        const k = 1 - Math.exp(-dt / (THEME_LERP_MS / 4));
        const cur = state.themeCurrent;
        const tgt = state.themeTarget;
        let animating = false;
        for (let i = 0; i < cur.length; i++) {
            cur[i] += (tgt[i] - cur[i]) * k;
            if (Math.abs(tgt[i] - cur[i]) > 0.003) animating = true;
        }
        if (animating) markDirty(2);
    }

    function render(now) {
        if (state.pendingFrames <= 0) {
            state.rafId = 0;
            return;
        }
        state.rafId = requestAnimationFrame(render);
        const elapsed = now - state.lastFrame;
        if (elapsed < FRAME_INTERVAL) return;
        state.pendingFrames--;
        const dt = Math.min(elapsed, 100);
        state.lastFrame = now;

        const gl = state.gl;
        resizeCanvas();
        lerpTheme(dt);
        if (easePress(dt)) markDirty(2);

        const panelCount = updatePanelUniforms(dt);
        const c = state.themeCurrent;
        const screenW = state.screen[0] || window.innerWidth;
        const screenH = state.screen[1] || window.innerHeight;

        gl.viewport(0, 0, state.canvas.width, state.canvas.height);
        gl.useProgram(state.program.prog);
        gl.bindBuffer(gl.ARRAY_BUFFER, state.quad);
        const loc = gl.getAttribLocation(state.program.prog, 'aPos');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

        const u = state.program.uniforms;
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, state.tex);
        gl.uniform1i(u['uTex'], 0);
        gl.uniform2f(u['uRes'], state.canvas.width, state.canvas.height);
        gl.uniform1f(u['uDpr'], state.dpr);
        gl.uniform2f(u['uWinPos'], state.winPos[0], state.winPos[1]);
        gl.uniform2f(u['uScreen'], screenW, screenH);
        gl.uniform1f(u['uImgAspect'], state.imgAspect);
        gl.uniform1f(u['uSheetRadius'], state.sheetRadiusCss * state.dpr);
        gl.uniform4f(u['uSheetTint'], c[0], c[1], c[2], c[3]);
        gl.uniform4f(u['uPanelTint'], c[4], c[5], c[6], c[7]);
        gl.uniform1f(u['uRim'], c[8]);
        gl.uniform1i(u['uPanelCount'], panelCount);
        gl.uniform4fv(u['uPanelRect[0]'], state.rectData);
        gl.uniform4fv(u['uPanelParams[0]'], state.paramData);
        const pr = state.press;
        gl.uniform4f(u['uPress'], pr.sx, pr.sy, pr.strength, pr.boost);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // The render loop only runs while something changes (move, resize,
        // theme, live frames) — exactly when text contrast may need to flip.
        if (now - state.lastInkCheck > 200) {
            state.lastInkCheck = now;
            adaptInk();
        }
    }

    function start() {
        if (state.rafId) cancelAnimationFrame(state.rafId);
        state.lastFrame = 0;
        markDirty(5);
        state.rafId = requestAnimationFrame(render);
    }

    function init() {
        state.canvas = document.getElementById('glassCanvas');
        if (!state.canvas || !initGL()) {
            fallbackToCSS();
            return;
        }

        resizeCanvas();
        scanPanels();
        state.inkTargets = Array.from(document.querySelectorAll('[data-ink]'))
            .map((el) => ({ el, mode: el.dataset.ink, ink: null }));

        window.addEventListener('resize', () => {
            resizeCanvas();
            refreshRadii();
            markDirty(5);
        });

        // Elastic hover shifts panel rects for a few hundred ms after each
        // pointer move — keep rendering while that settles. The pointer is
        // also the "fingertip" pressing the glass.
        window.addEventListener('pointermove', (e) => {
            state.press.x = e.clientX;
            state.press.y = e.clientY;
            state.press.targetStrength = 1;
            markDirty(15);
        });
        window.addEventListener('pointerdown', () => {
            state.press.targetBoost = 1;
            markDirty(30);
        });
        window.addEventListener('pointerup', () => {
            state.press.targetBoost = 0;
            markDirty(30);
        });
        document.addEventListener('pointerleave', () => {
            state.press.targetStrength = 0;
            state.press.targetBoost = 0;
            markDirty(40);
        });

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                cancelAnimationFrame(state.rafId);
                state.rafId = 0;
            } else if (!state.contextLost) {
                start();
            }
        });

        state.canvas.addEventListener('webglcontextlost', (e) => {
            e.preventDefault();
            state.contextLost = true;
            cancelAnimationFrame(state.rafId);
            state.rafId = 0;
        });
        state.canvas.addEventListener('webglcontextrestored', () => {
            state.contextLost = false;
            if (initGL()) {
                start();
            } else {
                fallbackToCSS();
            }
        });

        const initialTheme = document.body.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        state.themeCurrent = THEMES[initialTheme].slice();
        state.themeTarget = THEMES[initialTheme].slice();

        start();
    }

    // Decode + upload a backdrop image; the token guards against out-of-order
    // decodes when live frames arrive faster than they decode.
    function uploadImage(dataUrl, token) {
        const img = new Image();
        img.onload = () => {
            if (token !== state.frameToken || !state.gl) return;
            const gl = state.gl;
            gl.bindTexture(gl.TEXTURE_2D, state.tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
            state.imgAspect = img.width / img.height;
            state.hasBackdrop = true;
            captureLuminance(img);
            markDirty(3);
        };
        img.src = dataUrl;
    }

    // Keep a tiny CPU-side copy of the backdrop for text-contrast decisions.
    function captureLuminance(img) {
        const w = 64;
        const h = Math.max(8, Math.round((img.height / img.width) * 64));
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, w, h);
        state.lum = { data: ctx.getImageData(0, 0, w, h).data, w, h };
    }

    function rgbLum(r, g, b) {
        return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    }

    // Average backdrop luminance behind an element rect, mapped through the
    // same window-position + cover-fit transform the shader uses, then mixed
    // with the sheet/panel frost tints so it matches what is actually drawn.
    function glassLuminance(rect, mode) {
        const lum = state.lum;
        if (!lum) return null;
        const screenW = state.screen[0] || window.innerWidth;
        const screenH = state.screen[1] || window.innerHeight;
        const sa = screenW / screenH;
        const ia = state.imgAspect;
        const scaleX = sa > ia ? 1 : sa / ia;
        const scaleY = sa > ia ? ia / sa : 1;

        let total = 0;
        let count = 0;
        for (let gy = 0; gy < 3; gy++) {
            for (let gx = 0; gx < 4; gx++) {
                const cssX = rect.left + (rect.width * (gx + 0.5)) / 4;
                const cssY = rect.top + (rect.height * (gy + 0.5)) / 3;
                const su = (state.winPos[0] + cssX) / screenW;
                const sv = (state.winPos[1] + cssY) / screenH;
                const iu = Math.min(1, Math.max(0, (su - 0.5) * scaleX + 0.5));
                const iv = Math.min(1, Math.max(0, (sv - 0.5) * scaleY + 0.5));
                const px = Math.min(lum.w - 1, Math.round(iu * (lum.w - 1)));
                const py = Math.min(lum.h - 1, Math.round(iv * (lum.h - 1)));
                const i = (py * lum.w + px) * 4;
                total += rgbLum(lum.data[i], lum.data[i + 1], lum.data[i + 2]);
                count++;
            }
        }
        let value = total / count;

        const c = state.themeCurrent;
        const sheetLum = rgbLum(c[0] * 255, c[1] * 255, c[2] * 255);
        if (mode === 'panel') {
            value = value * (1 - c[3] * 0.6) + sheetLum * c[3] * 0.6;
            const panelLum = rgbLum(c[4] * 255, c[5] * 255, c[6] * 255);
            value = value * (1 - c[7]) + panelLum * c[7];
        } else {
            value = value * (1 - c[3]) + sheetLum * c[3];
        }
        return value;
    }

    // Flip each labeled element between dark and light ink with hysteresis
    // (flip dark above 0.60, light below 0.50) so live-mode frames that
    // hover around the threshold don't flicker the text.
    function adaptInk() {
        for (const target of state.inkTargets) {
            const rect = target.el.getBoundingClientRect();
            if (rect.width < 2 || rect.height < 2) continue;
            const lumValue = glassLuminance(rect, target.mode);
            if (lumValue === null) continue;
            let ink = target.ink;
            if (lumValue > 0.60) ink = 'dark';
            else if (lumValue < 0.50) ink = 'light';
            if (ink === target.ink || !ink) continue;
            target.ink = ink;
            if (ink === 'dark') {
                target.el.style.setProperty('--ink', '#1A1918');
                target.el.style.setProperty('--ink-2', 'rgba(26, 25, 24, 0.68)');
            } else {
                target.el.style.setProperty('--ink', '#FFFFFF');
                target.el.style.setProperty('--ink-2', 'rgba(255, 255, 255, 0.78)');
            }
        }
    }

    window.LiquidGlass = {
        setTheme(name) {
            if (THEMES[name]) {
                state.themeTarget = THEMES[name].slice();
                if (!state.hasBackdrop) uploadPlaceholder();
                markDirty(30);
            }
        },
        // Called by Python whenever the window moves or resizes. In live mode
        // each captured frame carries its own mapping, so ignore these.
        setWindowPos(x, y) {
            if (state.mode === 'live') return;
            state.winPos[0] = x;
            state.winPos[1] = y;
            markDirty(3);
        },
        // Called once the wallpaper is known (and again when leaving live mode).
        setBackdrop(info) {
            if (!info || !state.gl) return;
            state.mode = 'wallpaper';
            state.frameToken++;
            if (typeof info.winX === 'number') state.winPos = [info.winX, info.winY];
            if (info.screenW > 0) state.screen = [info.screenW, info.screenH];
            if (info.transparent === false) state.sheetRadiusCss = 0;
            if (!info.dataUrl) return;
            uploadImage(info.dataUrl, state.frameToken);
        },
        // Called ~7x/s by Python while live screen capture is enabled.
        setLiveFrame(info) {
            if (!info || !state.gl || !info.dataUrl) return;
            state.mode = 'live';
            state.frameToken++;
            state.winPos = [info.winX, info.winY];
            state.screen = [info.screenW, info.screenH];
            uploadImage(info.dataUrl, state.frameToken);
        },
        get available() {
            return !!state.gl && !state.contextLost;
        },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
