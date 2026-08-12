# Release Notes - DroidBridge v2.0.0 (Major Overhaul Release)

We are thrilled to present **DroidBridge v2.0.0**, a monumental release representing a complete architectural modularization and feature expansion. This version splits the core logic into clean, testable sub-modules, introduces complete transfer controls (pause/resume/cancel), adds transaction history log persistence, configures settings management, and includes a full suite of automated unit tests.

---

## 🌟 Key New Features & Capabilities

### ⏸️ Real-Time Transfer Controls (Pause, Resume, Cancel)
* **OS-Level Signal Freezing**: Dynamic **Pause (SIGSTOP)** and **Resume (SIGCONT)** capabilities let you temporarily suspend high-volume ADB operations at the kernel level without breaking socket sessions.
* **Instant Cancellation**: Cancel in-progress transfers with clean child process cleanup and partial file sweep deletion.
* **ETA & Speed Statistics**: The new progress status bar displays live EMA-smoothed transfer speeds and precise time-to-completion (ETA) estimates.

### 📋 Settings & Operation History Logs
* **Settings Modal (⚙️)**: Configure your local port choices and GitHub update checking path directly from a sleek title bar interface.
* **Transfer History Log (📋)**: A new local database stores a history of completed and aborted transfers. Offers a Compact/Detailed view toggle to see full transaction data, remote IPs, and timestamps.
* **Check for Updates**: A dynamic checker compares your local version against the latest tags in the GitHub repository.

### 📁 UI Utilities & Enhancements
* **Directory Virtualization**: Enhances UI performance in huge directories (1000+ files) by dynamically rendering only visible rows, maintaining a constant 60fps refresh.
* **Custom Input Modals**: Replaced Electron's disabled `window.prompt()` fallback with custom, keyboard-navigable dialog modal forms for file renaming and folder creations.
* **ZIP Folder Streaming**: Download entire directory structures directly from the mobile browser client as a compressed archive on-the-fly.

---

## 🏗️ Architecture & Refactoring

* **Module Split**: Split the massive `main.js` controller into separate sub-modules:
  * `src/adb.js`: Abstracted adb processes, stat lookups, and filename parsing.
  * `src/security.js`: Local path allowlisting containment checks and auth validation.
  * `src/settings.js`: JSON configuration storage logic.
* **Clean Web UI Extraction**: Mobile UI pages (`mobile.html` and `login.html`) are now standalone HTML files parsed with nonce and security parameters.
* **Automated Unit Tests**: Integrated a full suite of 27 unit tests (`test/utils.test.js`) executing natively via Node's test runner (`node --test`).
* **Formatters & Linters**: Implemented **ESLint** and **Prettier** configs and commands to enforce codebase style guide consistency.

---

# Release Notes - DroidBridge v1.1.1 (Security Hardening Release)

We are excited to release **DroidBridge v1.1.1**, a critical security patch release addressing findings identified in our security audit. This version hardens the Wi-Fi sharing server and local file processing pipelines.

---

## 🛡️ Security Hardening & Vulnerability Fixes

### 🔑 Wi-Fi Sharing Token Authentication (F1)
* **Session Access Token**: The Wi-Fi share server now generates a cryptographically secure 128-bit access token (`wifiToken`) on startup.
* **Auto-Login via QR Code**: Scanning the QR code automatically logs the device in.
* **Manual Login Interface**: Users manually entering the URL will be prompted with a new security login screen to enter the token displayed on the Mac desktop window.
* **Secure Cookie Session**: Authenticated sessions are tracked via a secure, `HttpOnly`, `SameSite=Strict` cookie (`sid`).

### 🚧 Strict Boundary Containment (F2 & F3)
* **Restricted Local Allowlist**: Removed the root directory (`/`) from `ALLOWED_LOCAL_DIRS` and added `/Volumes` to restrict local browsing to safe, user-approved directories.
* **Prefix Bypass Guard**: Patched both `isPathAllowed` and `isWifiPathAllowed` path checks to enforce strict path boundary parsing, preventing attackers from accessing sibling folders.

### 💉 Command Injection Sanitization (F4)
* **Adb Shell Escaping**: Applied shell argument escaping using `escapeShellArg` for the remote file path inside the video frame thumbnail generation module.

### 💾 Upload Size Protection (F5)
* **Disk DoS Limit**: Imposed a strict 100 GB upload size limit per file. Incoming requests are verified against `Content-Length` headers, and data streams are monitored dynamically to abort and clean up uploads exceeding the ceiling.

### 🌐 Origin XSS Shield (F6)
* **Restricted Preview Types**: Limited the `inline=1` rendering option to a safe allowlist of preview files (`pdf`, `txt`, `json`, and common images/videos/audio).
* **Forced Attachment Download**: Any other formats (including `.html` and `.svg`) are now forced to download as attachments, preventing cross-site scripting (XSS) execution inside the server origin.

### 🧼 Rate-Limit Cleanup & Temp Directory Isolation (F8 & F9)
* **Rate-Limit Memory Pruning**: A periodic cleanup interval runs every 5 minutes to sweep and prune inactive IP addresses from memory, preventing slow memory leaks.
* **Secure Temp Permissions**: Temp folders and pulled preview frames are named using secure random suffixes and initialized with strict folder permissions (`0o700`), locking out other local users.

---

# Release Notes - DroidBridge v1.1.0 (Major Release)

We are excited to release **DroidBridge v1.1.0**, a major version release packed with new capabilities, visual layout improvements, security enhancements, and robust adb connection logic.

---

## 🌟 New Features & Major Changes

### ⚡ Flexible USB vs. Wi-Fi Sharing Selection
* **Non-Forced USB Connection Mode**: When one or more Android devices are connected via USB, the application no longer forces you into USB mode automatically.
* **Main Landing Mode Selector**: The landing screen now lets you explicitly select your preferred mode:
  - Click **⚡ Continue with USB Transfer** to manage files on your phone via ADB.
  - Click **📶 Wi-Fi Share mode** to spin up a web server and access local files wirelessly.

### 📁 Advanced USB Mode File Management
* **Individual File Deletion**: Added direct individual delete options in USB sharing mode via right-click context menus.
* **Image & Video Preview Panel**: Selecting an image or video file in USB mode displays interactive, high-fidelity thumbnails and metadata directly inside the Mac desktop application's preview side panel.

### 🌐 Rich Wi-Fi Sharing Mode (Mac ↔ Mobile)
* **On-the-Fly Web Server**: Spin up a local transfer server on your Mac with one click, complete with a dynamic IP address and QR code display.
* **Mobile Web client**: Scan the QR code to open a beautiful mobile-friendly responsive web app on your phone.
* **Expanded Inline File Previews**: Preview and open documents (PDFs, texts, JSON, HTML) or play audio tracks (MP3, WAV, M4A, OGG) directly in your mobile browser tab instead of triggering a download. Images and videos will preview inside the fluid overlay modal.
* **Any-Format Mobile Uploads**: Wirelessly upload files of any extension (including `.apks`, `.zip`, `.png`) directly from your phone back to your Mac.
* **Intelligent Action Filtering**: The mobile client dynamically checks file extensions and selectively offers the "Preview" option only for previewable formats, keeping your interface clean.

### 🗹 Multi-File Selection & Bulk Deletion
* **File Row Checkboxes ("Tick Boxes")**: Added selection checkboxes to each row in the local and remote file lists, enabling easier mouse selection.
* **Bulk File Management**: You can now select multiple files or folders using checkboxes (or standard Shift/Cmd click modifiers) and perform bulk actions.
* **Recursive Multi-Delete**: Added a new **Delete** command to remove all selected items in one click. It recursively clears directories and single files safely with safety warnings.

### 📖 Comprehensive Project Documentation
* **Technical Guide Included**: The release now contains a detailed `DOCUMENTATION.md` file explaining the project's folder structure, Electron architecture (Main/Renderer/IPC), security design, and step-by-step creation/compilation guides.

---

## 🛡️ Security Hardening

* **Cryptographic Nonce CSP**: Implemented a strict, dynamic Content Security Policy (CSP) headers that generates a per-request cryptographically secure 128-bit hex token (`crypto.randomBytes(16)`).
* **Unsafe-Inline Removal**: Completely removed all inline script tags (`onclick="..."`) and inline styling properties (`style="..."`) from the mobile HTML templates. Resolved all actions strictly using secure DOM event listeners, completely dropping `'unsafe-inline'` from headers.
* **Strict Path Validation**: Restricted the Wi-Fi shared directory to directories within safe roots (e.g. `os.homedir()`, `/Volumes`) to prevent path traversal vulnerability.
* **ADB Shell Escaping**: Configured custom Unix-style parameter escaping (`escapeShellArg`) to wrap arguments in single quotes and escape nested quotes, ensuring spaces and symbols inside filenames (e.g. spaces/parentheses/commas) never lead to shell injection or deletion failure.

---

## 🎨 Layout & Visual Alignment

* **Universal Checkbox Alignment**: Unified layout grids so checkbox columns and file columns perfectly match between file headers and rows in both local and remote panels.
* **Scrollbar Gutter Lock**: Configured a persistent vertical scrollbar track (`overflow-y: scroll;`) and adjusted header padding dynamically to prevent shifting content columns when browsing between populated and empty folders.

---

###  Note for macOS Users

If you get a warning saying the app "is damaged and can't be opened", this is a standard macOS warning for unsigned apps. To open it:

Open your Terminal app.
Run the following command:

```bash
xattr -cr /path/to/DroidBridge.app
```

(Tip: Type xattr -cr and drag DroidBridge.app into the terminal to auto-fill the path!)

---

*Download the update to enjoy the most secure, feature-rich DroidBridge yet!*
