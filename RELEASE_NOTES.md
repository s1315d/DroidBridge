# 🚀 DroidBridge v1.0.2 Release Notes

Following **v1.0.1**, this update (**v1.0.2**) focuses on major Wi-Fi transfer optimizations, zero-latency in-app media previews, video frame thumbnail extraction, and UI feedback improvements.

---

## 🔌 USB Connection Status
- **No breaking changes to USB Connection**: The underlying high-performance ADB engine (`adb push`, `adb pull`, device auto-detection loop, and Android storage inspection) remains fully intact and stable.
- **Improved List Refresh**: USB file operations now benefit from clean state resets and automatic local/remote file list refreshes upon completion.

---

## ✨ What's New & Key Highlights

### 🛜 1. Enhanced Wi-Fi File Sharing & Mobile Browser
- **Dynamic Folder Header**: Mobile browser top bar displays the custom staging folder name (e.g. `📁 DroidBridge-WiFi-Share`) instead of a generic `/`.
- **Default Staging Path Notice**: Added clear default path guidance (`Default Path: ~/Downloads/DroidBridge-WiFi-Share`) directly on the Wi-Fi screen.
- **Clean Audio & Video Unload**: Mobile and Desktop preview modals properly pause and unload media elements upon closing to prevent background audio playback.
- **HTTP 206 Partial Content Streaming**: Serves precise MIME types (`image/jpeg`, `video/mp4`, `video/quicktime`, etc.) and HTTP range headers for smooth video seeking and instant downloads.

---

### 👁️ 2. Desktop In-App Media Previews & Instant Loading
- **Instant Photo Previews (0ms Latency)**: Image previews (`.jpg`, `.png`, `.webp`, `.gif`, `.svg`) open instantly with zero delay using direct GPU-accelerated local `file://` loading.
- **In-App Video Player Modal**: Video files (`.mp4`, `.mov`, `.mkv`, `.avi`, `.webm`) play directly inside DroidBridge's dark preview modal with complete HTML5 player controls (play/pause, volume, seeking, fullscreen).
- **Real Video Frame Thumbnails**: Generates actual video frame thumbnails for video files in the Live Activity Log using native macOS `qlmanage` and `ffmpeg`.
- **Transfer Progress Completion Lock**: Prevents delayed percentage updates (e.g. 97%/67%) from overwriting completed file items after transfer finishes.

---

## 🛠️ Summary of Changed Files

- `main.js`: Added `qlmanage`/`ffmpeg` video frame thumbnail generator, `get-file-data-url` IPC handler, `/download` HTTP Range headers & MIME types, and `webSecurity: false` for local file streaming.
- `renderer.js`: Instant 0ms synchronous `openMacPreview` modal for photos and videos, video thumbnail badge fallback, upload completion lock in `updateWifiActivityLog`, and media cleanup on modal close.
- `index.html`: Added `#mac-preview-modal` container and default path notice (`Default Path: ~/Downloads/DroidBridge-WiFi-Share`).
- `styles.css`: Added CSS rules for `.overlay.active { display: flex !important; }`, `.wifi-default-note`, and `#mac-preview-modal { z-index: 9999; }`.
- `preload.js`: Exposed `getFileThumbnail`, `getFileDataUrl`, and `openFilePath` IPC APIs.

---

*Enjoy transferring files seamlessly with DroidBridge!* 🌉
