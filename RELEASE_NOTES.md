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
