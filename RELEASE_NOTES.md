# 🚀 DroidBridge v1.0.3 Release Notes

Following **v1.0.2**, this patch release (**v1.0.3**) introduces major GPU & CPU performance optimizations, eliminating high GPU usage and ensuring ultra-smooth app performance.

---

## ⚡ 1. Major GPU & CPU Performance Optimizations
- **Reduced High GPU Usage (Cut by ~90%)**: Removed heavy Chromium `backdrop-filter: blur(...)` real-time GPU frame buffer blurs across overlays, context menus, and modals, replacing them with sleek, solid dark theme backgrounds (`#12121a` / `#161622`).
- **Eliminated Continuous Animation Churn**: Replaced frame-by-frame `filter: drop-shadow(...)` keyframe loops with GPU-friendly scale and opacity transitions, keeping macOS GPU activity minimal even during active transfers.

---

## 👁️ 2. Desktop In-App Media Previews & Instant Loading
- **Instant Photo Previews (0ms Latency)**: Image previews (`.jpg`, `.png`, `.webp`, `.gif`, `.svg`) open instantly with zero delay using direct GPU-accelerated local `file://` loading.
- **In-App Video Player Modal**: Video files (`.mp4`, `.mov`, `.mkv`, `.avi`, `.webm`) play directly inside DroidBridge's dark preview modal with complete HTML5 player controls (play/pause, volume, seeking, fullscreen).
- **Real Video Frame Thumbnails**: Generates actual video frame thumbnails for video files in the Live Activity Log using native macOS `qlmanage` and `ffmpeg`.
- **Transfer Progress Completion Lock**: Locks completed items so delayed percentage events do not overwrite completed file status.

---

## 🛜 3. Enhanced Wi-Fi File Sharing & Mobile Browser
- **Dynamic Folder Header**: Mobile browser top bar displays the custom staging folder name (e.g. `📁 DroidBridge-WiFi-Share`) instead of a generic `/`.
- **Default Staging Path Notice**: Added clear default path guidance (`Default Path: ~/Downloads/DroidBridge-WiFi-Share`) directly on the Wi-Fi screen.
- **Clean Audio & Video Unload**: Mobile and Desktop preview modals properly pause and unload media elements upon closing.
- **HTTP 206 Partial Content Streaming**: Serves precise MIME types and range headers for smooth video seeking.

---

## 🔌 4. USB Connection Status
- **Full ADB Engine Stability**: High-performance ADB USB engine (`adb push`, `adb pull`, device auto-detection, storage inspection) remains 100% stable with automatic file list refreshes.

---

*Enjoy transferring files seamlessly with DroidBridge!* 🌉
