# DroidBridge — Session Context & Change Log

## Project Overview
**DroidBridge** is a premium macOS desktop app (Electron) for bidirectional file transfer between Mac and Android devices. It supports two modes:
1. **USB Mode (ADB)** — high-speed transfers bypassing MTP
2. **Wi-Fi Share Mode** — local HTTP server with QR code + token auth, works with any browser (iPhone, Android, PC)

**GitHub:** https://github.com/s1315d/DroidBridge/
**Author:** Shubham Gour
**License:** MIT

---

## File Structure
```
droidbridge/
├── main.js              # Electron main process (IPC, ADB, Wi-Fi server) — ~2050 lines
├── renderer.js          # Frontend logic (file lists, transfers, UI) — ~3270 lines
├── preload.js           # Context bridge API — ~75 lines
├── index.html           # Desktop app UI — ~415 lines
├── styles.css           # All styling — ~2320 lines
├── mobile.html          # Wi-Fi mobile web UI (extracted from main.js)
├── login.html           # Wi-Fi token login page (extracted from main.js)
├── src/
│   ├── security.js      # Path validation, token compare, cookie parsing
│   ├── adb.js            # ADB helpers (findAdb, runAdb, parseAdbLsOutput, etc.)
│   └── settings.js       # Settings + transfer history persistence
├── test/
│   └── utils.test.js     # 27 unit tests (node:test)
├── .eslintrc.json        # ESLint config
├── .prettierrc           # Prettier config
├── .prettierignore
├── .gitignore
├── package.json          # v1.1.1, deps: qrcode, archiver
├── setup-adb.sh          # Automated ADB installer
├── build-mac-icon.js     # Icon generator
└── SESSION_CONTEXT.md    # This file
```

---

## Session Work Log

### Phase 1: Initial Code Review
The user asked for improvement suggestions for DroidBridge. A full codebase review was performed across `main.js` (2470 lines), `renderer.js` (2620 lines), and `preload.js`. Issues were categorized into P0 (critical/quick wins), P1 (higher impact), P2 (feature gaps), and Architecture (refactors).

### Phase 2: P0 + P1 Implementation (9 items)
All P0 and P1 items were implemented:

| # | Item | What was done |
|---|------|---------------|
| P0-1 | Redundant device polling | Removed `setInterval(refreshDevicesList, 5000)` from renderer — main process already polls `adb devices` every 3s and pushes events |
| P0-2 | wifiRetryCount/wifiPort reset | `wifiRetryCount = 0` on successful `listen()`; `wifiPort` restored from saved settings (or 8080) on stop |
| P0-3 | Warning toast styling | Added `warning` type to `showToast()` — amber `#d97706` + ⚠️ icon |
| P0-5 | Variable shadowing | Renamed inner `parts` → `linkParts` in `parseAdbLsOutput` symlink branch |
| P0-6 | Constant-time token compare | Added `tokenEquals()` using `crypto.timingSafeEqual` — applied to all Wi-Fi auth checks |
| P1-4 | Async recursive listing | `getLocalFilesRecursive` converted from `readdirSync` to `fs.promises.readdir` |
| P1-7 | Token display in Wi-Fi modal | Added "Access Token" row with `<code>` display + copy button in Wi-Fi modal |
| P1-12 | Transfer speed + ETA | Added `progress-speed-eta` element, `transferStartTime`, `transferEtaEma` (EMA smoothing), `formatEta()` helper |
| P1-14 | Cancel transfer | Added `cancel-transfer` IPC, `transferCancelled` flag, kills active adb spawn, cancel button in overlay |

### Phase 3: P2 + Architecture Implementation (13 items)
All P2 features and architecture refactors were implemented:

| # | Item | What was done |
|---|------|---------------|
| P2-10 | DOM virtualization | Only renders visible rows + 8-row buffer; spacer divs maintain scroll height; `VIRTUAL_ROW_HEIGHT = 40`; scroll listener triggers `renderVisibleRows()` |
| P2-11 | thumbCache LRU | `THUMB_CACHE_MAX = 200`; `thumbCacheGet()` moves to end (MRU); `thumbCacheSet()` evicts oldest when over cap |
| P2-13 | Transfer history | `droidbridge-history.json` in userData (max 200 entries); records push/pull/wifi-upload; 📋 modal with compact/detailed toggle |
| P2-15 | Drag-and-drop | `setupDragAndDrop()` — items draggable via `dragstart`, panels are drop targets, triggers push/pull on drop |
| P2-16 | File rename | `rename-local` + `rename-remote` IPC handlers; "✏️ Rename" in context menu; `promptRename()` using custom modal |
| P2-17 | Remembered last dirs | `lastLocalPath`/`lastRemotePath` saved to settings JSON on each directory load; restored on init |
| P2-18 | Settings panel | ⚙️ modal with update repo, Wi-Fi port, check-for-updates button; `get-settings`/`set-settings` IPC |
| P2-19 | Wi-Fi ZIP download | `/download-folder` endpoint using `archiver` package; 📦 ZIP button on folders in mobile UI |
| P2-20 | Auto-update check | `check-for-updates` IPC calls GitHub `/repos/{owner/repo}/releases/latest`; compares versions |
| Arch-21 | Module split | Extracted `src/security.js` (81 lines), `src/adb.js` (182 lines), `src/settings.js` (63 lines); main.js uses aliases |
| Arch-22 | HTML extraction | Mobile UI → `mobile.html`, login → `login.html`; loaded via `fs.readFileSync` with `__NONCE__`/`__FOLDER_NAME__`/`__ERROR_MSG__` placeholders |
| Arch-23 | Unit tests | 27 tests via `node:test` covering `parseAdbLsOutput`, `escapeShellArg`, `getRemoteParent`, `getRemoteRelative`, `isPathAllowed`, `tokenEquals` |
| Arch-24 | Lint/Format | `.eslintrc.json` (eslint:recommended + globals), `.prettierrc` (single quote, 120 width), `.prettierignore`, `lint`/`format` npm scripts |

### Phase 4: Bug Fixes Discovered During Testing
The user built and tested the packaged app (`npm run package` → `xattr -cr` → `open`). The following bugs were found and fixed:

| Bug | Cause | Fix |
|-----|-------|-----|
| Settings (⚙️) and History (📋) buttons not working | Overlays had `z-index: 100`, titlebar has `z-index: 1000` — modals rendered behind titlebar (invisible) | Added `z-index: 2000 !important` to `#settings-overlay` and `#history-overlay` |
| Wi-Fi token shows blank | `wifiServer.listen()` callback resolved WITHOUT `token: wifiToken` — renderer never received it | Added `token: wifiToken` to the `resolve()` call in `listen` callback |
| Copy buttons (📋) not working | `navigator.clipboard.writeText` silently fails in sandboxed Electron renderer | Added `copy-to-clipboard` IPC handler using Electron's `clipboard` API as fallback |
| Wi-Fi port setting not applied | `startWifiServer()` always started at 8080, never read saved `wifiPort` setting | Added `loadSettings()` call at start of `startWifiServer()` to read and apply saved port; `stopWifiServer()` also restores saved port |
| Wi-Fi uploads not recorded in history | Only USB transfers (`push-files`/`pull-files`) called `addHistoryEntry()`; Wi-Fi `/upload` endpoint didn't | Added `addHistoryEntry()` call in `writeStream.on('finish')` with `direction: 'wifi-upload'` |
| IPv4-mapped IPv6 in history | `req.socket.remoteAddress` returns `::ffff:192.168.29.89` on dual-stack servers | Strip `::ffff:` prefix before saving: `if (clientIp.startsWith('::ffff:')) clientIp = clientIp.slice(7)` |
| Progress bar stuck at 0% | Modern adb (platform-tools 37) no longer emits `%` progress during `push`/`pull` — only a summary line after completion; regex `/(\d+)%/` never matched | Replaced with **size-polling**: `pushWithProgress()` polls `adb shell stat -c %s` every 300ms; `pullWithProgress()` polls `fs.statSync(localDest).size` every 300ms |
| "Android Device (unauthorized)" with no guidance | App showed the label but didn't tell user what to do | Added ⚠️ toast + detailed status hint: "Look for 'Allow USB debugging?' dialog on your phone, check 'Always allow', tap Allow, reconnect USB" |
| Right panel empty on startup | `init()` only called `loadLocalFiles()` — never called `loadRemoteFiles()` for the right panel | Added `loadRemoteFiles(state.remotePath)` call in `init()` after local files load |
| `/` (root) shows empty for Mac | `/` was not in `ALLOWED_LOCAL_DIRS`; containment check `resolvedPath.startsWith('/' + path.sep)` = `startsWith('//')` never matched | Added `/` to allowed list with special case: if `resolvedDir === '/'`, any absolute path starting with `/` is allowed |
| History names too long, can't see client IP | Compact view truncated names with ellipsis, no way to see full details | Added 📏 Compact/Detailed toggle button: detailed view widens modal to 680px, wraps file names, shows client IP + device ID |
| No pause button (only cancel) | Only cancel was implemented | Added **⏸ Pause/▶ Resume** using `SIGSTOP`/`SIGCONT` signals to freeze/resume the adb process; button toggles label and color |
| Pause/cancel button size mismatch | Different label lengths ("⏸ Pause" vs "✕ Cancel Transfer") caused different widths | Added `min-width: 160px` + `text-align: center` to both buttons |
| Rename / New Folder do nothing | `window.prompt()` is disabled in Electron — silently returns `null` | Replaced with custom `showInputModal()` — modal with text field, auto-focus, pre-filled, Enter to confirm, Escape to cancel |

### Phase 5: Test Updates
After the `/` root fix, 2 tests that expected `/etc/passwd` and `/var/log/system.log` to be *denied* started failing (because with `/` allowed, they're correctly *allowed*). Tests were updated to reflect the new (correct) behavior. All 27 tests pass.

---

## Key Technical Decisions

### Progress Tracking (Modern ADB)
Modern adb (platform-tools 37) does NOT emit percentage progress during `push`/`pull` — it only prints a summary line after completion (e.g., `"file.txt: 1 file pushed, 0 skipped. 37.3 MB/s (52428800 bytes in 1.340s)"`). The old code parsed `(\d+)%` from adb output which never matched.

**Solution:** File-size polling:
- **Push:** `setInterval` every 300ms → `adb shell stat -c %s <remoteFile>` → `remoteSize / localSize * 100`
- **Pull:** `setInterval` every 300ms → `fs.statSync(localDest).size` → `localSize / remoteSize * 100`
- Timer cleared on process close; progress capped at 99% until file completes

### Pause/Resume (SIGSTOP/SIGCONT)
On macOS, `SIGSTOP` freezes a process at the OS level (no CPU, no I/O). `SIGCONT` resumes it. This is more reliable than trying to pause/resume at the application level. The adb child process is sent these signals directly via `proc.kill('SIGSTOP')` / `proc.kill('SIGCONT')`.

### DOM Virtualization
File lists can have 1000+ entries. Instead of rendering all DOM elements, only visible rows + 8-row buffer are rendered. Top/bottom spacer divs with calculated heights maintain correct scroll position. A scroll listener triggers re-render on scroll. Fixed row height of 40px.

### Module Architecture
- `src/security.js` — Pure functions: `isPathAllowed`, `isWifiPathAllowed`, `getCookie`, `tokenEquals`
- `src/adb.js` — ADB helpers: `findAdb`, `escapeShellArg`, `runAdb`, `parseAdbLsOutput`, `getRemoteParent`, `getRemoteRelative`, `remoteFileExists`, `getRemoteFilesRecursive`
- `src/settings.js` — Persistence: `loadSettings`, `saveSettings`, `loadHistory`, `saveHistory`, `addHistoryEntry`
- `main.js` imports these via `require()` and creates wrapper aliases (e.g., `isWifiPathAllowed` wraps the module function with the current `wifiSharedDir`)

### Wi-Fi Auth Flow
1. Server generates 128-bit token: `crypto.randomBytes(16).toString('hex')`
2. QR code URL: `http://<ip>:<port>/?token=<token>`
3. On first visit: token extracted from query → set as `HttpOnly; SameSite=Strict` cookie → redirect to clean `/`
4. Subsequent requests: cookie checked via `tokenEquals()` (constant-time)
5. Manual entry: login page at `/` with form POST to `/login`
6. Token displayed in desktop Wi-Fi modal with copy button

### Settings Persistence
Two JSON files in `app.getPath('userData')`:
- `droidbridge-settings.json` — `{ updateRepo, wifiPort, lastLocalPath, lastRemotePath }`
- `droidbridge-history.json` — Array of transfer entries (max 200)

### Custom Input Modal (replaces window.prompt)
`window.prompt()` is disabled in Electron — it silently returns `null`. A custom `showInputModal(title, label, defaultValue)` function was added that:
- Shows a modal overlay with text input (z-index 2500)
- Auto-focuses and selects the pre-filled text
- Returns a Promise (resolved on confirm/cancel)
- Supports Enter to confirm, Escape to cancel, click-outside to dismiss
- Used by both `promptRename()` and `promptNewRemoteFolder()`

---

## GitHub Update Configuration
To enable update checks:
1. Open app → ⚙️ Settings → "Update Repository" field
2. Enter `owner/repo` (e.g., `s1315d/DroidBridge`) — no URL, no `https://`
3. Click Save
4. Click "Check for Updates" — calls `GET https://api.github.com/repos/{owner}/{repo}/releases/latest`
5. Compares `tag_name` (stripped of `v` prefix) to `app.getVersion()`
6. If different → shows "New version X available" with link to release page

To publish an update:
1. Bump `version` in `package.json`
2. `npm run package`
3. Zip the `.app`: `cd DroidBridge-darwin-mac-arm64 && zip -r ../DroidBridge-X.Y.Z-mac-arm64.zip DroidBridge.app`
4. Create GitHub release with tag `vX.Y.Z`
5. Upload the zip as attachment

---

## Build & Run Commands
```bash
# Development (with DevTools)
npm run dev

# Production start
npm start

# Build macOS .app bundle
npm run package
# Output: DroidBridge-darwin-arm64/DroidBridge.app

# Clear quarantine (for unsigned apps)
xattr -cr DroidBridge-darwin-arm64/DroidBridge.app

# Launch
open DroidBridge-darwin-arm64/DroidBridge.app

# Run tests
npm test    # 27 tests via node:test

# Lint (non-blocking)
npm run lint

# Format
npm run format
```

---

## Dependencies
```json
"dependencies": {
  "qrcode": "^1.5.4",     // QR code generation for Wi-Fi mode
  "archiver": "^7.0.1"    // ZIP streaming for folder downloads
},
"devDependencies": {
  "electron": "^35.0.0",
  "electron-packager": "^17.1.2",
  "eslint": "^9.0.0",
  "prettier": "^3.3.0"
}
```

---

## Current State
- All P0 (5/5), P1 (5/5), P2 (9/9), and Architecture (4/4) items complete
- 15 additional bug fixes applied during testing
- 27/27 unit tests passing
- App built, tested, and running
- NOT yet a git repository (`.gitignore` exists but `git init` not yet run)
- Version: 1.1.1

## Known Limitations / Future Work
- GitHub update check is notify-only (no auto-download/install)
- Wi-Fi transfer is HTTP only (no HTTPS — plaintext on local network)
- GitHub API rate limit: 60 requests/hour per IP without token
- `runAdbWithProgress` still exists in main.js but is no longer used (replaced by `pushWithProgress`/`pullWithProgress`) — could be removed
- No code signing (macOS shows "damaged" warning — requires `xattr -cr`)
