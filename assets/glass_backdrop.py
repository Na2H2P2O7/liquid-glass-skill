"""Backdrop and window plumbing for the liquid glass UI (pywebview).

A web view cannot see the pixels behind its window, so Python supplies the
refraction source: the desktop wallpaper (no permission needed) or a live
below-window screen capture (needs Screen Recording permission on macOS).
It also streams the window's on-screen position so the shader's refraction
lines up with the real desktop and follows drags.

Usage — subclass GlassBackdrop in your pywebview js_api class so the JS side
can call get_glass_backdrop / set_backdrop_mode directly:

    import webview
    from glass_backdrop import GlassBackdrop, glass_window_options

    class Api(GlassBackdrop):
        ...  # your own api methods

    api = Api()
    window = webview.create_window("MyApp", url, js_api=api,
                                   width=760, height=640,
                                   **glass_window_options())
    api.attach_glass(window)
    webview.start()

Requires Pillow. On macOS, pyobjc (installed with pywebview) provides
AppKit/Quartz; `sips` (ships with macOS) converts HEIC dynamic wallpapers.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import platform
import subprocess
import tempfile
import threading
import time
from pathlib import Path

IS_MAC = platform.system() == "Darwin"


def glass_window_options() -> dict:
    """kwargs to merge into webview.create_window for a glass window.

    macOS gets a real transparent window; Windows stays opaque (WebView2
    does not support transparency) but draws the same wallpaper refraction,
    which reads as fake-transparent over the desktop.
    """
    options: dict = {"frameless": True}
    if IS_MAC:
        options["transparent"] = True
        options["easy_drag"] = True
    else:
        options["background_color"] = "#FFFFFF"
    return options


def _encode_wallpaper(path: Path) -> str | None:
    """Downscale + pre-blur the wallpaper and return a JPEG data URL.

    The shader magnifies this texture, so the gaussian pre-blur here is what
    makes the frost look creamy instead of ghosted (sparse blur taps over a
    sharp texture produce multi-exposure artifacts). Cached by source mtime.
    """
    try:
        from PIL import Image, ImageFilter

        stat = path.stat()
        key = hashlib.md5(f"{path}-{stat.st_mtime}-{stat.st_size}".encode()).hexdigest()
        cached = Path(tempfile.gettempdir()) / f"liquid-glass-wallpaper-{key}.jpg"
        if not cached.exists():
            source = path
            converted: Path | None = None
            if IS_MAC and path.suffix.lower() not in {".jpg", ".jpeg", ".png"}:
                # sips ships with macOS and handles HEIC dynamic wallpapers.
                converted = Path(tempfile.gettempdir()) / f"liquid-glass-wallpaper-{key}-src.jpg"
                subprocess.run(
                    ["sips", "-s", "format", "jpeg", "-Z", "1600", str(path), "--out", str(converted)],
                    check=True,
                    capture_output=True,
                )
                source = converted
            with Image.open(source) as img:
                img = img.convert("RGB")
                img.thumbnail((720, 720))
                img = img.filter(ImageFilter.GaussianBlur(2.5))
                img.save(cached, "JPEG", quality=88)
            if converted is not None:
                converted.unlink(missing_ok=True)
        data = base64.b64encode(cached.read_bytes()).decode()
        return f"data:image/jpeg;base64,{data}"
    except Exception:
        return None


def _wallpaper_info() -> tuple[str | None, float, float]:
    """Return (data_url, screen_w, screen_h) for the primary screen wallpaper."""
    try:
        if IS_MAC:
            from AppKit import NSScreen, NSWorkspace

            screen = NSScreen.screens()[0]
            frame = screen.frame()
            url = NSWorkspace.sharedWorkspace().desktopImageURLForScreen_(screen)
            if url is None:
                return None, 0.0, 0.0
            data_url = _encode_wallpaper(Path(url.path()))
            return data_url, float(frame.size.width), float(frame.size.height)
        if platform.system() == "Windows":
            import ctypes

            buffer = ctypes.create_unicode_buffer(512)
            ctypes.windll.user32.SystemParametersInfoW(0x0073, 512, buffer, 0)
            width = ctypes.windll.user32.GetSystemMetrics(0)
            height = ctypes.windll.user32.GetSystemMetrics(1)
            wallpaper = Path(buffer.value)
            if wallpaper.is_file():
                return _encode_wallpaper(wallpaper), float(width), float(height)
    except Exception:
        pass
    return None, 0.0, 0.0


def _own_window_number() -> int | None:
    """CGWindowNumber of this app's window, for below-window screen capture."""
    import Quartz

    pid = os.getpid()
    windows = Quartz.CGWindowListCopyWindowInfo(
        Quartz.kCGWindowListOptionOnScreenOnly, Quartz.kCGNullWindowID
    )
    for win in windows or []:
        if win.get("kCGWindowOwnerPID") == pid and win.get("kCGWindowLayer", 0) == 0:
            return win.get("kCGWindowNumber")
    return None


def _cgimage_to_jpeg_data_url(cg_image) -> str | None:
    """Convert a CGImage to a small, pre-blurred JPEG data URL."""
    import Quartz
    from PIL import Image, ImageFilter

    width = Quartz.CGImageGetWidth(cg_image)
    height = Quartz.CGImageGetHeight(cg_image)
    row_bytes = Quartz.CGImageGetBytesPerRow(cg_image)
    data = Quartz.CGDataProviderCopyData(Quartz.CGImageGetDataProvider(cg_image))
    img = Image.frombuffer("RGBA", (width, height), bytes(data), "raw", "BGRA", row_bytes, 1)
    img = img.convert("RGB")
    img.thumbnail((640, 640))
    img = img.filter(ImageFilter.GaussianBlur(1.5))
    buffer = io.BytesIO()
    img.save(buffer, "JPEG", quality=70)
    return "data:image/jpeg;base64," + base64.b64encode(buffer.getvalue()).decode()


class GlassBackdrop:
    """Mixin for a pywebview js_api class: backdrop + window sync for glass.js."""

    LIVE_MARGIN = 32
    LIVE_INTERVAL = 1.0 / 7

    def __init__(self) -> None:
        self._glass_window = None
        self._live_active = False
        self._live_thread: threading.Thread | None = None
        self._saved_frame: tuple[int, int, int, int] | None = None

    # -- wiring ----------------------------------------------------------

    def attach_glass(self, window) -> None:
        """Call once after create_window: hooks move/resize events to the shader."""
        self._glass_window = window
        window.events.moved += self._push_window_position
        window.events.resized += self._push_window_position
        window.events.restored += self._push_window_position

    def _push_window_position(self, *_args) -> None:
        window = self._glass_window
        if window is None:
            return
        try:
            window.evaluate_js(
                "window.LiquidGlass && window.LiquidGlass.setWindowPos(%d, %d)"
                % (window.x, window.y)
            )
        except Exception:
            pass

    def _glass_eval(self, script: str) -> None:
        if self._glass_window is not None:
            try:
                self._glass_window.evaluate_js(script)
            except Exception:
                pass

    # -- js_api methods (exposed to the page automatically) ---------------

    def get_glass_backdrop(self) -> dict:
        """Wallpaper + window placement; JS calls this once on pywebviewready."""
        data_url, screen_w, screen_h = _wallpaper_info()
        win_x = win_y = 0
        window = self._glass_window
        if window is not None:
            try:
                win_x, win_y = window.x, window.y
            except Exception:
                pass
        return {
            "dataUrl": data_url,
            "screenW": screen_w,
            "screenH": screen_h,
            "winX": win_x,
            "winY": win_y,
            "transparent": IS_MAC,
        }

    def set_backdrop_mode(self, mode: str) -> dict:
        """Switch between 'wallpaper' and 'live' (below-window screen capture)."""
        if mode != "live":
            self._live_active = False
            return {"ok": True}
        if not IS_MAC:
            return {"ok": False, "reason": "platform"}
        import Quartz

        if not Quartz.CGPreflightScreenCaptureAccess():
            # Triggers the system permission prompt; the app must be
            # relaunched after the user grants access.
            Quartz.CGRequestScreenCaptureAccess()
            return {"ok": False, "reason": "permission"}
        self._live_active = True
        if not (self._live_thread and self._live_thread.is_alive()):
            self._live_thread = threading.Thread(target=self._live_loop, daemon=True)
            self._live_thread.start()
        return {"ok": True}

    def toggle_zoom_maximize(self) -> None:
        """Maximize to the visible screen area WITHOUT native fullscreen.

        Native macOS fullscreen moves the window into its own Space, where
        the system gives it an opaque backing (transparency dies) and there
        is nothing behind it for live capture to see.
        """
        window = self._glass_window
        if window is None:
            return
        if not IS_MAC:
            window.toggle_fullscreen()
            return
        if self._saved_frame is None:
            from AppKit import NSScreen

            screen = NSScreen.screens()[0]
            frame = screen.frame()
            visible = screen.visibleFrame()
            self._saved_frame = (window.x, window.y, window.width, window.height)
            top_y = frame.size.height - (visible.origin.y + visible.size.height)
            window.move(int(visible.origin.x), int(top_y))
            window.resize(int(visible.size.width), int(visible.size.height))
        else:
            x, y, width, height = self._saved_frame
            self._saved_frame = None
            window.resize(width, height)
            window.move(x, y)

    # -- live capture ------------------------------------------------------

    def _live_loop(self) -> None:
        window_number = _own_window_number()
        if window_number is None:
            self._live_active = False
            return
        while self._live_active and self._glass_window is not None:
            started = time.time()
            try:
                frame = self._capture_live_frame(window_number)
                if frame:
                    self._glass_eval(
                        "window.LiquidGlass && window.LiquidGlass.setLiveFrame(%s)"
                        % json.dumps(frame)
                    )
            except Exception:
                pass
            time.sleep(max(0.02, self.LIVE_INTERVAL - (time.time() - started)))

    def _capture_live_frame(self, window_number: int) -> dict | None:
        """Capture everything BEHIND the window (margin-inflated), as a texture."""
        import Quartz

        window = self._glass_window
        if window is None:
            return None
        margin = self.LIVE_MARGIN
        win_x, win_y = window.x, window.y
        req_x = win_x - margin
        req_y = win_y - margin
        req_w = window.width + margin * 2
        req_h = window.height + margin * 2

        display = Quartz.CGDisplayBounds(Quartz.CGMainDisplayID())
        x0 = max(req_x, display.origin.x)
        y0 = max(req_y, display.origin.y)
        x1 = min(req_x + req_w, display.origin.x + display.size.width)
        y1 = min(req_y + req_h, display.origin.y + display.size.height)
        if x1 - x0 < 2 or y1 - y0 < 2:
            return None

        cg_image = Quartz.CGWindowListCreateImage(
            Quartz.CGRectMake(x0, y0, x1 - x0, y1 - y0),
            Quartz.kCGWindowListOptionOnScreenBelowWindow,
            window_number,
            Quartz.kCGWindowImageNominalResolution,
        )
        if cg_image is None:
            return None
        data_url = _cgimage_to_jpeg_data_url(cg_image)
        if data_url is None:
            return None
        return {
            "dataUrl": data_url,
            "screenW": x1 - x0,
            "screenH": y1 - y0,
            "winX": win_x - x0,
            "winY": win_y - y0,
        }
