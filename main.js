// ─────────────────────────────────────────────────────────────────────────────
// DroidBridge — Main Process
// Mac ↔ Android file transfer app powered by ADB
// ─────────────────────────────────────────────────────────────────────────────

const { app, BrowserWindow, ipcMain, dialog, shell, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');

// ─── Module imports (#21) ───────────────────────────────────────────────────
const security = require('./src/security');
const adb = require('./src/adb');
const settingsMod = require('./src/settings');

// Prevent EPIPE uncaught exception crashes when stdout/stderr pipes close
if (process.stdout && process.stdout.on) {
  process.stdout.on('error', () => {});
}
if (process.stderr && process.stderr.on) {
  process.stderr.on('error', () => {});
}

// Redirect console logs to a safe file in production to avoid EPIPE crashes
let logFile = null;
app.whenReady().then(() => {
  try {
    logFile = path.join(app.getPath('userData'), 'droidbridge.log');
    // Clear old log file on start
    fs.writeFileSync(logFile, `--- DroidBridge Log Started: ${new Date().toISOString()} ---\n`);
  } catch (e) {}
});

const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

const safeWriteLog = (level, args) => {
  const msg = `[${new Date().toISOString()}] [${level}] ` + 
    args.map(a => typeof a === 'object' ? JSON.stringify(a, null, 2) : a).join(' ') + '\n';
  
  // Also write to original if not packaged
  if (!app.isPackaged) {
    try {
      if (level === 'ERROR') originalError.apply(console, args);
      else if (level === 'WARN') originalWarn.apply(console, args);
      else originalLog.apply(console, args);
    } catch (e) {}
  }
  
  if (logFile) {
    try {
      fs.appendFileSync(logFile, msg);
    } catch (e) {}
  }
};

console.log = (...args) => safeWriteLog('INFO', args);
console.error = (...args) => safeWriteLog('ERROR', args);
console.warn = (...args) => safeWriteLog('WARN', args);

process.on('uncaughtException', (err) => {
  if (err && (err.code === 'EPIPE' || (err.message && err.message.includes('EPIPE')))) {
    return;
  }
  safeWriteLog('FATAL', [err ? err.stack || err.message || err : 'Unknown error']);
});

// Set application name early
app.name = 'DroidBridge';
if (app.setName) app.setName('DroidBridge');

// ─── Globals ─────────────────────────────────────────────────────────────────

let win = null;
let knownDeviceIds = new Set();      // Track connected devices for change detection
let devicePollInterval = null;

// Cancellation control for in-progress file transfers.
let transferCancelled = false;      // Set true by the `cancel-transfer` IPC
let currentTransferProc = null;     // Active adb spawn, killed on cancel

// Pause/resume control for in-progress file transfers.
let transferPaused = false;         // Set true by `pause-transfer`, false by `resume-transfer`

// ─── Aliases for module functions (#21) ─────────────────────────────────────
// Security & path validation (from src/security.js)
const isPathAllowed = security.isPathAllowed;
const getCookie = security.getCookie;
const tokenEquals = security.tokenEquals;
// isWifiPathAllowed needs the current wifiSharedDir, so wrap it:
function isWifiPathAllowed(targetPath) {
  return security.isWifiPathAllowed(targetPath, wifiSharedDir);
}

// ADB helpers (from src/adb.js)
const findAdb = adb.findAdb;
const escapeShellArg = adb.escapeShellArg;
const runAdb = adb.runAdb;
const parseAdbLsOutput = adb.parseAdbLsOutput;
const getRemoteParent = adb.getRemoteParent;
const getRemoteRelative = adb.getRemoteRelative;
const remoteFileExists = adb.remoteFileExists;
const getRemoteFilesRecursive = adb.getRemoteFilesRecursive;

// Settings & history (from src/settings.js — wrappers pass `app`)
function loadSettings() { return settingsMod.loadSettings(app); }
function saveSettings(settings) { return settingsMod.saveSettings(app, settings); }
function loadHistory() { return settingsMod.loadHistory(app); }
function saveHistory(history) { return settingsMod.saveHistory(app, history); }
function addHistoryEntry(entry) { return settingsMod.addHistoryEntry(app, entry); }

// ─── ADB helper functions are imported from src/adb.js (#21) ─────────────────
// findAdb, escapeShellArg, runAdb, parseAdbLsOutput, getRemoteParent,
// getRemoteRelative, remoteFileExists, getRemoteFilesRecursive

// ─── Window Creation ─────────────────────────────────────────────────────────

function createWindow() {
  win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#0a0a0f',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    show: false,
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  // Graceful show once the renderer is painted
  win.once('ready-to-show', () => {
    win.show();
  });

  win.on('closed', () => {
    win = null;
  });

  console.log('[Main] Window created');
}

// ─── Device Detection Loop ───────────────────────────────────────────────────

/**
 * Polls `adb devices` every 3 seconds, compares with previous state,
 * and emits device-connected / device-disconnected events to the renderer.
 */
function startDeviceDetection() {
  devicePollInterval = setInterval(async () => {
    try {
      const { stdout } = await runAdb(['devices']);
      const lines = stdout.split('\n').slice(1); // skip header
      const currentIds = new Set();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const [id] = trimmed.split(/\s+/);
        if (id) currentIds.add(id);
      }

      // Detect newly connected devices
      for (const id of currentIds) {
        if (!knownDeviceIds.has(id)) {
          console.log(`[Device] Connected: ${id}`);
          if (win) win.webContents.send('device-connected', { id });
        }
      }

      // Detect disconnected devices
      for (const id of knownDeviceIds) {
        if (!currentIds.has(id)) {
          console.log(`[Device] Disconnected: ${id}`);
          if (win) win.webContents.send('device-disconnected', { id });
        }
      }

      knownDeviceIds = currentIds;
    } catch {
      // ADB not available or errored — silently ignore to avoid log spam
    }
  }, 3000);
}

// ─── IPC Handlers ────────────────────────────────────────────────────────────

// 1. Check whether ADB is installed
ipcMain.handle('check-adb', async () => {
  const adbPath = await findAdb();
  return { installed: adbPath !== null, path: adbPath };
});

// 2. List connected devices with extended info
ipcMain.handle('get-devices', async () => {
  try {
    const { stdout } = await runAdb(['devices', '-l']);
    const lines = stdout.split('\n').slice(1); // skip "List of devices attached"
    const devices = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      const parts = trimmed.split(/\s+/);
      const id = parts[0];
      const status = parts[1]; // device, unauthorized, offline …

      // Parse key:value pairs from the extended output
      let model = '';
      let product = '';
      for (let i = 2; i < parts.length; i++) {
        const [key, val] = parts[i].split(':');
        if (key === 'model') model = val || '';
        if (key === 'product') product = val || '';
      }

      devices.push({ id, status, model, product });
    }

    return devices;
  } catch (err) {
    console.error('[IPC] get-devices error:', err.message);
    return [];
  }
});

// 3. Detailed device info via getprop
ipcMain.handle('get-device-info', async (_event, deviceId) => {
  try {
    const props = {
      model: 'ro.product.model',
      manufacturer: 'ro.product.manufacturer',
      androidVersion: 'ro.build.version.release',
      serialNumber: 'ro.serialno',
    };

    const info = {};
    for (const [key, prop] of Object.entries(props)) {
      try {
        const { stdout } = await runAdb(['-s', deviceId, 'shell', 'getprop', prop]);
        info[key] = stdout.trim();
      } catch {
        info[key] = '';
      }
    }

    console.log(`[IPC] get-device-info for ${deviceId}:`, info);
    return info;
  } catch (err) {
    console.error('[IPC] get-device-info error:', err.message);
    return { model: '', manufacturer: '', androidVersion: '', serialNumber: '' };
  }
});

// 4. Storage usage on the device
ipcMain.handle('get-storage-info', async (_event, deviceId) => {
  try {
    const { stdout } = await runAdb(['-s', deviceId, 'shell', 'df', '/storage/emulated/0']);
    const lines = stdout.split('\n').filter((l) => l.trim());

    // The data line is the last non-empty line (first is the header)
    const dataLine = lines[lines.length - 1];
    const parts = dataLine.trim().split(/\s+/);
    // Columns: Filesystem  1K-blocks  Used  Available  Use%  Mounted on
    const total = parseInt(parts[1], 10) * 1024;
    const used = parseInt(parts[2], 10) * 1024;
    const free = parseInt(parts[3], 10) * 1024;

    return { total, used, free };
  } catch (err) {
    console.error('[IPC] get-storage-info error:', err.message);
    return { total: 0, used: 0, free: 0 };
  }
});

// 5. Browse local filesystem
ipcMain.handle('list-local-files', async (_event, dirPath) => {
  try {
    const resolvedPath = path.resolve(dirPath);
    if (!isPathAllowed(resolvedPath)) {
      console.warn(`[IPC] list-local-files denied: ${resolvedPath}`);
      return { currentPath: dirPath, files: [] };
    }
    const entries = await fs.promises.readdir(resolvedPath, { withFileTypes: true });

    const filePromises = entries.map(async (entry) => {
      try {
        const fullPath = path.join(dirPath, entry.name);
        const stat = await fs.promises.stat(fullPath);

        let itemCount;
        if (entry.isDirectory()) {
          try {
            const subEntries = await fs.promises.readdir(fullPath);
            itemCount = subEntries.length;
          } catch (e) {}
        }

        return {
          name: entry.name,
          isDirectory: entry.isDirectory(),
          itemCount,
          size: stat.size,
          modified: stat.mtime.toISOString(),
          extension: entry.isDirectory() ? '' : path.extname(entry.name).slice(1),
          fullPath,
        };
      } catch {
        return null;
      }
    });

    const fileResults = await Promise.all(filePromises);
    const files = fileResults.filter(Boolean);

    // Sort: directories first, then alphabetical (case-insensitive)
    files.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    return { currentPath: dirPath, files };
  } catch (err) {
    console.error('[IPC] list-local-files error:', err.message);
    return { currentPath: dirPath, files: [] };
  }
});

// 6. Browse remote (device) filesystem
ipcMain.handle('list-remote-files', async (_event, { deviceId, dirPath }) => {
  try {
    const targetPath = (dirPath && !dirPath.endsWith('/')) ? dirPath + '/' : dirPath;
    let { stdout } = await runAdb(['-s', deviceId, 'shell', 'ls', '-la', escapeShellArg(targetPath)]);
    let parsed = parseAdbLsOutput(stdout);

    // Fallback: if listing returned only 1 entry matching the symlink itself, force trailing slash
    if (parsed.length === 1 && parsed[0].name === path.basename(dirPath)) {
      const retryRes = await runAdb(['-s', deviceId, 'shell', 'ls', '-la', escapeShellArg(dirPath + '/')]);
      if (retryRes.stdout) {
        parsed = parseAdbLsOutput(retryRes.stdout);
      }
    }

    const files = parsed.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory,
      isSymlink: entry.isSymlink,
      size: entry.size,
      modified: entry.modified,
      permissions: entry.permissions,
      fullPath: (dirPath.replace(/\/+$/, '') + '/' + entry.name).replace(/\/+/g, '/'),
    }));

    // Sort: directories first, then alphabetical
    files.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

    return { currentPath: dirPath, files };
  } catch (err) {
    console.error('[IPC] list-remote-files error:', err.message);
    return { currentPath: dirPath, files: [] };
  }
});

// ─── Recursive Helpers for Transfer ──────────────────────────────────────────

async function getLocalFilesRecursive(baseDir, currentDir) {
  let results = [];
  try {
    const list = await fs.promises.readdir(currentDir, { withFileTypes: true });
    for (const entry of list) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(await getLocalFilesRecursive(baseDir, fullPath));
      } else {
        const relativePath = path.relative(baseDir, fullPath);
        results.push({
          fullPath,
          relativePath,
        });
      }
    }
  } catch (err) {
    console.error(`[LocalRecursive] Error reading ${currentDir}:`, err.message);
  }
  return results;
}

// getRemoteFilesRecursive, getRemoteParent, getRemoteRelative, remoteFileExists
// are imported from src/adb.js (#21)

function runAdbWithProgress(adbPath, args, onProgressLine) {
  return new Promise((resolve, reject) => {
    const execPath = adbPath || 'adb';
    console.log(`[Spawn] ${execPath} ${args.join(' ')}`);
    
    const proc = spawn(execPath, args);
    currentTransferProc = proc;
    let stdoutBuffer = '';
    let stderrBuffer = '';

    proc.stdout.on('data', (data) => {
      const str = data.toString();
      stdoutBuffer += str;
      const lines = str.split(/[\r\n]+/);
      for (const line of lines) {
        if (line.trim()) onProgressLine(line);
      }
    });

    proc.stderr.on('data', (data) => {
      const str = data.toString();
      stderrBuffer += str;
      const lines = str.split(/[\r\n]+/);
      for (const line of lines) {
        if (line.trim()) onProgressLine(line);
      }
    });

    proc.on('close', (code) => {
      currentTransferProc = null;
      if (transferCancelled) {
        reject(new Error('Transfer cancelled'));
        return;
      }
      if (code === 0) {
        resolve();
      } else {
        const err = new Error(`Command failed with exit code ${code}`);
        err.stdout = stdoutBuffer;
        err.stderr = stderrBuffer;
        reject(err);
      }
    });

    proc.on('error', (err) => {
      currentTransferProc = null;
      reject(err);
    });
  });
}

/**
 * Get the size of a remote file on the device via `adb shell stat`.
 * Returns 0 if the file doesn't exist or stat fails.
 */
async function getRemoteFileSize(deviceId, remotePath) {
  try {
    const { stdout } = await runAdb(['-s', deviceId, 'shell', 'stat', '-c', '%s', escapeShellArg(remotePath)]);
    return parseInt(stdout.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Push a single file with size-polling progress (modern adb doesn't emit %).
 * Calls onProgress(percent 0-100) periodically during the transfer.
 */
function pushWithProgress(adbPath, deviceId, localPath, remoteDest, localSize, onProgress) {
  return new Promise((resolve, reject) => {
    const execPath = adbPath || 'adb';
    const proc = spawn(execPath, ['-s', deviceId, 'push', localPath, remoteDest]);
    currentTransferProc = proc;

    let stderrBuffer = '';
    let pollTimer = null;

    // Poll remote file size every 300ms to estimate progress
    pollTimer = setInterval(async () => {
      if (transferCancelled) return;
      try {
        const remoteSize = await getRemoteFileSize(deviceId, remoteDest);
        if (remoteSize > 0 && localSize > 0) {
          const pct = Math.min(Math.round((remoteSize / localSize) * 100), 99);
          onProgress(pct);
        }
      } catch (e) {}
    }, 300);

    proc.on('close', (code) => {
      currentTransferProc = null;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (transferCancelled) {
        reject(new Error('Transfer cancelled'));
        return;
      }
      if (code === 0) {
        onProgress(100);
        resolve();
      } else {
        const err = new Error(`Push failed (exit ${code}): ${stderrBuffer}`);
        reject(err);
      }
    });

    proc.on('error', (err) => {
      currentTransferProc = null;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      reject(err);
    });
  });
}

/**
 * Pull a single file with size-polling progress.
 */
function pullWithProgress(adbPath, deviceId, remotePath, localDest, remoteSize, onProgress) {
  return new Promise((resolve, reject) => {
    const execPath = adbPath || 'adb';
    const proc = spawn(execPath, ['-s', deviceId, 'pull', remotePath, localDest]);
    currentTransferProc = proc;

    let stderrBuffer = '';
    let pollTimer = null;

    // Poll local file size every 300ms to estimate progress
    pollTimer = setInterval(() => {
      if (transferCancelled) return;
      try {
        if (fs.existsSync(localDest)) {
          const stat = fs.statSync(localDest);
          if (stat.size > 0 && remoteSize > 0) {
            const pct = Math.min(Math.round((stat.size / remoteSize) * 100), 99);
            onProgress(pct);
          }
        }
      } catch (e) {}
    }, 300);

    proc.on('close', (code) => {
      currentTransferProc = null;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      if (transferCancelled) {
        reject(new Error('Transfer cancelled'));
        return;
      }
      if (code === 0) {
        onProgress(100);
        resolve();
      } else {
        const err = new Error(`Pull failed (exit ${code}): ${stderrBuffer}`);
        reject(err);
      }
    });

    proc.on('error', (err) => {
      currentTransferProc = null;
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      reject(err);
    });
  });
}

// 7. Push files from Mac → Android (with folder expansion, conflict resolution, and real-time progress)
ipcMain.handle('push-files', async (_event, { deviceId, localPaths, remotePath }) => {
  const adbPath = await findAdb();
  transferCancelled = false; // Reset cancel flag at the start of a new transfer

  // 1. Expand all localPaths into a flat list of files with relative paths
  const filesToTransfer = [];
  for (const p of localPaths) {
    try {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        const parentDir = path.dirname(p);
        const dirFiles = await getLocalFilesRecursive(parentDir, p);
        filesToTransfer.push(...dirFiles);
      } else {
        filesToTransfer.push({
          fullPath: p,
          relativePath: path.basename(p),
        });
      }
    } catch (err) {
      console.error(`[Push] Stat failed for ${p}:`, err.message);
    }
  }

  const total = filesToTransfer.length;
  let transferred = 0;
  let failed = 0;
  const errors = [];
  let conflictResolution = null; // null, 'replace-all', 'skip-all'

  for (let i = 0; i < total; i++) {
    if (transferCancelled) break;
    const file = filesToTransfer[i];
    const fileName = path.basename(file.fullPath);
    const remoteDest = remotePath.replace(/\/+$/, '') + '/' + file.relativePath;
    const remoteDestDir = remoteDest.substring(0, remoteDest.lastIndexOf('/'));

    try {
      // Conflict check
      let exists = false;
      if (conflictResolution !== 'replace-all' && conflictResolution !== 'skip-all') {
        exists = await remoteFileExists(deviceId, remoteDest);
      } else if (conflictResolution === 'skip-all') {
        exists = true;
      }

      if (exists) {
        if (conflictResolution === 'skip-all') {
          console.log(`[Push] Skipping existing file: ${file.relativePath}`);
          continue;
        }

        if (conflictResolution !== 'replace-all') {
          const response = await dialog.showMessageBox(win, {
            type: 'question',
            buttons: ['Replace', 'Replace All', 'Skip', 'Skip All', 'Cancel'],
            defaultId: 0,
            cancelId: 4,
            title: 'File Conflict',
            message: `The file "${file.relativePath}" already exists on the phone.\nWhat would you like to do?`
          });
          const responseIdx = response.response;

          if (responseIdx === 1) { // Replace All
            conflictResolution = 'replace-all';
          } else if (responseIdx === 2) { // Skip
            continue;
          } else if (responseIdx === 3) { // Skip All
            conflictResolution = 'skip-all';
            continue;
          } else if (responseIdx === 4) { // Cancel
            break; // Abort the whole batch
          }
          // responseIdx === 0 (Replace) -> continues to transfer
        }
      }

      if (transferCancelled) break;

      console.log(`[Push] ${fileName} (${i + 1}/${total}) → ${remoteDest}`);

      // Ensure the remote parent directory exists first
      if (remoteDestDir && remoteDestDir !== '/storage/emulated/0' && remoteDestDir !== '/sdcard') {
        await runAdb(['-s', deviceId, 'shell', 'mkdir', '-p', escapeShellArg(remoteDestDir)]);
      }

      // Send initial progress for this file
      if (win) {
        win.webContents.send('transfer-progress', {
          current: i + 1,
          total,
          fileName,
          percent: Math.round((i / total) * 100),
        });
      }

      // Get local file size for progress polling
      const localFileSize = fs.statSync(file.fullPath).size;

      // Run adb push with size-polling progress
      await pushWithProgress(adbPath, deviceId, file.fullPath, remoteDest, localFileSize, (currentFilePercent) => {
        if (win) {
          const basePercent = (i / total) * 100;
          const fileContribution = (1 / total) * currentFilePercent;
          const overallPercent = Math.round(basePercent + fileContribution);
          win.webContents.send('transfer-progress', {
            current: i + 1,
            total,
            fileName,
            percent: Math.min(overallPercent, 99),
          });
        }
      });

      if (transferCancelled) break;
      transferred++;
    } catch (err) {
      if (transferCancelled) break;
      failed++;
      errors.push({ file: fileName, error: err.message });
      console.error(`[Push] Failed ${fileName}:`, err.message);
    }
  }

  // Final 100% update (skip if the user cancelled)
  if (win && total > 0 && !transferCancelled) {
    win.webContents.send('transfer-progress', {
      current: total,
      total,
      fileName: 'Completed',
      percent: 100,
    });
  }

  const result = { success: failed === 0 && !transferCancelled, transferred, failed, errors, cancelled: transferCancelled };
  if (transferred > 0) {
    addHistoryEntry({
      timestamp: new Date().toISOString(),
      direction: 'push',
      deviceId,
      remotePath,
      fileCount: transferred,
      failed,
    });
  }
  return result;
});

// 8. Pull files from Android → Mac (with folder expansion, conflict resolution, and real-time progress)
ipcMain.handle('pull-files', async (_event, { deviceId, remotePaths, localPath }) => {
  const adbPath = await findAdb();
  transferCancelled = false; // Reset cancel flag at the start of a new transfer

  // 1. Expand all remotePaths recursively
  const filesToTransfer = [];
  for (const p of remotePaths) {
    const parentPath = getRemoteParent(p);
    const remoteFiles = await getRemoteFilesRecursive(deviceId, p);
    for (const rf of remoteFiles) {
      filesToTransfer.push({
        fullPath: rf,
        relativePath: getRemoteRelative(parentPath, rf),
      });
    }
  }

  const total = filesToTransfer.length;
  let transferred = 0;
  let failed = 0;
  const errors = [];
  let conflictResolution = null; // null, 'replace-all', 'skip-all'

  for (let i = 0; i < total; i++) {
    if (transferCancelled) break;
    const file = filesToTransfer[i];
    const fileName = file.fullPath.split('/').pop();
    const localDest = path.join(localPath, file.relativePath);
    const localDestDir = path.dirname(localDest);

    try {
      // Conflict check
      let exists = false;
      if (conflictResolution !== 'replace-all' && conflictResolution !== 'skip-all') {
        exists = fs.existsSync(localDest);
      } else if (conflictResolution === 'skip-all') {
        exists = true;
      }

      if (exists) {
        if (conflictResolution === 'skip-all') {
          console.log(`[Pull] Skipping existing file: ${file.relativePath}`);
          continue;
        }

        if (conflictResolution !== 'replace-all') {
          const response = await dialog.showMessageBox(win, {
            type: 'question',
            buttons: ['Replace', 'Replace All', 'Skip', 'Skip All', 'Cancel'],
            defaultId: 0,
            cancelId: 4,
            title: 'File Conflict',
            message: `The file "${file.relativePath}" already exists on your Mac.\nWhat would you like to do?`
          });
          const responseIdx = response.response;

          if (responseIdx === 1) { // Replace All
            conflictResolution = 'replace-all';
          } else if (responseIdx === 2) { // Skip
            continue;
          } else if (responseIdx === 3) { // Skip All
            conflictResolution = 'skip-all';
            continue;
          } else if (responseIdx === 4) { // Cancel
            break; // Abort
          }
          // responseIdx === 0 (Replace) -> continues to transfer
        }
      }

      if (transferCancelled) break;

      console.log(`[Pull] ${fileName} (${i + 1}/${total}) → ${localDest}`);

      // Ensure the local parent directory exists
      if (localDestDir) {
        fs.mkdirSync(localDestDir, { recursive: true });
      }

      // Send initial progress for this file
      if (win) {
        win.webContents.send('transfer-progress', {
          current: i + 1,
          total,
          fileName,
          percent: Math.round((i / total) * 100),
        });
      }

      // Get remote file size for progress polling
      const remoteFileSize = await getRemoteFileSize(deviceId, file.fullPath);

      // Run adb pull with size-polling progress
      await pullWithProgress(adbPath, deviceId, file.fullPath, localDest, remoteFileSize, (currentFilePercent) => {
        if (win) {
          const basePercent = (i / total) * 100;
          const fileContribution = (1 / total) * currentFilePercent;
          const overallPercent = Math.round(basePercent + fileContribution);
          win.webContents.send('transfer-progress', {
            current: i + 1,
            total,
            fileName,
            percent: Math.min(overallPercent, 99),
          });
        }
      });

      if (transferCancelled) break;
      transferred++;
    } catch (err) {
      if (transferCancelled) break;
      failed++;
      errors.push({ file: fileName, error: err.message });
      console.error(`[Pull] Failed ${fileName}:`, err.message);
    }
  }

  // Final 100% update (skip if the user cancelled)
  if (win && total > 0 && !transferCancelled) {
    win.webContents.send('transfer-progress', {
      current: total,
      total,
      fileName: 'Completed',
      percent: 100,
    });
  }

  const result = { success: failed === 0 && !transferCancelled, transferred, failed, errors, cancelled: transferCancelled };
  if (transferred > 0) {
    addHistoryEntry({
      timestamp: new Date().toISOString(),
      direction: 'pull',
      deviceId,
      localPath,
      fileCount: transferred,
      failed,
    });
  }
  return result;
});

// Cancel an in-progress push/pull transfer. Sets the cancel flag and kills the
// active adb spawn so the running file aborts immediately.
ipcMain.handle('cancel-transfer', async () => {
  transferCancelled = true;
  transferPaused = false;
  if (currentTransferProc) {
    try { currentTransferProc.kill('SIGTERM'); } catch (e) {}
  }
  return { success: true };
});

// Pause an in-progress transfer by sending SIGSTOP to the adb process.
// The file copy halts at the OS level until resumed.
ipcMain.handle('pause-transfer', async () => {
  if (!currentTransferProc) return { success: false, error: 'No active transfer' };
  try {
    transferPaused = true;
    currentTransferProc.kill('SIGSTOP');
    return { success: true, paused: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Resume a paused transfer by sending SIGCONT to the adb process.
ipcMain.handle('resume-transfer', async () => {
  if (!currentTransferProc) return { success: false, error: 'No active transfer' };
  try {
    transferPaused = false;
    currentTransferProc.kill('SIGCONT');
    return { success: true, paused: false };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// Clipboard support — navigator.clipboard can fail in sandboxed renderers
const { clipboard } = require('electron');
ipcMain.handle('copy-to-clipboard', (_event, text) => {
  try {
    clipboard.writeText(text);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 9. Delete a file or directory on the device
ipcMain.handle('delete-remote', async (_event, { deviceId, remotePath }) => {
  try {
    await runAdb(['-s', deviceId, 'shell', 'rm', '-rf', escapeShellArg(remotePath)]);
    console.log(`[Delete] Removed remote: ${remotePath}`);
    return { success: true };
  } catch (err) {
    console.error('[IPC] delete-remote error:', err.message);
    return { success: false, error: err.message };
  }
});

// Delete local file or directory on Mac (moves to macOS Trash)
ipcMain.handle('delete-local', async (_event, filePath) => {
  try {
    const resolvedPath = path.resolve(filePath);
    if (!isPathAllowed(resolvedPath)) {
      return { success: false, error: 'Access denied' };
    }
    if (fs.existsSync(resolvedPath)) {
      if (shell && shell.trashItem) {
        await shell.trashItem(resolvedPath);
      } else {
        fs.rmSync(resolvedPath, { recursive: true, force: true });
      }
      console.log(`[Delete] Moved to trash: ${resolvedPath}`);
      return { success: true };
    }
    return { success: false, error: 'File not found' };
  } catch (err) {
    console.error('[IPC] delete-local error:', err.message);
    return { success: false, error: err.message };
  }
});

// 10. Create a directory on the device
ipcMain.handle('create-remote-dir', async (_event, { deviceId, remotePath }) => {
  try {
    await runAdb(['-s', deviceId, 'shell', 'mkdir', '-p', escapeShellArg(remotePath)]);
    console.log(`[Mkdir] Created: ${remotePath}`);
    return { success: true };
  } catch (err) {
    console.error('[IPC] create-remote-dir error:', err.message);
    return { success: false, error: err.message };
  }
});

// ─── Settings & History IPC handlers (#17, #18, #13) ─────────────────────────
// loadSettings/saveSettings/loadHistory/saveHistory/addHistoryEntry are
// imported from src/settings.js via wrapper aliases above.

ipcMain.handle('get-settings', () => {
  return loadSettings();
});

ipcMain.handle('set-settings', (_event, partial) => {
  try {
    const current = loadSettings();
    const merged = { ...current, ...partial };
    saveSettings(merged);
    return { success: true, settings: merged };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-transfer-history', () => {
  return loadHistory();
});

ipcMain.handle('clear-transfer-history', () => {
  saveHistory([]);
  return { success: true };
});

// ─── File Rename (#16) ──────────────────────────────────────────────────────

ipcMain.handle('rename-local', async (_event, { oldPath, newName }) => {
  try {
    const resolvedOld = path.resolve(oldPath);
    if (!isPathAllowed(resolvedOld)) return { success: false, error: 'Access denied' };
    const newPath = path.join(path.dirname(resolvedOld), newName);
    if (!isPathAllowed(path.resolve(newPath))) return { success: false, error: 'Access denied' };
    if (fs.existsSync(newPath)) return { success: false, error: 'A file with that name already exists' };
    fs.renameSync(resolvedOld, newPath);
    console.log(`[Rename] ${resolvedOld} → ${newPath}`);
    return { success: true };
  } catch (err) {
    console.error('[IPC] rename-local error:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('rename-remote', async (_event, { deviceId, remotePath, newName }) => {
  try {
    const parent = getRemoteParent(remotePath);
    const newPath = parent === '/' ? '/' + newName : parent + '/' + newName;
    await runAdb(['-s', deviceId, 'shell', 'mv', escapeShellArg(remotePath), escapeShellArg(newPath)]);
    console.log(`[Rename] ${remotePath} → ${newPath}`);
    return { success: true };
  } catch (err) {
    console.error('[IPC] rename-remote error:', err.message);
    return { success: false, error: err.message };
  }
});

// ─── Auto-Update Check (#20) ─────────────────────────────────────────────────

ipcMain.handle('check-for-updates', async () => {
  try {
    const settings = loadSettings();
    const repo = settings.updateRepo || '';
    if (!repo) return { success: false, error: 'No update repository configured. Set one in Settings.' };

    const https = require('https');
    const data = await new Promise((resolve, reject) => {
      https.get({
        hostname: 'api.github.com',
        path: `/repos/${repo}/releases/latest`,
        headers: { 'User-Agent': 'DroidBridge-Update-Check', 'Accept': 'application/vnd.github+json' },
        timeout: 10000,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`GitHub API returned ${res.statusCode}`));
            return;
          }
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error('Failed to parse GitHub response')); }
        });
      }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('Request timed out')); });
    });

    const latestVersion = (data.tag_name || '').replace(/^v/, '');
    const currentVersion = app.getVersion();
    const downloadUrl = (data.html_url) || '';
    const releaseNotes = (data.body || '').slice(0, 500);

    return {
      success: true,
      currentVersion,
      latestVersion,
      hasUpdate: latestVersion && latestVersion !== currentVersion,
      downloadUrl,
      releaseNotes,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// 11. Return the user's home directory
ipcMain.handle('get-home-dir', () => {
  return os.homedir();
});

// 12. Open a native directory picker
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

// 13. Open a native file picker (multi-select)
ipcMain.handle('select-files', async () => {
  const result = await dialog.showOpenDialog(win, {
    properties: ['openFile', 'multiSelections'],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths;
});

// 14. Reveal a file in Finder (only allowed paths)
ipcMain.handle('open-in-finder', (_event, filePath) => {
  if (!filePath) return;
  const resolvedPath = path.resolve(filePath);
  if (isPathAllowed(resolvedPath)) {
    shell.showItemInFolder(resolvedPath);
  } else {
    console.warn(`[IPC] open-in-finder denied: ${resolvedPath}`);
  }
});

// 15. Create a temporary transfer directory on Mac
ipcMain.handle('get-temp-dir', () => {
  const randomSuffix = crypto.randomBytes(16).toString('hex');
  const tempPath = path.join(os.tmpdir(), `droidbridge-temp-${randomSuffix}`);
  fs.mkdirSync(tempPath, { recursive: true, mode: 0o700 });
  return tempPath;
});

// 16. Delete a temporary transfer directory on Mac
ipcMain.handle('cleanup-dir', (_event, dirPath) => {
  try {
    const resolvedPath = path.resolve(dirPath);
    const tmpDir = path.resolve(os.tmpdir());
    // Only allow deletion of paths that actually resolve inside the system temp directory
    if (resolvedPath.startsWith(tmpDir) && resolvedPath.includes('droidbridge-temp-')) {
      fs.rmSync(resolvedPath, { recursive: true, force: true });
      console.log(`[Cleanup] Deleted temp transfer dir: ${resolvedPath}`);
    } else {
      console.warn(`[Cleanup] Rejected deletion attempt outside tmpdir: ${resolvedPath}`);
    }
  } catch (err) {
    console.error('[IPC] cleanup-dir error:', err.message);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Wi-Fi Transfer Server
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');
const QRCode = require('qrcode');

const defaultSharedDir = app.isPackaged
  ? path.join(os.homedir(), 'Downloads', 'DroidBridge-WiFi-Share')
  : path.join(__dirname, 'DroidBridge-WiFi-Share');

let wifiSharedDir = defaultSharedDir;
let wifiServer = null;
let wifiPort = 8080;
let wifiActive = false;
let wifiQrDataUrl = '';
let wifiRateLimitMap = new Map(); // IP -> request count for basic rate limiting
let wifiToken = ''; // Session access token for Wi-Fi authentication (F1)
let wifiCleanupTimer = null; // Pruning timer for rate limit map memory leak (F8)

// isWifiPathAllowed, getCookie, tokenEquals are imported from src/security.js (#21)

function getLocalIpAddress() {
  const interfaces = os.networkInterfaces();
  for (const devName in interfaces) {
    const iface = interfaces[devName];
    for (const alias of iface) {
      if (alias.family === 'IPv4' && !alias.internal) {
        return alias.address;
      }
    }
  }
  return '127.0.0.1';
}

// Mobile Web UI template
let _mobileHtmlTemplate = '';
function getMobileHtml(nonce = '') {
  if (!_mobileHtmlTemplate) {
    try { _mobileHtmlTemplate = fs.readFileSync(path.join(__dirname, 'mobile.html'), 'utf-8'); }
    catch (e) { console.error('[WiFi] Failed to load mobile.html:', e.message); return '<h1>Template load error</h1>'; }
  }
  const currentFolderName = path.basename(wifiSharedDir) || 'Shared';
  return _mobileHtmlTemplate
    .replace(/__NONCE__/g, nonce)
    .replace(/__FOLDER_NAME__/g, currentFolderName);
}

let _loginHtmlTemplate = '';
function getLoginHtml(errorMsg = '', nonce = '') {
  if (!_loginHtmlTemplate) {
    try { _loginHtmlTemplate = fs.readFileSync(path.join(__dirname, 'login.html'), 'utf-8'); }
    catch (e) { console.error('[WiFi] Failed to load login.html:', e.message); return '<h1>Template load error</h1>'; }
  }
  const errorHtml = errorMsg ? '<div class="error-msg">' + errorMsg + '</div>' : '';
  return _loginHtmlTemplate
    .replace(/__NONCE__/g, nonce)
    .replace(/__ERROR_MSG__/, errorHtml);
}

// Start Wi-Fi Server
let wifiRetryCount = 0;
const WIFI_MAX_RETRIES = 20;

async function startWifiServer() {
  if (wifiActive) {
    wifiRetryCount = 0;
    return {
      success: true,
      port: wifiPort,
      ip: getLocalIpAddress(),
      qrCode: wifiQrDataUrl,
      sharedDir: wifiSharedDir,
      token: wifiToken
    };
  }

  // Apply saved Wi-Fi port setting (if present and valid) before binding
  try {
    const saved = loadSettings();
    if (saved.wifiPort && Number.isInteger(saved.wifiPort) && saved.wifiPort >= 1024 && saved.wifiPort <= 65535) {
      wifiPort = saved.wifiPort;
      console.log(`[WiFi] Using saved port from settings: ${wifiPort}`);
    }
  } catch (e) {}

  // Ensure shared directory exists
  try {
    fs.mkdirSync(wifiSharedDir, { recursive: true });
  } catch (err) {
    console.error('[WiFi] Shared dir creation failed:', err.message);
  }

  // Generate dynamic cryptographically secure access token for Wi-Fi Sharing (F1)
  wifiToken = crypto.randomBytes(16).toString('hex');

  // Start periodic cleanup of the rate-limit map to prevent memory leak (F8)
  wifiCleanupTimer = setInterval(() => {
    const cutoff = Date.now() - 5 * 60000;
    for (const [ip, entry] of wifiRateLimitMap.entries()) {
      if (entry.windowStart < cutoff) {
        wifiRateLimitMap.delete(ip);
      }
    }
  }, 5 * 60000);

  const localIp = getLocalIpAddress();
  const url = `http://${localIp}:${wifiPort}/?token=${wifiToken}`;

  // Generate QR Code
  try {
    wifiQrDataUrl = await QRCode.toDataURL(url);
  } catch (err) {
    console.error('[WiFi] QR generation failed:', err.message);
    wifiQrDataUrl = '';
  }

  return new Promise((resolve) => {
    wifiServer = http.createServer((req, res) => {
      const reqUrl = new URL(req.url, `http://${req.headers.host}`);

      // Simple rate limiting: 120 requests per minute per IP
      const clientIp = req.socket.remoteAddress;
      const now = Date.now();
      const windowMs = 60000;
      if (!wifiRateLimitMap.has(clientIp)) {
        wifiRateLimitMap.set(clientIp, { count: 1, windowStart: now });
      } else {
        const entry = wifiRateLimitMap.get(clientIp);
        if (now - entry.windowStart > windowMs) {
          entry.count = 1;
          entry.windowStart = now;
        } else {
          entry.count++;
          if (entry.count > 120) {
            res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '60' });
            res.end('Too Many Requests');
            return;
          }
        }
      }

      // Handle Login POST
      if (reqUrl.pathname === '/login' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          const params = new URLSearchParams(body);
          const submittedToken = params.get('token');
          if (tokenEquals(submittedToken, wifiToken)) {
            res.writeHead(302, {
              'Set-Cookie': `sid=${wifiToken}; Path=/; HttpOnly; SameSite=Strict`,
              'Location': '/'
            });
            res.end();
          } else {
            const nonce = crypto.randomBytes(16).toString('hex');
            res.writeHead(200, {
              'Content-Type': 'text/html',
              'Content-Security-Policy': `default-src 'self'; style-src 'self' 'nonce-${nonce}';`
            });
            res.end(getLoginHtml('Invalid token, please try again.', nonce));
          }
        });
        return;
      }

      // Validate Authentication (F1)
      const queryToken = reqUrl.searchParams.get('token');
      const cookieToken = getCookie(req, 'sid');
      const isAuthenticated = tokenEquals(queryToken, wifiToken) || tokenEquals(cookieToken, wifiToken);

      // Auto-set cookie and redirect to clean URL if token is passed via query
      if (tokenEquals(queryToken, wifiToken) && !tokenEquals(cookieToken, wifiToken)) {
        res.writeHead(302, {
          'Set-Cookie': `sid=${wifiToken}; Path=/; HttpOnly; SameSite=Strict`,
          'Location': '/'
        });
        res.end();
        return;
      }

      if (!isAuthenticated) {
        if (reqUrl.pathname === '/' && req.method === 'GET') {
          const nonce = crypto.randomBytes(16).toString('hex');
          res.writeHead(200, {
            'Content-Type': 'text/html',
            'Content-Security-Policy': `default-src 'self'; style-src 'self' 'nonce-${nonce}';`
          });
          res.end(getLoginHtml('', nonce));
        } else {
          res.writeHead(401, { 'Content-Type': 'text/plain' });
          res.end('Unauthorized');
        }
        return;
      }

      // Serve Mobile UI
      if (reqUrl.pathname === '/' && req.method === 'GET') {
        const nonce = crypto.randomBytes(16).toString('hex');
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Content-Security-Policy': `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; font-src 'self' data:;`
        });
        res.end(getMobileHtml(nonce));
        return;
      }

      // Serve JSON list of shared files
      if (reqUrl.pathname === '/files' && req.method === 'GET') {
        try {
          const subPath = reqUrl.searchParams.get('path') || '';
          const targetPath = path.resolve(wifiSharedDir, subPath);
          if (!isWifiPathAllowed(targetPath)) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Access Denied');
            return;
          }
          if (!fs.existsSync(targetPath)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ folderName: path.basename(wifiSharedDir) || 'Shared', files: [] }));
            return;
          }
          const files = fs.readdirSync(targetPath).map(name => {
            const filePath = path.join(targetPath, name);
            const stat = fs.statSync(filePath);
            return { name, size: stat.isDirectory() ? 0 : stat.size, isDirectory: stat.isDirectory() };
          }).filter(f => !f.name.startsWith('.'));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ folderName: path.basename(wifiSharedDir) || 'Shared', files }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(err.message);
        }
        return;
      }

      // Handle File Downloads & Streaming Previews
      if (reqUrl.pathname === '/download' && req.method === 'GET') {
        const fileName = reqUrl.searchParams.get('file');
        if (!fileName) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing file parameter');
          return;
        }
        const filePath = path.resolve(wifiSharedDir, fileName);
        if (!isWifiPathAllowed(filePath)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Access Denied');
          return;
        }
        if (!fs.existsSync(filePath)) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('File not found');
          return;
        }
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Cannot download a directory');
          return;
        }

        const ext = path.extname(filePath).toLowerCase().replace('.', '');
        const mimeTypes = {
          jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
          mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', m4v: 'video/x-m4v', '3gp': 'video/3gpp',
          mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', ogg: 'audio/ogg',
          pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', json: 'application/json'
        };

        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
        const videoExts = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', '3gp'];
        const audioExts = ['mp3', 'wav', 'flac', 'm4a', 'ogg'];
        const docExts = ['pdf', 'txt', 'json'];
        const allowedInlineExts = [...imageExts, ...videoExts, ...audioExts, ...docExts];
        const isInline = reqUrl.searchParams.get('inline') === '1' && allowedInlineExts.includes(ext);

        const range = req.headers.range;
        if (range) {
          const parts = range.replace(/bytes=/, "").split("-");
          const start = parseInt(parts[0], 10);
          const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
          const chunksize = (end - start) + 1;
          const file = fs.createReadStream(filePath, { start, end });
          res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunksize,
            'Content-Type': contentType,
          });
          // Clean up read stream if client disconnects
          res.on('close', () => { file.destroy(); });
          file.pipe(res);
          return;
        }

        const headers = {
          'Content-Type': contentType,
          'Content-Length': stat.size,
          'Accept-Ranges': 'bytes',
        };

        if (!isInline || reqUrl.searchParams.get('dl') === '1') {
          headers['Content-Disposition'] = `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`;
        }

        res.writeHead(200, headers);
        const readStream = fs.createReadStream(filePath);
        res.on('close', () => { readStream.destroy(); });
        readStream.pipe(res);
        return;
      }

      // Handle Folder ZIP Downloads (#19)
      if (reqUrl.pathname === '/download-folder' && req.method === 'GET') {
        const folderName = reqUrl.searchParams.get('folder');
        if (!folderName) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing folder parameter');
          return;
        }
        const folderPath = path.resolve(wifiSharedDir, folderName);
        if (!isWifiPathAllowed(folderPath)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Access Denied');
          return;
        }
        if (!fs.existsSync(folderPath) || !fs.statSync(folderPath).isDirectory()) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Folder not found');
          return;
        }

        try {
          const archiver = require('archiver');
          const zipName = path.basename(folderPath) + '.zip';
          res.writeHead(200, {
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="${encodeURIComponent(zipName)}"`,
          });
          const archive = archiver('zip', { zlib: { level: 5 } });
          archive.directory(folderPath, path.basename(folderPath));
          archive.on('error', (err) => {
            console.error('[WiFi] ZIP error:', err.message);
          });
          res.on('close', () => { archive.destroy(); });
          archive.pipe(res);
          archive.finalize();
        } catch (err) {
          console.error('[WiFi] ZIP download failed:', err.message);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('ZIP creation failed: ' + err.message);
          }
        }
        return;
      }

      // Handle File Uploads (piped binary stream)
      if (reqUrl.pathname === '/upload' && req.method === 'POST') {
        const rawFileName = req.headers['x-file-name'];
        if (!rawFileName) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('Missing file name header');
          return;
        }
        const fileName = decodeURIComponent(rawFileName);
        const filePath = path.resolve(wifiSharedDir, fileName);
        if (!isWifiPathAllowed(filePath)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' });
          res.end('Access Denied');
          return;
        }

        const totalSize = parseInt(req.headers['content-length'] || '0', 10);
        const MAX_UPLOAD_SIZE = 100 * 1024 * 1024 * 1024; // 100 GB
        if (totalSize > MAX_UPLOAD_SIZE) {
          res.writeHead(413, { 'Content-Type': 'text/plain' });
          res.end('File too large');
          return;
        }

        // Ensure parent directories exist
        const parentDir = path.dirname(filePath);
        try {
          fs.mkdirSync(parentDir, { recursive: true });
        } catch (err) {
          console.error('[WiFi] Subdir creation failed:', err.message);
        }
        
        const writeStream = fs.createWriteStream(filePath);
        let uploadedSize = 0;
        let limitExceeded = false;

        req.on('data', (chunk) => {
          uploadedSize += chunk.length;
          if (uploadedSize > MAX_UPLOAD_SIZE) {
            limitExceeded = true;
            writeStream.destroy();
            req.destroy(); // Abort request
            fs.unlink(filePath, () => {});
            return;
          }
          if (win && totalSize > 0) {
            const percent = Math.round((uploadedSize / totalSize) * 100);
            win.webContents.send('wifi-upload-progress', { fileName, percent });
          }
        });

        req.pipe(writeStream);

        writeStream.on('finish', () => {
          if (limitExceeded) return;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          // Notify desktop UI to refresh listing
          if (win) {
            win.webContents.send('wifi-upload-progress', { fileName, percent: 100, completed: true });
          }
          // Record in transfer history (#13)
          try {
            // Strip IPv4-mapped IPv6 prefix (::ffff:) to show clean IPv4
            let clientIp = req.socket.remoteAddress || '';
            if (clientIp.startsWith('::ffff:')) clientIp = clientIp.slice(7);
            addHistoryEntry({
              timestamp: new Date().toISOString(),
              direction: 'wifi-upload',
              fileName,
              fileSize: totalSize,
              clientIp,
              fileCount: 1,
              failed: 0,
            });
          } catch (e) { console.error('[History] Wi-Fi upload record failed:', e.message); }
        });

        writeStream.on('error', (err) => {
          if (limitExceeded) return;
          console.error('[WiFi] Upload write error:', err.message);
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end(err.message);
        });

        return;
      }

      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not Found');
    });

    wifiServer.listen(wifiPort, () => {
      wifiActive = true;
      wifiRetryCount = 0; // Reset retry counter once we successfully bind
      console.log(`[WiFi] Server listening at ${url}`);
      resolve({ success: true, port: wifiPort, ip: localIp, qrCode: wifiQrDataUrl, sharedDir: wifiSharedDir, token: wifiToken });
    });

    wifiServer.on('error', (err) => {
      console.error('[WiFi] Server error:', err.message);
      if (err.code === 'EADDRINUSE') {
        wifiRetryCount++;
        if (wifiRetryCount >= WIFI_MAX_RETRIES) {
          console.error('[WiFi] Max port retries reached, giving up');
          resolve({ success: false, error: 'All ports in use, unable to start server' });
          return;
        }
        const oldServer = wifiServer;
        wifiServer = null;
        wifiPort++;
        oldServer.close();
        resolve(startWifiServer());
      } else {
        resolve({ success: false, error: err.message });
      }
    });
  });
}

function stopWifiServer() {
  if (!wifiActive || !wifiServer) return { success: true };
  if (wifiCleanupTimer) {
    clearInterval(wifiCleanupTimer);
    wifiCleanupTimer = null;
  }
  wifiToken = '';
  // Restore the saved port (or default to 8080) for the next session
  try {
    const saved = loadSettings();
    wifiPort = (saved.wifiPort && Number.isInteger(saved.wifiPort) && saved.wifiPort >= 1024 && saved.wifiPort <= 65535) ? saved.wifiPort : 8080;
  } catch (e) {
    wifiPort = 8080;
  }
  return new Promise((resolve) => {
    wifiServer.close(() => {
      wifiActive = false;
      wifiServer = null;
      wifiRateLimitMap.clear(); // Reset rate limits on stop
      console.log('[WiFi] Server stopped');
      resolve({ success: true });
    });
  });
}

// Expose IPC handlers for Wi-Fi Transfer
ipcMain.handle('start-wifi-server', async () => {
  if (!wifiSharedDir) {
    wifiSharedDir = defaultSharedDir;
  }
  return await startWifiServer();
});

ipcMain.handle('set-wifi-shared-dir', (_event, dirPath) => {
  if (!dirPath || typeof dirPath !== 'string') {
    return { success: false, error: 'Directory path must be a valid string' };
  }

  // Resolve to canonical absolute path
  const resolved = path.resolve(dirPath);

  // Prevent system root or critical OS paths
  const blockedPaths = ['/', '/System', '/bin', '/sbin', '/usr', '/etc', '/var', '/private'];
  if (blockedPaths.includes(resolved)) {
    return { success: false, error: 'System root directories cannot be set as the shared folder' };
  }

  // Restrict to user home directory or mounted volumes
  const homeDir = os.homedir();
  if (!resolved.startsWith(homeDir) && !resolved.startsWith('/Volumes')) {
    return { success: false, error: 'Shared directory must be inside user home directory or external volume' };
  }

  // Ensure directory exists & store canonical realpath
  try {
    fs.mkdirSync(resolved, { recursive: true });
    wifiSharedDir = fs.realpathSync(resolved);
    return { success: true, sharedDir: wifiSharedDir };
  } catch (err) {
    console.error('[WiFi] Shared dir creation/validation failed:', err.message);
    return { success: false, error: err.message };
  }
});

ipcMain.handle('stop-wifi-server', async () => {
  return await stopWifiServer();
});

ipcMain.handle('get-wifi-status', () => {
  return {
    active: wifiActive,
    ip: getLocalIpAddress(),
    port: wifiPort,
    qrCode: wifiQrDataUrl,
    sharedDir: wifiSharedDir
  };
});

ipcMain.handle('open-wifi-shared-dir', () => {
  if (fs.existsSync(wifiSharedDir)) {
    shell.openPath(wifiSharedDir);
  }
});

ipcMain.handle('open-file-path', (_event, filePath) => {
  if (!filePath || !fs.existsSync(filePath)) return false;
  const resolvedPath = path.resolve(filePath);
  if (isPathAllowed(resolvedPath)) {
    shell.openPath(resolvedPath);
    return true;
  }
  console.warn(`[IPC] open-file-path denied: ${resolvedPath}`);
  return false;
});

ipcMain.handle('get-file-thumbnail', async (_event, fileName) => {
  if (!fileName || !wifiSharedDir) return null;
  try {
    const filePath = path.resolve(wifiSharedDir, fileName);
    if (!isWifiPathAllowed(filePath)) {
      console.warn(`[WiFi] Thumbnail denied: ${filePath}`);
      return null;
    }
    if (!fs.existsSync(filePath)) return null;
    
    const stat = fs.statSync(filePath);
    if (!stat || stat.size === 0) return null;

    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'];
    const videoExts = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', '3gp'];

    // 1. For images, return direct Base64 Data URL (100% reliable)
    if (imageExts.includes(ext)) {
      try {
        const mimeType = ext === 'png' ? 'image/png' : (ext === 'svg' ? 'image/svg+xml' : (ext === 'gif' ? 'image/gif' : 'image/jpeg'));
        const imgData = fs.readFileSync(filePath);
        return `data:${mimeType};base64,${imgData.toString('base64')}`;
      } catch (e) {}
    }

    // 2. For videos, extract video frame via qlmanage or ffmpeg
    if (videoExts.includes(ext)) {
      const tmpDir = os.tmpdir();
      const possibleThumbPaths = [
        path.join(tmpDir, `${fileName}.png`),
        path.join(tmpDir, `${path.basename(filePath)}.png`),
      ];

      // Try qlmanage first
      try {
        await new Promise((resolve) => {
          execFile('qlmanage', ['-t', '-s', '256', '-o', tmpDir, filePath], { timeout: 4000 }, resolve);
        });

        for (const tp of possibleThumbPaths) {
          if (fs.existsSync(tp)) {
            const imgData = fs.readFileSync(tp);
            try { fs.unlinkSync(tp); } catch(e) {}
            return `data:image/png;base64,${imgData.toString('base64')}`;
          }
        }
      } catch (err) {}

      // Try ffmpeg fallback
      try {
        const ffmpegPath = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : (fs.existsSync('/usr/local/bin/ffmpeg') ? '/usr/local/bin/ffmpeg' : 'ffmpeg');
        const outThumb = possibleThumbPaths[0];
        await new Promise((resolve) => {
          execFile(ffmpegPath, ['-ss', '00:00:00.5', '-i', filePath, '-vframes', '1', '-s', '256x256', outThumb, '-y'], { timeout: 4000 }, resolve);
        });

        if (fs.existsSync(outThumb)) {
          const imgData = fs.readFileSync(outThumb);
          try { fs.unlinkSync(outThumb); } catch(e) {}
          return `data:image/png;base64,${imgData.toString('base64')}`;
        }
      } catch (err) {}
    }

    // 3. Native macOS thumbnail generator fallback
    if (nativeImage && nativeImage.createThumbnailFromPath) {
      const image = await nativeImage.createThumbnailFromPath(filePath, { width: 128, height: 128 });
      if (image && !image.isEmpty()) {
        return image.toDataURL();
      }
    }
  } catch (err) {
    console.error('[WiFi] Safe thumbnail error:', err.message || err);
  }
  return null;
});

ipcMain.handle('get-file-data-url', async (_event, fileName) => {
  if (!fileName || !wifiSharedDir) return null;
  try {
    const filePath = path.resolve(wifiSharedDir, fileName);
    if (!isWifiPathAllowed(filePath)) {
      console.warn(`[WiFi] Data URL denied: ${filePath}`);
      return null;
    }
    if (!fs.existsSync(filePath)) return null;

    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const mimeTypes = {
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml'
    };

    const mime = mimeTypes[ext];
    if (mime && nativeImage) {
      const image = nativeImage.createFromPath(filePath);
      if (image && !image.isEmpty()) {
        return image.toDataURL();
      }
    }
  } catch (err) {
    console.error('[WiFi] Data URL error:', err.message || err);
  }
  return null;
});

// ─── Local File Thumbnail IPC ───────────────────────────────────────────────
ipcMain.handle('get-local-thumbnail', async (_event, filePath) => {
  if (!filePath) return null;
  try {
    const resolvedPath = path.resolve(filePath);
    if (!isPathAllowed(resolvedPath) || !fs.existsSync(resolvedPath)) return null;

    // 1. Try macOS native QuickLook thumbnail API (instant C++ thread rendering)
    if (nativeImage && nativeImage.createThumbnailFromPath) {
      try {
        const image = await nativeImage.createThumbnailFromPath(resolvedPath, { width: 96, height: 96 });
        if (image && !image.isEmpty()) {
          return image.toDataURL();
        }
      } catch (e) {}
    }

    // 2. Fallback for small images (< 2MB only)
    const stat = fs.statSync(resolvedPath);
    if (stat && !stat.isDirectory() && stat.size > 0 && stat.size < 2 * 1024 * 1024) {
      const ext = path.extname(resolvedPath).toLowerCase().replace('.', '');
      const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'];
      if (imageExts.includes(ext)) {
        try {
          const mime = ext === 'png' ? 'image/png' : (ext === 'svg' ? 'image/svg+xml' : (ext === 'gif' ? 'image/gif' : 'image/jpeg'));
          const imgData = fs.readFileSync(resolvedPath);
          return `data:${mime};base64,${imgData.toString('base64')}`;
        } catch (e) {}
      }
    }
  } catch (err) {
    console.error('[Thumbnail] Local error:', err.message || err);
  }
  return null;
});

// ─── Remote Android File Thumbnail IPC ──────────────────────────────────────
ipcMain.handle('get-remote-thumbnail', async (_event, { deviceId, remotePath }) => {
  if (!deviceId || !remotePath) return null;
  try {
    const ext = path.extname(remotePath).toLowerCase().replace('.', '');
    const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'];
    const videoExts = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', '3gp'];

    if (!imageExts.includes(ext) && !videoExts.includes(ext)) return null;

    const adbPath = await findAdb();
    if (!adbPath) return null;

    if (imageExts.includes(ext)) {
      const buffer = await new Promise((resolve) => {
        const proc = spawn(adbPath, ['-s', deviceId, 'exec-out', 'cat', escapeShellArg(remotePath)]);
        const chunks = [];
        let totalLen = 0;
        proc.stdout.on('data', (chunk) => {
          chunks.push(chunk);
          totalLen += chunk.length;
        });
        proc.on('close', (code) => {
          if (code === 0 && totalLen > 0) resolve(Buffer.concat(chunks, totalLen));
          else resolve(null);
        });
        proc.on('error', () => resolve(null));
      });

      if (buffer && buffer.length > 0) {
        const mime = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : (ext === 'gif' ? 'image/gif' : 'image/jpeg'));
        return `data:${mime};base64,${buffer.toString('base64')}`;
      }
    }

    if (videoExts.includes(ext)) {
      const tmpDir = path.join(os.tmpdir(), 'droidbridge-thumbs');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });

      const safeBaseName = path.basename(remotePath).replace(/[^a-zA-Z0-9._-]/g, '_');
      const randomSuffix = crypto.randomBytes(16).toString('hex');
      const localTmpFile = path.join(tmpDir, `remotethumb-${randomSuffix}-${safeBaseName}`);

      await runAdb(['-s', deviceId, 'pull', remotePath, localTmpFile]);
      if (fs.existsSync(localTmpFile)) {
        const tmpThumb = path.join(tmpDir, `frame-${randomSuffix}.png`);
        const ffmpegPath = fs.existsSync('/opt/homebrew/bin/ffmpeg') ? '/opt/homebrew/bin/ffmpeg' : (fs.existsSync('/usr/local/bin/ffmpeg') ? '/usr/local/bin/ffmpeg' : 'ffmpeg');
        
        await new Promise((resolve) => {
          execFile(ffmpegPath, ['-ss', '00:00:00.5', '-i', localTmpFile, '-vframes', '1', '-s', '128x128', tmpThumb, '-y'], { timeout: 4000 }, resolve);
        });

        try { fs.unlinkSync(localTmpFile); } catch(e) {}

        if (fs.existsSync(tmpThumb)) {
          const imgData = fs.readFileSync(tmpThumb);
          try { fs.unlinkSync(tmpThumb); } catch(e) {}
          return `data:image/png;base64,${imgData.toString('base64')}`;
        }
      }
    }
  } catch (err) {
    console.error('[Thumbnail] Remote error:', err.message || err);
  }
  return null;
});

// ─── Fetch Remote File for Preview IPC ──────────────────────────────────────
ipcMain.handle('fetch-remote-preview', async (_event, { deviceId, remotePath }) => {
  if (!deviceId || !remotePath) return null;
  try {
    const tmpDir = path.join(os.tmpdir(), 'droidbridge-previews');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });

    const safeName = path.basename(remotePath).replace(/[^a-zA-Z0-9._-]/g, '_');
    const randomSuffix = crypto.randomBytes(16).toString('hex');
    const localPreviewPath = path.join(tmpDir, `preview-${randomSuffix}-${safeName}`);

    await runAdb(['-s', deviceId, 'pull', remotePath, localPreviewPath]);
    if (fs.existsSync(localPreviewPath)) {
      return localPreviewPath;
    }
  } catch (err) {
    console.error('[Preview] Remote fetch error:', err.message || err);
  }
  return null;
});

// ─── Custom Application Menu ─────────────────────────────────────────────────

function setAppMenu() {
  const template = [
    {
      label: 'DroidBridge',
      submenu: [
        {
          label: 'About DroidBridge',
          click: () => {
            if (win) win.webContents.send('show-about');
          }
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { role: 'close' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' },
        { type: 'separator' },
        { role: 'window' }
      ]
    },
    {
      role: 'help',
      submenu: [
        {
          label: 'About DroidBridge',
          click: () => {
            if (win) win.webContents.send('show-about');
          }
        }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

// ─── App Lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  // Set Dock Icon for macOS during development/production
  const iconPath = path.join(__dirname, 'icon.png');
  if (process.platform === 'darwin' && fs.existsSync(iconPath)) {
    try {
      const image = nativeImage.createFromPath(iconPath);
      app.dock.setIcon(image);
    } catch (e) {
      console.error('Failed to set dock icon:', e);
    }
  }

  createWindow();
  setAppMenu();
  startDeviceDetection();

  // Gracefully stop Wi-Fi server on app quit
  app.on('before-quit', async () => {
    if (wifiActive) {
      await stopWifiServer();
    }
    if (devicePollInterval) {
      clearInterval(devicePollInterval);
      devicePollInterval = null;
    }
  });

  console.log('[Main] DroidBridge ready');
});

// Quit when all windows are closed (single-window app — quit on macOS too)
app.on('window-all-closed', () => {
  if (devicePollInterval) clearInterval(devicePollInterval);
  app.quit();
});

// macOS: re-create window when dock icon is clicked and no windows exist
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
