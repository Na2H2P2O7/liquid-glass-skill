---
name: liquid-glass
description: Give any web-based desktop UI (pywebview, Electron-like shells, or plain web pages) a true Apple-style liquid glass treatment — a transparent window rendered as refractive frosted glass over the real desktop wallpaper or a live screen capture, with pressed-glass pointer deformation and backdrop-adaptive text color. Ships a proven WebGL renderer (glass.js) and a pywebview backend (glass_backdrop.py); do NOT hand-roll shaders or use CSS backdrop-filter for this. Use whenever the user mentions liquid glass / 液态玻璃 / 玻璃拟态 / glassmorphism, frosted or translucent windows, refraction effects, "Apple-style" glass UI, transparent desktop apps, glass buttons with press/ripple feedback, or wants a desktop shell to refract what is behind it — even if they only say "make it look like glass".
---

# Liquid Glass UI

A battle-tested recipe for real liquid glass: one full-screen WebGL shader
draws the whole window as a rounded frosted sheet over a backdrop texture,
every `data-glass` element becomes a clearer lens that bends the backdrop at
its edges, and the pointer presses the pane like a fingertip. Built and
proven in the Mediatag app (github.com/Na2H2P2O7/Mediatag).

The core insight: a web view cannot see the pixels behind its window, so a
Python (or other host) side feeds the refraction source — the desktop
wallpaper (no permission needed) or a ~7fps below-window screen capture —
plus live window coordinates, and the shader aligns the refraction with the
real desktop pixel-for-pixel.

## What's bundled

- `assets/glass.js` — the complete renderer, drop-in. Sheet + panel SDF
  refraction, pressed-glass deformation, adaptive text ink, theme lerp,
  live-frame streaming, context-loss recovery, CSS fallback, and a render
  loop that fully parks at 0% CPU when idle. Configuration via constants at
  the top and `data-*` attributes in HTML. Exposes `window.LiquidGlass`.
- `assets/glass_backdrop.py` — pywebview backend mixin: wallpaper reading
  (HEIC-safe via sips, PIL pre-blur), live screen capture with permission
  handling, window-position sync, transparent-window options, and a
  zoom-maximize that doesn't kill transparency.
- `references/integration.md` — exact wiring steps (HTML attributes, CSS
  requirements, JS/Python APIs, browser-only usage) and the tuning table.
- `references/pitfalls.md` — the traps that cost real debugging time
  (fp16 ripples, blur ghosting, fullscreen Spaces, permission model…).

## Workflow

1. **Read `references/integration.md` first** — it is the authoritative
   wiring guide. Skim `references/pitfalls.md` before touching the shader
   or the capture pipeline.
2. **Pick the backdrop source** with the user if unclear:
   - pywebview on macOS → transparent window + wallpaper (default) and
     optional live capture toggle;
   - Windows / browser-only → opaque window, same refraction over a
     wallpaper or any supplied image.
3. **Copy the assets into the project** (don't rewrite them — they encode
   the pitfalls). Rename the `LiquidGlass` global only if the project
   demands it.
4. **Wire per integration.md**: canvas first in `<body>`, `data-glass` /
   `data-glass-hot` / `data-glass-strength` / `data-ink` attributes,
   transparent body + z-index CSS, panel tints with hairline borders,
   `GlassBackdrop` mixin on the js_api class, backdrop fetch on
   `pywebviewready`.
5. **Tune to the design** using the constants table (warp/blur/press/tints).
   The glass reads much stronger in motion than in screenshots — judge by
   dragging the window and sweeping the pointer, not stills.
6. **Verify with the checklist** at the end of integration.md — especially
   edge refraction visibility, adaptive ink flips over bright/dark content,
   and idle CPU parking (~0%).

## Adapting beyond pywebview

The renderer only needs three things from its host: a backdrop image, the
window's position on screen, and (optionally) live frames. Any host that can
supply those — Electron via IPC, Tauri, even a static web page passing a
fixed image — gets the full effect. The press deformation, panel lenses, and
adaptive ink are host-independent.
