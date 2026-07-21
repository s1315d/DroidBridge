# DroidBridge 🌁

⚡ Break the barrier between macOS and your devices. Warp-speed USB (ADB) transfers for power users + instant wireless local Wi-Fi sharing for any browser (iOS 🍎, Android 🤖, PC 💻). Nested folder navigation, folder diff comparisons, and custom folder staging. 0% cloud, 100% velocity. 🌁

DroidBridge is a premium, high-performance desktop application for macOS built with Electron. It provides a visual, dual-pane interface to manage, browse, and transfer files and directories bidirectionally between your Mac and mobile devices. 

DroidBridge supports **two powerful modes of operation** to accommodate all users:

1. **🔌 USB Mode (ADB-powered)**: Designed for high-speed, stable transfers with Android devices. By using Android Debug Bridge (ADB), it bypasses the notoriously unstable MTP protocol, ensuring uninterrupted transfers of large batches and huge files (e.g., GoPro/camera media).
2. **📶 Wi-Fi Share Mode (Universal)**: A zero-configuration wireless transfer mode. It launches a local server and generates an offline QR code. Any device on the same local Wi-Fi network (iPhone 🍎, iPad 🍏, Android 🤖, Mac 💻, Windows Laptop, etc.) can connect to instantly browse directories, download files, and upload files wirelessly through their web browser.

---

## ✨ Features

### 🔌 USB Mode (ADB) Features
- **📱 Multi-Device Auto-Detection & Display**: Detects one or more Android devices connected via USB. Displays a dynamic multi-device indicator on the landing page to prevent freezing.
- **⚡ Flexible Connection Choice**: Connecting via USB does not force you into USB mode; you can choose either standard USB Transfer or Wi-Fi mode directly from the landing selector.
- **🖼️ Image & Video Sidebar Previews**: Select any media file to show interactive thumbnails and metadata directly inside the desktop preview sidebar.
- **⚡ High-Speed Reliable Transfers**: Bypasses slow macOS MTP services. Built on ADB shell streams for maximum throughput and reliability.
- **📂 Full Directory Trees**: Recursively copy folders and nested structures bidirectionally between Mac and Android.

### 📶 Wi-Fi Share Mode (Universal) Features
- **🍎 Universal iOS & Android Support**: Works natively on **any** device with a web browser (iPhone, iPad, Android, tablets, or other laptops) on the same local Wi-Fi.
- **📄 Expanded Inline Previews**: Open documents (PDF, text, JSON, HTML) or listen to audio tracks (MP3, WAV, M4A, OGG) directly in your mobile browser tab instead of triggering a forced download.
- **📦 Any-Format Wireless Uploads**: Send archives, APK packages, images, or documents from your phone directly to your Mac.
- **📁 Subdirectory Navigation**: Browse folders recursively from your device browser, open subfolders via an inline explorer, download nested files, and upload files directly into specific active subfolders on your Mac.
- **📷 Offline QR Code Setup**: Automatically scans local IP addresses and prints an offline base64 QR Code. No external internet or setup required!

### 💻 Dual-Pane & Management Features
- **📦 Folder Comparison Mode**: A side-by-side comparison engine that checks files in both panels by name and size, marking them with status badges:
  - `Match` (Green): Exists on both sides and is identical in size.
  - `Size Diff` (Red): Exists on both sides but has different file sizes.
  - `Type Diff` (Red): Exists on both sides but one is a file and the other is a folder.
  - `Unique` (Grey): Exists only on that side.
- **⚠️ Interactive Conflict Resolution**: When copying files, DroidBridge checks if they already exist at the destination and prompts you with options:
  - **Replace / Replace All**: Overwrite target files.
  - **Skip / Skip All**: Skip conflicting files.
  - **Cancel**: Abort the entire transfer queue.
- **⌨️ Advanced Navigation & Multi-Select**:
  - Full support for `Command + Click` (macOS) and `Ctrl + Click` to toggle select individual files.
  - Keyboard navigation using `ArrowUp` and `ArrowDown` with `Shift` selection range tracking.
  - Right-click Context Menu for copy, delete, directory creation, reveal in Finder, or select all.

---

## 🔒 Security & Privacy

- **100% Local & Private**: DroidBridge operates entirely locally on your machine and local Wi-Fi network. No telemetry is collected, and no internet data is ever transmitted.
- **Secure USB Access**: The Android RSA fingerprint prompt ensures that **only** your manually authorized Mac can access the phone's filesystem via USB Debugging.
- **Sandboxed Execution**: Electron process sandboxing is fully active to protect host system resources.

---

## 🚀 Installation & Setup

### Prerequisites
1. **macOS** (Intel or Apple Silicon).
2. **Node.js** (v18 or higher recommended) & **npm**.
3. **Homebrew** (optional, to install ADB).

### Step 1: Install ADB (For USB Mode Only)
If you wish to use USB mode, you can use our **automated setup script** (which auto-detects and installs Homebrew & ADB for you):
```bash
chmod +x setup-adb.sh && ./setup-adb.sh
```
*(Tip: If you get a "permission denied" error when running `./setup-adb.sh`, the `chmod +x setup-adb.sh` command grants it execution permissions).*

Or install manually via Homebrew:
```bash
brew install android-platform-tools
```
Verify the installation by running: `adb --version` in your terminal.

### Step 2: Configure Developer Options (For USB Mode Only)
1. Go to **Settings** → **About Phone** on your Android device.
2. Tap **Build Number** 7 times consecutively to enable Developer Options.
3. Open **Developer Options** (under System/Additional Settings) and toggle **USB Debugging** to **ON**.
4. Connect your phone via USB and **Allow USB Debugging** on the screen prompt.

*No setup, cables, or configuration are needed on your device to use Wi-Fi Share Mode.*

---

## 📶 How to Use Wi-Fi Share Mode (Universal)

This mode allows you to transfer files bidirectionally between your Mac and **any** device (iPhone 🍎, Android 🤖, iPad 🍏, Mac 💻, Windows Laptop, etc.) without using USB cables or configuring Developer Options.

### 1. Start the Server on your Mac 💻
- Open **DroidBridge** on your Mac.
- Click the **"Start Wi-Fi Transfer Mode"** button.
- A modal will pop up displaying a **QR Code**, a local URL (e.g., `http://192.168.1.50:8080`), and the default shared folder.
- **Choose / Open Folder**: Inside the modal, click the **"Choose"** button to dynamically change the active shared directory to any folder you prefer on your Mac, or click the **"Open"** button to open the active folder in Finder.

### 2. Connect your Device 📱
- Make sure your device is connected to the **same local Wi-Fi network** as your Mac.
- Scan the **QR Code** using your device's camera app, or type the local URL directly into any browser (Safari, Chrome, Firefox, Edge, etc.).
- The DroidBridge Web UI will load instantly on your device.

### 3. Transfer Files from Device to Mac (Upload) 📤
- On your device's browser, tap the **"Upload files to Mac"** area.
- Select the files, photos, or videos you wish to transfer.
- The transfer will start immediately. You can view the live progress bar on both your device's browser and the Mac app screen.
- The uploaded files will be saved in the shared directory on your Mac.

### 4. Transfer Files from Mac to Device (Download) 📥
- Place any files or folders you want to send to your device inside the folder you selected on your Mac during setup.
- These files and folders will appear in real-time under the **"Download from Mac"** list on your device's browser.
- Tap **"Download"** next to any file on your device to save it locally.

### 5. Nested Folder Navigation 📁
- If you place a folder inside the shared directory on your Mac, it will show up on your device with a folder icon (📁).
- Tap the **"Open ➔"** button on the right of the folder to browse its contents.
- Inside any subfolder, tap the **"← Back"** button to go back up.
- **Subfolder Uploads**: Any file you upload while navigated inside a subfolder on your device will automatically be saved inside that exact subfolder inside your selected shared folder on the Mac!

---

## ⚙️ Running the Application

1. Clone or download the project folder.
2. Open terminal in the `droidbridge` directory and install dependencies:
   ```bash
   npm install
   ```
3. Run the development environment:
   ```bash
   npm start
   ```
4. To build the production macOS `.app` bundle:
   ```bash
   npm run package
   ```
   The compiled app will be generated in `DroidBridge-darwin-arm64/DroidBridge.app`.

---

## 🛠️ Tech Stack & Architecture

- **Desktop Framework**: Electron
- **UI & Styling**: Pure HTML5, CSS3 Custom Properties (Fluid layouts, dark glassmorphism styling, and custom animations)
- **Backend Communications**: Node.js `child_process` (securely running commands via `execFile` and `spawn` to prevent shell injection vectors)
- **Wi-Fi Server**: Native Node.js `http` file streamer & chunked pipe uploads.

---

##  Note for macOS Users If You Download App From Release Section

If you get a warning saying the app "is damaged and can't be opened", this is a standard macOS warning for unsigned apps. To open it:

Open your Terminal app.
Run the following command:

   ```bash
   xattr -cr /path/to/DroidBridge.app
 
   ```

(Tip: Type xattr -cr and drag DroidBridge.app into the terminal to auto-fill the path!)

---

## 📄 License

This project is licensed under the MIT License. Developed by Shubham Gour.
