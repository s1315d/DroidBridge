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
let cachedAdbPath = undefined;       // undefined = not yet searched, null = not found
let knownDeviceIds = new Set();      // Track connected devices for change detection
let devicePollInterval = null;

// ─── Allowed directories for local file browsing ────────────────────────────
const ALLOWED_LOCAL_DIRS = [
  os.homedir(),
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Documents'),
  path.join(os.homedir(), 'Downloads'),
  '/',
];

/**
 * Check if a resolved path is within allowed directories.
 * @param {string} resolvedPath  An already-resolved absolute path
 * @returns {boolean}
 */
function isPathAllowed(resolvedPath) {
  // Always allow temp dir (for cleanupDir)
  const tmpDir = os.tmpdir();
  if (resolvedPath.startsWith(path.resolve(tmpDir))) return true;
  // Check allowed local dirs
  for (const dir of ALLOWED_LOCAL_DIRS) {
    if (resolvedPath.startsWith(dir)) return true;
  }
  return false;
}

// ─── ADB Helper Functions ────────────────────────────────────────────────────

/**
 * Locate the adb binary on the system.
 * Searches common macOS paths then falls back to `which adb`.
 * Caches the result so subsequent calls are instant.
 * @returns {Promise<string|null>} Resolved path or null
 */
async function findAdb() {
  // Return cached result if we've already searched
  if (cachedAdbPath !== undefined) return cachedAdbPath;

  const commonPaths = [
    '/usr/local/bin/adb',
    '/opt/homebrew/bin/adb',
    `${os.homedir()}/Library/Android/sdk/platform-tools/adb`,
  ];

  // Check well-known locations first
  for (const candidate of commonPaths) {
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      console.log(`[ADB] Found at: ${candidate}`);
      cachedAdbPath = candidate;
      return cachedAdbPath;
    } catch {
      // Not found at this path, continue
    }
  }

  // Fall back to `which adb`
  try {
    const result = await new Promise((resolve, reject) => {
      execFile('/usr/bin/which', ['adb'], (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.trim());
      });
    });
    if (result) {
      console.log(`[ADB] Found via which: ${result}`);
      cachedAdbPath = result;
      return cachedAdbPath;
    }
  } catch {
    // which failed — adb is not on PATH
  }

  console.warn('[ADB] Not found on this system');
  cachedAdbPath = null;
  return null;
}

/**
 * Escape an argument for safe execution in Android shell via adb shell.
 * Wraps argument in single quotes and escapes existing single quotes.
 */
function escapeShellArg(arg) {
  if (typeof arg !== 'string') return '';
  return `'` + arg.replace(/'/g, "'\\''") + `'`;
}

/**
 * Execute an adb command safely with execFile (no shell injection).
 * @param {string[]} args  Arguments to pass to adb
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
async function runAdb(args) {
  const adbPath = await findAdb();
  if (!adbPath) throw new Error('ADB binary not found');

  return new Promise((resolve, reject) => {
    execFile(adbPath, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        // Attach stdout/stderr so callers can still inspect partial output
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolve({ stdout, stderr });
    });
  });
}

/**
 * Parse the output of `adb shell ls -la` into structured file entries.
 * Expected line format:
 *   drwxrwx--x  3 root sdcard_rw  4096 2026-01-15 10:30 Documents
 *
 * @param {string} output  Raw ls -la output
 * @returns {Array<{name:string, isDirectory:boolean, isSymlink:boolean,
 *                   size:number, modified:string, permissions:string}>}
 */
function parseAdbLsOutput(output) {
  const entries = [];
  const lines = output.split('\n');

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    // Skip the "total" summary line
    if (line.startsWith('total ')) continue;

    // Permissions field always starts with d, l, -, c, b, p, s
    if (!/^[dlcbps-]/.test(line)) continue;

    // Split into at most 9 columns — the 9th is the filename (may contain spaces)
    //  0: permissions  1: links  2: owner  3: group
    //  4: size  5: date  6: time  7+: name
    const parts = line.split(/\s+/);
    if (parts.length < 7) continue;

    const permissions = parts[0];
    const size = parseInt(parts[4], 10) || 0;
    const dateStr = parts[5];
    const timeStr = parts[6];
    const modified = `${dateStr} ${timeStr}`;

    // Everything after the 7th column is the file name (handles spaces)
    let name = parts.slice(7).join(' ');

    // Skip . and .. entries
    if (name === '.' || name === '..') continue;

    let isDirectory = permissions.startsWith('d');
    let isSymlink = permissions.startsWith('l');

    // Symlinks show as  "name -> target" — strip the target
    if (name.includes(' -> ')) {
      isSymlink = true;
      const parts = name.split(' -> ');
      name = parts[0];
      const target = parts[1] || '';
      // If symlink target ends with slash or has no extension, treat as directory
      if (target.endsWith('/') || !path.extname(name)) {
        isDirectory = true;
      }
    } else if (isSymlink && !path.extname(name)) {
      isDirectory = true;
    }

    entries.push({ name, isDirectory, isSymlink, size, modified, permissions });
  }

  return entries;
}

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

function getLocalFilesRecursive(baseDir, currentDir) {
  let results = [];
  try {
    const list = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of list) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        results = results.concat(getLocalFilesRecursive(baseDir, fullPath));
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

async function getRemoteFilesRecursive(deviceId, remotePath) {
  try {
    const { stdout } = await runAdb(['-s', deviceId, 'shell', 'find', escapeShellArg(remotePath), '-type', 'f']);
    return stdout.split('\n').map(line => line.trim()).filter(Boolean);
  } catch (err) {
    console.error(`[RemoteRecursive] find failed for ${remotePath}:`, err.message);
    // If find fails, treat it as a single file
    return [remotePath];
  }
}

function getRemoteParent(remotePath) {
  const parts = remotePath.replace(/\/+$/, '').split('/');
  parts.pop();
  return parts.join('/') || '/';
}

function getRemoteRelative(parentPath, filePath) {
  if (parentPath === '/') {
    return filePath.startsWith('/') ? filePath.slice(1) : filePath;
  }
  if (filePath.startsWith(parentPath)) {
    let rel = filePath.slice(parentPath.length);
    if (rel.startsWith('/')) rel = rel.slice(1);
    return rel;
  }
  return path.basename(filePath);
}

async function remoteFileExists(deviceId, remotePath) {
  try {
    await runAdb(['-s', deviceId, 'shell', 'test', '-e', escapeShellArg(remotePath)]);
    return true;
  } catch {
    return false;
  }
}

function runAdbWithProgress(adbPath, args, onProgressLine) {
  return new Promise((resolve, reject) => {
    const execPath = adbPath || 'adb';
    console.log(`[Spawn] ${execPath} ${args.join(' ')}`);
    
    const proc = spawn(execPath, args);
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
      reject(err);
    });
  });
}

// 7. Push files from Mac → Android (with folder expansion, conflict resolution, and real-time progress)
ipcMain.handle('push-files', async (_event, { deviceId, localPaths, remotePath }) => {
  const adbPath = await findAdb();
  
  // 1. Expand all localPaths into a flat list of files with relative paths
  const filesToTransfer = [];
  for (const p of localPaths) {
    try {
      const stat = fs.statSync(p);
      if (stat.isDirectory()) {
        const parentDir = path.dirname(p);
        const dirFiles = getLocalFilesRecursive(parentDir, p);
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

      // Run adb push with progress parsing
      await runAdbWithProgress(adbPath, ['-s', deviceId, 'push', '-p', file.fullPath, remoteDest], (line) => {
        const match = line.match(/(\d+)%/);
        if (match && win) {
          const currentFilePercent = parseInt(match[1], 10);
          const basePercent = (i / total) * 100;
          const fileContribution = (1 / total) * currentFilePercent;
          const overallPercent = Math.round(basePercent + fileContribution);
          
          win.webContents.send('transfer-progress', {
            current: i + 1,
            total,
            fileName,
            percent: Math.min(overallPercent, 99), // cap at 99% until file actually succeeds
          });
        }
      });

      transferred++;
    } catch (err) {
      failed++;
      errors.push({ file: fileName, error: err.message });
      console.error(`[Push] Failed ${fileName}:`, err.message);
    }
  }

  // Final 100% update
  if (win && total > 0) {
    win.webContents.send('transfer-progress', {
      current: total,
      total,
      fileName: 'Completed',
      percent: 100,
    });
  }

  return { success: failed === 0, transferred, failed, errors };
});

// 8. Pull files from Android → Mac (with folder expansion, conflict resolution, and real-time progress)
ipcMain.handle('pull-files', async (_event, { deviceId, remotePaths, localPath }) => {
  const adbPath = await findAdb();

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

      // Run adb pull with progress parsing
      await runAdbWithProgress(adbPath, ['-s', deviceId, 'pull', '-p', file.fullPath, localDest], (line) => {
        const match = line.match(/(\d+)%/);
        if (match && win) {
          const currentFilePercent = parseInt(match[1], 10);
          const basePercent = (i / total) * 100;
          const fileContribution = (1 / total) * currentFilePercent;
          const overallPercent = Math.round(basePercent + fileContribution);
          
          win.webContents.send('transfer-progress', {
            current: i + 1,
            total,
            fileName,
            percent: Math.min(overallPercent, 99), // cap at 99% until file actually succeeds
          });
        }
      });

      transferred++;
    } catch (err) {
      failed++;
      errors.push({ file: fileName, error: err.message });
      console.error(`[Pull] Failed ${fileName}:`, err.message);
    }
  }

  // Final 100% update
  if (win && total > 0) {
    win.webContents.send('transfer-progress', {
      current: total,
      total,
      fileName: 'Completed',
      percent: 100,
    });
  }

  return { success: failed === 0, transferred, failed, errors };
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
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
  const tempPath = path.join(os.tmpdir(), `droidbridge-temp-${Date.now()}`);
  fs.mkdirSync(tempPath, { recursive: true });
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

/**
 * Check if a path is within the allowed Wi-Fi shared directory (resolves symlinks).
 */
function isWifiPathAllowed(targetPath) {
  try {
    const resolvedTarget = path.resolve(targetPath);
    // Find the closest existing parent directory in the path ancestry to check realpath
    let dir = resolvedTarget;
    while (dir && dir !== '/' && !fs.existsSync(dir)) {
      dir = path.dirname(dir);
    }
    const resolvedTargetReal = fs.realpathSync(dir);
    const resolvedShare = fs.realpathSync(wifiSharedDir);
    return resolvedTargetReal.startsWith(resolvedShare);
  } catch {
    return false;
  }
}

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
function getMobileHtml(nonce = '') {
  const currentFolderName = path.basename(wifiSharedDir) || 'Shared';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <title>DroidBridge WiFi Share</title>
  <style nonce="${nonce}">
    :root {
      --bg: #0a0a0f;
      --card: #12121a;
      --border: rgba(255, 255, 255, 0.06);
      --primary: #6c5ce7;
      --primary-glow: rgba(108, 92, 231, 0.3);
      --text: #e8e8f0;
      --text-muted: #8888a0;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      padding: 20px;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .header {
      text-align: center;
      margin-bottom: 24px;
      margin-top: 10px;
    }
    .logo {
      font-size: 32px;
      margin-bottom: 8px;
    }
    h1 {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: 0.5px;
    }
    .subtitle {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
    }
    .card {
      width: 100%;
      max-width: 450px;
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 20px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    }
    .upload-zone {
      border: 2px dashed var(--border);
      border-radius: 12px;
      padding: 32px 16px;
      text-align: center;
      cursor: pointer;
      display: block;
      transition: all 0.2s ease;
      position: relative;
    }
    .upload-zone:active, .upload-zone.dragover {
      border-color: var(--primary);
      background: rgba(108, 92, 231, 0.05);
      box-shadow: 0 0 15px var(--primary-glow);
    }
    .upload-icon {
      font-size: 40px;
      margin-bottom: 12px;
    }
    .upload-text {
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 6px;
    }
    .upload-sub {
      font-size: 11px;
      color: var(--text-muted);
    }
    #file-input {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      opacity: 0.001;
      z-index: 10;
      cursor: pointer;
      display: block;
    }
    .progress-container {
      margin-top: 16px;
      display: none;
    }
    .progress-info {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      margin-bottom: 6px;
      color: var(--text-muted);
    }
    .progress-bar {
      height: 6px;
      background: rgba(255, 255, 255, 0.06);
      border-radius: 3px;
      overflow: hidden;
    }
    .progress-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, var(--primary), #a29bfe);
      border-radius: 3px;
      transition: width 0.1s ease;
    }
    .section-title {
      font-size: 14px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.8px;
      color: var(--text-muted);
      margin-bottom: 12px;
    }
    .browser-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 16px;
      padding-bottom: 12px;
      border-bottom: 1px solid var(--border);
    }
    .back-btn {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      color: var(--text);
      font-size: 11px;
      font-weight: 600;
      padding: 6px 10px;
      border-radius: 6px;
      cursor: pointer;
    }
    .back-btn:active {
      background: var(--primary);
      border-color: var(--primary);
    }
    .current-path {
      font-size: 12px;
      font-family: monospace;
      color: var(--text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .file-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .file-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid var(--border);
      border-radius: 8px;
      transition: all 0.2s ease;
    }
    .file-item:active {
      background: rgba(255, 255, 255, 0.04);
    }
    .file-left-group {
      display: flex;
      align-items: center;
      overflow: hidden;
      margin-right: 12px;
    }
    .file-thumb {
      width: 44px;
      height: 44px;
      border-radius: 8px;
      object-fit: cover;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.05);
      flex-shrink: 0;
      margin-right: 12px;
    }
    .file-icon-badge {
      width: 44px;
      height: 44px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      flex-shrink: 0;
      margin-right: 12px;
    }
    .file-details {
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .file-name {
      font-size: 13px;
      font-weight: 500;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .file-size {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .action-group {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-shrink: 0;
    }
    .preview-btn {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      color: var(--text);
      border-radius: 6px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .preview-btn:active {
      background: rgba(255, 255, 255, 0.15);
    }
    .download-btn, .open-btn {
      background: rgba(108, 92, 231, 0.1);
      border: 1px solid rgba(108, 92, 231, 0.2);
      color: var(--primary-light);
      border-radius: 6px;
      padding: 6px 12px;
      cursor: pointer;
      font-size: 11px;
      font-weight: 600;
      text-decoration: none;
      transition: all 0.2s ease;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .download-btn:active, .open-btn:active {
      background: var(--primary);
      color: white;
    }
    .empty-state {
      text-align: center;
      padding: 20px;
      color: var(--text-muted);
      font-size: 12px;
    }
    .footer {
      font-size: 10px;
      color: var(--text-muted);
      margin-top: auto;
      padding-top: 20px;
      text-align: center;
    }

    /* Modal Preview Overlay */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(10, 10, 15, 0.9);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s ease;
      padding: 16px;
    }
    .hidden { display: none !important; }
    .modal-overlay.active {
      opacity: 1;
      pointer-events: auto;
    }
    .modal-content {
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 16px;
      width: 100%;
      max-width: 600px;
      max-height: 85vh;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 16px 48px rgba(0,0,0,0.5);
    }
    .modal-header {
      padding: 14px 18px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }
    #modal-filename {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 80%;
    }
    .modal-close {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 22px;
      cursor: pointer;
      padding: 0 4px;
      line-height: 1;
    }
    .modal-close:hover {
      color: var(--text);
    }
    .modal-body {
      padding: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: auto;
      min-height: 200px;
      background: #000;
    }
    .modal-body img, .modal-body video {
      max-width: 100%;
      max-height: 65vh;
      object-fit: contain;
      border-radius: 8px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="logo">📶</div>
    <h1>DroidBridge Wi-Fi Share</h1>
    <div class="subtitle">Designed by Shubham Gour</div>
  </div>

  <div class="card">
    <div class="upload-zone" id="drop-zone">
      <div class="upload-icon">📤</div>
      <div class="upload-text">Upload files to Mac</div>
      <div class="upload-sub">Tap here to choose files</div>
      <input type="file" id="file-input" multiple>
    </div>

    <div class="progress-container" id="progress-box">
      <div class="progress-info">
        <span id="progress-file">File Name</span>
        <span id="progress-percent">0%</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" id="progress-fill"></div>
      </div>
    </div>
  </div>

  <div class="card">
    <div class="section-title">Download from Mac</div>
    
    <div class="browser-header">
      <button class="back-btn hidden" id="btn-back">← Back</button>
      <span class="current-path" id="path-display">📁 ${currentFolderName}</span>
    </div>

    <ul class="file-list" id="files-container">
      <li class="empty-state">Loading shared files...</li>
    </ul>
  </div>

  <div class="footer">
    Powered by DroidBridge • Both devices must be on the same Wi-Fi
  </div>

  <!-- Modal Preview Overlay -->
  <div id="preview-modal" class="modal-overlay">
    <div class="modal-content" id="modal-card">
      <div class="modal-header">
        <span id="modal-filename">File Preview</span>
        <button class="modal-close" id="modal-close-btn">&times;</button>
      </div>
      <div class="modal-body" id="modal-body"></div>
    </div>
  </div>

  <script nonce="${nonce}">
    const fileInput = document.getElementById('file-input');
    const progressBox = document.getElementById('progress-box');
    const progressFile = document.getElementById('progress-file');
    const progressPercent = document.getElementById('progress-percent');
    const progressFill = document.getElementById('progress-fill');
    const filesContainer = document.getElementById('files-container');
    const pathDisplay = document.getElementById('path-display');
    const btnBack = document.getElementById('btn-back');

    let currentPath = '';

    function openPreview(fileName, relativePath) {
      const modal = document.getElementById('preview-modal');
      const title = document.getElementById('modal-filename');
      const body = document.getElementById('modal-body');
      
      title.textContent = fileName;
      body.innerHTML = '';
      
      const fileUrl = '/download?file=' + encodeURIComponent(relativePath);
      const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
      const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
      const videoExts = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', '3gp'];

      if (imageExts.includes(ext)) {
        const img = document.createElement('img');
        img.src = fileUrl + '&inline=1';
        body.appendChild(img);
      } else if (videoExts.includes(ext)) {
        const video = document.createElement('video');
        video.src = fileUrl + '&inline=1';
        video.controls = true;
        video.autoplay = true;
        video.playsInline = true;
        body.appendChild(video);
      } else if (ext === 'pdf' || ext === 'txt' || ext === 'html' || ext === 'json') {
        window.open(fileUrl + '&inline=1', '_blank');
        return;
      } else {
        window.open(fileUrl + '&dl=1', '_blank');
        return;
      }
      
      modal.classList.add('active');
    }

    function closePreviewModal(e) {
      if (e && e.stopPropagation) e.stopPropagation();
      const modal = document.getElementById('preview-modal');
      const body = document.getElementById('modal-body');
      if (body) {
        const mediaElements = body.querySelectorAll('video, audio');
        mediaElements.forEach(m => {
          try {
            m.pause();
            m.src = '';
            m.load();
          } catch(err) {}
        });
        body.innerHTML = '';
      }
      if (modal) modal.classList.remove('active');
    }

    function getFilePreviewElement(fileName, relativePath, isDirectory) {
      if (isDirectory) {
        const div = document.createElement('div');
        div.className = 'file-icon-badge';
        div.textContent = '📁';
        return div;
      }
      
      const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
      const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
      const videoExts = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', '3gp'];
      const fileUrl = '/download?file=' + encodeURIComponent(relativePath);
      
      if (imageExts.includes(ext)) {
        const img = document.createElement('img');
        img.className = 'file-thumb';
        img.loading = 'lazy';
        img.alt = 'preview';
        img.src = fileUrl;
        img.onerror = function() {
          const badge = document.createElement('div');
          badge.className = 'file-icon-badge';
          badge.textContent = '🖼️';
          img.replaceWith(badge);
        };
        return img;
      }

      if (videoExts.includes(ext)) {
        const video = document.createElement('video');
        video.className = 'file-thumb';
        video.preload = 'metadata';
        video.muted = true;
        video.playsInline = true;
        video.src = fileUrl + '#t=0.5';
        video.onerror = function() {
          const badge = document.createElement('div');
          badge.className = 'file-icon-badge';
          badge.textContent = '🎬';
          video.replaceWith(badge);
        };
        return video;
      }

      const iconMap = {
        mp3: '🎵', wav: '🎵', flac: '🎵', m4a: '🎵', ogg: '🎵',
        pdf: '📕', doc: '📘', docx: '📘', txt: '📝', json: '💻',
        zip: '📦', rar: '📦', '7z': '📦', tar: '📦', gz: '📦',
        apk: '📲', dmg: '💿'
      };
      
      const badge = document.createElement('div');
      badge.className = 'file-icon-badge';
      badge.textContent = iconMap[ext] || '📄';
      return badge;
    }

    // Load files list
    async function loadFiles() {
      try {
        const res = await fetch('/files?path=' + encodeURIComponent(currentPath));
        const data = await res.json();
        const files = Array.isArray(data) ? data : (data.files || []);
        const rootFolderName = (data && data.folderName) ? data.folderName : 'Shared';
        
        // Update breadcrumb UI
        pathDisplay.textContent = currentPath ? '📁 ' + rootFolderName + ' / ' + currentPath : '📁 ' + rootFolderName;
        btnBack.classList.toggle('hidden', !currentPath);

        filesContainer.innerHTML = '';
        if (files.length === 0) {
          filesContainer.innerHTML = '<li class="empty-state">No items in this folder</li>';
          return;
        }
        
        files.forEach(f => {
          const item = document.createElement('li');
          item.className = 'file-item';
          
          const relativeFilePath = currentPath ? currentPath + '/' + f.name : f.name;
          const previewEl = getFilePreviewElement(f.name, relativeFilePath, f.isDirectory);

          const leftGroup = document.createElement('div');
          leftGroup.className = 'file-left-group';
          leftGroup.appendChild(previewEl);

          const details = document.createElement('div');
          details.className = 'file-details';
          
          const nameSpan = document.createElement('span');
          nameSpan.className = 'file-name';
          nameSpan.textContent = f.name;

          const sizeSpan = document.createElement('span');
          sizeSpan.className = 'file-size';
          sizeSpan.textContent = f.isDirectory ? 'Folder' : formatBytes(f.size);

          details.appendChild(nameSpan);
          details.appendChild(sizeSpan);
          leftGroup.appendChild(details);

          item.appendChild(leftGroup);

          const actionGroup = document.createElement('div');
          actionGroup.className = 'action-group';

          if (f.isDirectory) {
            const openBtn = document.createElement('button');
            openBtn.className = 'open-btn';
            openBtn.textContent = 'Open ➔';
            openBtn.onclick = () => navigateInto(f.name);
            actionGroup.appendChild(openBtn);
          } else {
            const ext = f.name.includes('.') ? f.name.split('.').pop().toLowerCase() : '';
            const previewableExts = [
              // Images
              'jpg', 'jpeg', 'png', 'gif', 'webp', 'svg',
              // Videos
              'mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', '3gp',
              // Audio
              'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac',
              // Docs/Text
              'pdf', 'txt', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'json', 'html', 'xml', 'csv'
            ];

            if (previewableExts.includes(ext)) {
              const previewBtn = document.createElement('button');
              previewBtn.className = 'preview-btn';
              previewBtn.textContent = '👁️ Preview';
              previewBtn.onclick = () => openPreview(f.name, relativeFilePath);
              actionGroup.appendChild(previewBtn);
            }

            const dlBtn = document.createElement('a');
            dlBtn.className = 'download-btn';
            dlBtn.href = '/download?file=' + encodeURIComponent(relativeFilePath);
            dlBtn.textContent = '⬇️ Download';
            actionGroup.appendChild(dlBtn);
          }

          item.appendChild(actionGroup);
          filesContainer.appendChild(item);
        });
      } catch (err) {
        filesContainer.innerHTML = '<li class="empty-state">Failed to load files</li>';
      }
    }

    function navigateInto(dirName) {
      currentPath = currentPath ? currentPath + '/' + dirName : dirName;
      loadFiles();
    }

    function navigateBack() {
      const parts = currentPath.split('/');
      parts.pop();
      currentPath = parts.join('/');
      loadFiles();
    }

    // Format bytes
    function formatBytes(bytes) {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    // Upload handlers
    fileInput.addEventListener('change', async (e) => {
      const files = e.target.files;
      if (files.length === 0) return;
      
      progressBox.style.display = 'block';
      
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        progressFile.textContent = file.name;
        progressPercent.textContent = '0%';
        progressFill.style.width = '0%';

        try {
          await uploadFile(file);
        } catch (err) {
          alert('Upload failed: ' + file.name);
        }
      }
      
      progressBox.style.display = 'none';
      fileInput.value = '';
      loadFiles();
    });

    function uploadFile(file) {
      return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        const uploadPath = currentPath ? currentPath + '/' + file.name : file.name;
        xhr.open('POST', '/upload');
        xhr.setRequestHeader('X-File-Name', encodeURIComponent(uploadPath));
        
        xhr.upload.onprogress = (e) => {
          if (e.lengthComputable) {
            const pct = Math.round((e.loaded / e.total) * 100);
            progressPercent.textContent = pct + '%';
            progressFill.style.width = pct + '%';
          }
        };

        xhr.onload = () => {
          if (xhr.status === 200) resolve();
          else reject();
        };
        xhr.onerror = () => reject();
        xhr.send(file);
      });
    }

    // Drop zone highlighting
    const dropZone = document.getElementById('drop-zone');
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      const droppedFiles = e.dataTransfer.files;
      if (droppedFiles.length > 0) {
        progressBox.style.display = 'block';
        for (let i = 0; i < droppedFiles.length; i++) {
          const file = droppedFiles[i];
          progressFile.textContent = file.name;
          progressPercent.textContent = '0%';
          progressFill.style.width = '0%';
          try {
            await uploadFile(file);
          } catch (err) {
            alert('Upload failed: ' + file.name);
          }
        }
        progressBox.style.display = 'none';
        loadFiles();
      }
    });

    // Modal & Back Button Event Listeners
    btnBack.addEventListener('click', navigateBack);
    document.getElementById('modal-close-btn')?.addEventListener('click', closePreviewModal);
    const previewModal = document.getElementById('preview-modal');
    if (previewModal) {
      previewModal.addEventListener('click', (e) => {
        if (e.target === previewModal) closePreviewModal();
      });
    }

    // Boot
    loadFiles();
  </script>
</body>
</html>
`;
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
      sharedDir: wifiSharedDir
    };
  }

  // Ensure shared directory exists
  try {
    fs.mkdirSync(wifiSharedDir, { recursive: true });
  } catch (err) {
    console.error('[WiFi] Shared dir creation failed:', err.message);
  }

  const localIp = getLocalIpAddress();
  const url = `http://${localIp}:${wifiPort}`;

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
          jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
          mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', m4v: 'video/x-m4v', '3gp': 'video/3gpp',
          mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', m4a: 'audio/mp4', ogg: 'audio/ogg',
          pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', html: 'text/html', json: 'application/json'
        };

        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const isInline = reqUrl.searchParams.get('inline') === '1';

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

        // Ensure parent directories exist
        const parentDir = path.dirname(filePath);
        try {
          fs.mkdirSync(parentDir, { recursive: true });
        } catch (err) {
          console.error('[WiFi] Subdir creation failed:', err.message);
        }
        
        const writeStream = fs.createWriteStream(filePath);
        const totalSize = parseInt(req.headers['content-length'] || '0', 10);
        let uploadedSize = 0;

        req.on('data', (chunk) => {
          uploadedSize += chunk.length;
          if (win && totalSize > 0) {
            const percent = Math.round((uploadedSize / totalSize) * 100);
            win.webContents.send('wifi-upload-progress', { fileName, percent });
          }
        });

        req.pipe(writeStream);

        writeStream.on('finish', () => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true }));
          // Notify desktop UI to refresh listing
          if (win) {
            win.webContents.send('wifi-upload-progress', { fileName, percent: 100, completed: true });
          }
        });

        writeStream.on('error', (err) => {
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
      console.log(`[WiFi] Server listening at ${url}`);
      resolve({ success: true, port: wifiPort, ip: localIp, qrCode: wifiQrDataUrl, sharedDir: wifiSharedDir });
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
        const proc = spawn(adbPath, ['-s', deviceId, 'exec-out', 'cat', remotePath]);
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
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

      const safeBaseName = path.basename(remotePath).replace(/[^a-zA-Z0-9._-]/g, '_');
      const localTmpFile = path.join(tmpDir, `remotethumb-${Date.now()}-${safeBaseName}`);

      await runAdb(['-s', deviceId, 'pull', remotePath, localTmpFile]);
      if (fs.existsSync(localTmpFile)) {
        const tmpThumb = path.join(tmpDir, `frame-${Date.now()}.png`);
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
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    const safeName = path.basename(remotePath).replace(/[^a-zA-Z0-9._-]/g, '_');
    const localPreviewPath = path.join(tmpDir, `preview-${Date.now()}-${safeName}`);

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
