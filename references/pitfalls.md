# Liquid Glass — Pitfalls

Every entry here cost real debugging time. Read before changing the shader
or the backdrop pipeline; each explains *why*, so you can judge when it
applies to your change.

## Rendering

**`mediump` produces concentric ripple artifacts on Apple GPUs.**
WKWebView's `mediump` is fp16 (~10-bit mantissa). UV coordinates quantize to
~1/1024 steps, which magnified through the lens warp appear as concentric
banding rings across the glass. Fix: `#ifdef GL_FRAGMENT_PRECISION_HIGH →
precision highp float`. Do not "optimize" back to mediump.

**Sparse blur taps over a sharp texture ⇒ multi-exposure ghosting, not blur.**
A 3×3 kernel with 8–9px spacing produces nine visible copies of the image.
The pipeline instead: downscale the backdrop to ~720px, gaussian pre-blur it
CPU-side (PIL), let bilinear magnification do free smoothing, then use small
tap spacings (2–8px) for the final softness. If frost looks "ghosted",
lower tap spacing or raise the pre-blur, don't add taps.

**8-bit output bands on slow dark gradients.** Add ±1/255 dither per pixel
(cheap hash noise) before writing gl_FragColor.

**Transparent canvas needs premultiplied alpha.** The WebGL context defaults
to `premultipliedAlpha: true`; output `vec4(color * alpha, alpha)` or edges
render with bright fringes.

**GLSL ES 1.00 limits.** No array initializers; loops need compile-time
bounds (`for (i < MAX_PANELS)` + runtime `break`). Uniform budget: check
`MAX_FRAGMENT_UNIFORM_VECTORS >= 48` at init and fall back to CSS otherwise
(the guaranteed minimum is only 16; Apple/ANGLE report 224+).

## Window / platform

**A web view cannot see the pixels behind its window.** Neither CSS
`backdrop-filter` nor WebGL can sample the desktop. That's the whole reason
Python feeds the wallpaper or a screen capture as a texture. Don't attempt
`backdrop-filter: url(#displacement)` — SVG filters in backdrop-filter are
Chromium-only and still can't see the desktop.

**Native macOS fullscreen kills the effect twice.** `toggle_fullscreen()`
moves the window into its own Space: the system gives it an opaque backing
(transparency dies) AND nothing sits behind it for live capture. Use the
zoom-maximize in `glass_backdrop.py` (resize to `NSScreen.visibleFrame`).

**pywebview `transparent=True` is macOS-only.** Windows/WebView2 windows stay
opaque; pass `transparent: false` in the backdrop payload so the sheet
corners square off, and the wallpaper refraction reads as fake transparency.

**Live capture needs Screen Recording permission**, granted per *host app*
(Terminal during dev, the packaged .app in production) and only takes effect
after relaunch. `CGPreflightScreenCaptureAccess()` to check,
`CGRequestScreenCaptureAccess()` to prompt. `CGWindowListCreateImage` with
`kCGWindowListOptionOnScreenBelowWindow` excludes the window itself — no
feedback loop.

**Wallpapers are often HEIC** (macOS dynamic wallpapers). PIL can't read
them without extras; shell out to `sips` (ships with macOS) to convert.

## Performance

**Park the render loop.** Nothing here animates by itself: when no pointer /
drag / theme-lerp / live-frame activity is pending, stop scheduling rAF
entirely (`markDirty` restarts it). This is the difference between 0% and
~4% idle CPU. Cap DPR at 2, throttle to 30fps.

**Read panel rects every rendered frame, not on events.** It sounds
expensive but ~12 `getBoundingClientRect` calls at 30fps is negligible, and
it makes elastic hover transforms, layout shifts, and resizes track for free.

**Guard async texture uploads with a token.** Live frames decode via
`new Image()`; out-of-order decodes must be dropped
(`token !== state.frameToken → return`) or old frames flash.

## Verifying

**Headless-Chrome screenshots of WebGL under `--virtual-time-budget` are
unreliable** — the composited frame may predate your texture upload even
though `onload` fired. Verify glass rendering in the real app (screencapture
of the actual window); use pixel-diff of two frames to confirm the WebGL
path is live vs the static CSS fallback.

**Static screenshots understate the effect.** Refraction and press
deformation read 10× stronger in motion. Before weakening constants because
a screenshot looks subtle, wiggle the window/pointer and watch it live.
