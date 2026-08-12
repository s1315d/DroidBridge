// ─────────────────────────────────────────────────────────────────────────────
// DroidBridge — ADB Helper Module
// Locates the adb binary, executes commands, and parses output.
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');

let cachedAdbPath = undefined;

/**
 * Locate the adb binary on the system. Caches the result.
 * @returns {Promise<string|null>}
 */
async function findAdb() {
  if (cachedAdbPath !== undefined) return cachedAdbPath;

  const commonPaths = [
    '/usr/local/bin/adb',
    '/opt/homebrew/bin/adb',
    `${os.homedir()}/Library/Android/sdk/platform-tools/adb`,
  ];

  for (const candidate of commonPaths) {
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      cachedAdbPath = candidate;
      return cachedAdbPath;
    } catch {}
  }

  try {
    const result = await new Promise((resolve, reject) => {
      execFile('/usr/bin/which', ['adb'], (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.trim());
      });
    });
    if (result) {
      cachedAdbPath = result;
      return cachedAdbPath;
    }
  } catch {}

  cachedAdbPath = null;
  return null;
}

/**
 * Escape an argument for safe execution in Android shell via adb shell.
 */
function escapeShellArg(arg) {
  if (typeof arg !== 'string') return '';
  return `'` + arg.replace(/'/g, "'\\''") + `'`;
}

/**
 * Execute an adb command safely with execFile (no shell injection).
 * @returns {Promise<{stdout: string, stderr: string}>}
 */
async function runAdb(args) {
  const adbPath = await findAdb();
  if (!adbPath) throw new Error('ADB binary not found');

  return new Promise((resolve, reject) => {
    execFile(adbPath, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
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
 */
function parseAdbLsOutput(output) {
  const entries = [];
  const lines = output.split('\n');

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('total ')) continue;
    if (!/^[dlcbps-]/.test(line)) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 7) continue;

    const permissions = parts[0];
    const size = parseInt(parts[4], 10) || 0;
    const dateStr = parts[5];
    const timeStr = parts[6];
    const modified = `${dateStr} ${timeStr}`;
    let name = parts.slice(7).join(' ');

    if (name === '.' || name === '..') continue;

    let isDirectory = permissions.startsWith('d');
    let isSymlink = permissions.startsWith('l');

    if (name.includes(' -> ')) {
      isSymlink = true;
      const linkParts = name.split(' -> ');
      name = linkParts[0];
      const target = linkParts[1] || '';
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

/**
 * Get the parent directory of a remote path.
 */
function getRemoteParent(remotePath) {
  const parts = remotePath.replace(/\/+$/, '').split('/');
  parts.pop();
  return parts.join('/') || '/';
}

/**
 * Get the relative path from a parent to a file.
 */
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

/**
 * Check if a remote file exists.
 */
async function remoteFileExists(deviceId, remotePath) {
  try {
    await runAdb(['-s', deviceId, 'shell', 'test', '-e', escapeShellArg(remotePath)]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recursively list files on the device using `find`.
 */
async function getRemoteFilesRecursive(deviceId, remotePath) {
  try {
    const { stdout } = await runAdb(['-s', deviceId, 'shell', 'find', escapeShellArg(remotePath), '-type', 'f']);
    return stdout.split('\n').map(line => line.trim()).filter(Boolean);
  } catch (err) {
    return [remotePath];
  }
}

module.exports = {
  findAdb,
  escapeShellArg,
  runAdb,
  parseAdbLsOutput,
  getRemoteParent,
  getRemoteRelative,
  remoteFileExists,
  getRemoteFilesRecursive,
};
