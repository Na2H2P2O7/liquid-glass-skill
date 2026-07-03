# Liquid Glass — Integration Guide

Step-by-step wiring for both target environments. Read the whole file before
starting; the pieces depend on each other.

## Architecture in one paragraph

One full-screen WebGL canvas renders the entire window as a rounded sheet of
frosted glass over a backdrop texture; every element marked `data-glass`
becomes a clearer "lens" panel that bends the backdrop at its edges
(rounded-rect SDF + lens warp). The pointer acts as a fingertip pressing the
pane (gaussian displacement of the refraction). The DOM floats transparently
above the canvas, contributing only text/icons. Python (pywebview) supplies
what the web view cannot see: the wallpaper or a live screen capture, plus
the window's on-screen position. Text elements marked `data-ink` flip
between dark/light ink based on the actual rendered glass luminance.

## 1. Copy the assets

- `assets/glass.js` → the app's static web directory (load before your app JS).
- `assets/glass_backdrop.py` → next to the pywebview entry module
  (skip for browser-only projects).

## 2. HTML wiring

```html
<body>
    <canvas id="glassCanvas"></canvas>   <!-- first child of body -->

    <!-- panels: any element that should be a glass lens -->
    <div class="main-button" data-glass data-glass-hot data-ink="panel">Go</div>
    <div class="log" data-glass data-ink="panel"></div>
    <!-- small/pill elements: damp the warp so they don't distort wildly -->
    <div class="progress-track" data-glass data-glass-strength="0.4"></div>

    <script src="glass.js"></script>
    <script src="app.js"></script>
</body>
```

Attribute meanings:

| Attribute | Effect |
|---|---|
| `data-glass` | Element becomes a refractive glass panel (max 12; raise `MAX_PANELS` in glass.js if needed — watch uniform budget) |
| `data-glass-hot` | Interactive: hover/press brightens rim + deepens warp |
| `data-glass-strength="0.4"` | Scales edge warp (default 1); use 0.4–0.6 for pills/toggles |
| `data-ink="panel"` / `data-ink="sheet"` | Adaptive text ink; `panel` for elements that are glass panels, `sheet` for labels sitting directly on the window sheet |

Corner radii are read from each element's computed `border-radius` — style
normally in CSS and the shader matches exactly (pills included).

## 3. CSS requirements

```css
body {
  background: transparent;   /* the canvas paints everything */
  overflow: hidden;
}

#glassCanvas {
  position: fixed;
  inset: 0;
  width: 100vw;
  height: 100vh;
  z-index: 0;
  pointer-events: none;
}

/* every content container must stack above the canvas */
.titlebar, .main-content, .statusbar {
  position: relative;
  z-index: 1;
}
```

Glass panels themselves should have **transparent or faint-tint backgrounds**
(e.g. `rgba(255,255,255,0.14)` light / `rgba(255,255,255,0.05)` dark) plus a
1px hairline border — the shader draws the frost and rim, but a CSS hairline
keeps edges crisp at 1x DPR. Do NOT use `backdrop-filter` on them (the shader
replaces it). Accent buttons keep a translucent accent tint (~0.4 alpha) so
refraction shows through the color.

Adaptive ink hookup — point text colors at the ink variables with the theme
color as fallback:

```css
.title    { color: var(--ink,   var(--text-primary)); }
.label    { color: var(--ink-2, var(--text-secondary)); }
```

Fallback for machines without WebGL — keep a `body.no-webgl` block restoring
opaque backgrounds + plain `backdrop-filter` blur on the panel selectors
(glass.js adds that class automatically when it can't run).

## 4. JS API (window.LiquidGlass)

| Method | When to call |
|---|---|
| `setBackdrop({dataUrl, screenW, screenH, winX, winY, transparent})` | Once the backdrop image is known; again to change it |
| `setLiveFrame({dataUrl, screenW, screenH, winX, winY})` | Streamed by Python in live mode (~7fps) |
| `setWindowPos(x, y)` | Pushed by Python on window move/resize (ignored in live mode) |
| `setTheme('light'│'dark')` | On theme toggle — lerps glass tints over ~400ms |
| `available` | False when fallen back to CSS |

App-side theme toggle example:

```js
body.toggleAttribute('data-theme');  // however the app switches
if (window.LiquidGlass) LiquidGlass.setTheme(isDark ? 'dark' : 'light');
```

## 5. pywebview wiring

```python
import webview
from glass_backdrop import GlassBackdrop, glass_window_options

class Api(GlassBackdrop):
    def __init__(self):
        super().__init__()
        # ... your app state

api = Api()
window = webview.create_window("MyApp", url, js_api=api,
                               width=760, height=640, **glass_window_options())
api.attach_glass(window)
webview.start()
```

Page-side bootstrap (in the app JS):

```js
window.addEventListener('pywebviewready', async () => {
    const backdrop = await pywebview.api.get_glass_backdrop();
    if (window.LiquidGlass) LiquidGlass.setBackdrop(backdrop);
});
```

Live mode toggle (optional UI): call `pywebview.api.set_backdrop_mode('live')`;
on `{ok:false, reason:'permission'}` tell the user to grant Screen Recording
and relaunch. Switching back: `set_backdrop_mode('wallpaper')` then re-fetch
`get_glass_backdrop()` into `setBackdrop`.

Custom wallpaper picker (optional UI): call
`pywebview.api.select_backdrop_image()` — opens a native image dialog and
returns `{ok, backdrop, reset?}`. Feed `result.backdrop` into
`LiquidGlass.setBackdrop`. The system wallpaper stays the default;
cancelling the dialog while a custom image is active resets to it
(`reset: true`). If live mode is on, switch back to wallpaper mode first —
picking a wallpaper implies wallpaper mode.

Maximize button: call `pywebview.api.toggle_zoom_maximize()` — NOT
`toggle_fullscreen()` (see pitfalls.md).

## 6. Browser-only projects (no pywebview)

Everything works with any image as backdrop — no transparency, but full glass:

```js
LiquidGlass.setBackdrop({
    dataUrl: '/img/backdrop.jpg',      // any URL or data URL, pre-blur it lightly
    screenW: innerWidth, screenH: innerHeight,
    winX: 0, winY: 0,
    transparent: false,                 // squares the sheet corners
});
```

Until `setBackdrop` is called, glass.js shows a neutral gradient placeholder,
so the page never looks broken.

## 7. Tuning knobs

All in the constants block at the top of `glass.js`:

| Constant | Default | Meaning |
|---|---|---|
| `SHEET_RADIUS_CSS` | 14 | Window corner radius (css px) |
| `SHEET_WARP` | 0.12 | Edge lens strength of the window sheet |
| `SHEET_BLUR_CSS` | 8.0 | Sheet frost blur (css px) |
| `PANEL_WARP` | 0.30 | Panel edge lens strength ("liquid" feel lives here) |
| `PANEL_BLUR_CSS` | 2.5 | Panel blur — lower = clearer lens vs frostier sheet |
| `PRESS_SIGMA` | 50 | Pressed-glass fingertip radius (css px) |
| `PRESS_BASE` | 0.42 | Press depth while hovering |
| `PRESS_BOOST` | 0.34 | Extra depth while mouse is down |
| `THEMES` | — | Per-theme sheet/panel tint rgba + rim intensity |
| ink thresholds | 0.60/0.50 | In `adaptInk()` — flip-to-dark / flip-to-light luminance with hysteresis |

Python side (`glass_backdrop.py`): wallpaper pre-blur `GaussianBlur(2.5)` and
720px size; live capture fps (`LIVE_INTERVAL`), margin, 640px/blur 1.5.

## 8. Verification checklist

Run the real app and confirm:

1. Backdrop visible through the glass; panel edges visibly bend it.
2. Drag the window — refraction tracks (wallpaper mode).
3. Hover/press a `data-glass-hot` element — rim brightens, press deepens the local refraction.
4. Toggle theme — smooth tint lerp, no flash.
5. Text readable over both bright and dark backdrop regions (adaptive ink flips).
6. Idle CPU ≈ 0% (Activity Monitor) — the loop must park.
7. Resize/maximize — panels never detach; corners stay rounded.
8. Screenshot-diff two frames if unsure whether WebGL path is active (fallback is static).
