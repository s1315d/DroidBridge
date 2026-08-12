// ─────────────────────────────────────────────────────────────────────────────
// DroidBridge — Security & Path Validation Module
// Pure functions for path containment checks and authentication helpers.
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

const ALLOWED_LOCAL_DIRS = [
  '/',
  os.homedir(),
  path.join(os.homedir(), 'Desktop'),
  path.join(os.homedir(), 'Documents'),
  path.join(os.homedir(), 'Downloads'),
  path.join('/', 'Volumes'),
];

/**
 * Check if a resolved path is within allowed directories.
 * @param {string} resolvedPath  An already-resolved absolute path
 * @returns {boolean}
 */
function isPathAllowed(resolvedPath) {
  const tmpDir = path.resolve(os.tmpdir());
  if (resolvedPath === tmpDir || resolvedPath.startsWith(tmpDir + path.sep)) return true;
  for (const dir of ALLOWED_LOCAL_DIRS) {
    const resolvedDir = path.resolve(dir);
    // Root `/` is the filesystem root — every absolute path is under it.
    if (resolvedDir === '/') {
      if (resolvedPath.startsWith('/')) return true;
    } else {
      if (resolvedPath === resolvedDir || resolvedPath.startsWith(resolvedDir + path.sep)) return true;
    }
  }
  return false;
}

/**
 * Check if a path is within the allowed Wi-Fi shared directory (resolves symlinks).
 * @param {string} targetPath  Path to check
 * @param {string} wifiSharedDir  Current shared directory
 * @returns {boolean}
 */
function isWifiPathAllowed(targetPath, wifiSharedDir) {
  try {
    const resolvedTarget = path.resolve(targetPath);
    let dir = resolvedTarget;
    while (dir && dir !== '/' && !fs.existsSync(dir)) {
      dir = path.dirname(dir);
    }
    const resolvedTargetReal = fs.realpathSync(dir);
    const resolvedShare = fs.realpathSync(wifiSharedDir);
    return resolvedTargetReal === resolvedShare || resolvedTargetReal.startsWith(resolvedShare + path.sep);
  } catch {
    return false;
  }
}

/**
 * Parse cookies from a request's cookie header.
 */
function getCookie(req, name) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach((cookie) => {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURIComponent(parts.join('='));
    });
  }
  return list[name];
}

/**
 * Constant-time string comparison to mitigate timing-attack side channels.
 */
function tokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { isPathAllowed, isWifiPathAllowed, getCookie, tokenEquals, ALLOWED_LOCAL_DIRS };
