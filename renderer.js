/**
 * DroidBridge — Renderer (Frontend) Script
 * Mac ↔ Android file transfer app
 *
 * Communicates with the main process exclusively through the
 * `window.droidBridge` API exposed by preload.js (contextBridge).
 * No Node.js APIs are used directly — this runs in a sandboxed renderer.
 */

/* ======================================================================
   STATE
   ====================================================================== */

const state = {
  adbInstalled: false,
  connectedDevice: null,        // Legacy reference (we use devices list now)
  devices: [],                  // Array of connected {id, model, manufacturer, androidVersion, status}
  localSource: 'mac',           // 'mac' or 'deviceId'
  remoteSource: 'mac',          // 'mac' or 'deviceId'
  localPath: '',                 // current Left directory path
  remotePath: '/sdcard',         // current Right directory path
  localFiles: [],                // file objects from Left panel
  remoteFiles: [],               // file objects from Right panel
  localSelected: new Set(),      // Set<fullPath>
  remoteSelected: new Set(),     // Set<fullPath>
  localSearchQuery: '',
  remoteSearchQuery: '',
  isTransferring: false,
  localSortKey: 'name',
  localSortOrder: 'asc',         // 'asc' | 'desc'
  remoteSortKey: 'name',
  remoteSortOrder: 'asc',        // 'asc' | 'desc'
  activePanel: 'local',          // 'local' | 'remote'
  lastClickedLocal: null,        // index for shift-select (cursor)
  lastClickedRemote: null,
  localShiftAnchor: null,        // anchor for shift selection
  remoteShiftAnchor: null,
  comparisonActive: false,
};

/* ======================================================================
   HELPER UTILITIES
   ====================================================================== */

/**
 * Return an emoji icon for the given file based on extension / directory flag.
 */
function getFileIcon(file) {
  if (file.isDirectory) return '📁';
  const ext = (file.extension || file.name.split('.').pop() || '').toLowerCase();
  const icons = {
    // Images
    jpg: '🖼️', jpeg: '🖼️', png: '🖼️', gif: '🖼️', svg: '🖼️', webp: '🖼️', bmp: '🖼️',
    // Videos
    mp4: '🎬', avi: '🎬', mkv: '🎬', mov: '🎬', wmv: '🎬', flv: '🎬',
    // Audio
    mp3: '🎵', wav: '🎵', flac: '🎵', aac: '🎵', ogg: '🎵', m4a: '🎵',
    // Documents
    pdf: '📕', doc: '📘', docx: '📘', txt: '📝', rtf: '📝',
    xls: '📊', xlsx: '📊', csv: '📊',
    ppt: '📙', pptx: '📙',
    // Code
    js: '💻', py: '💻', java: '💻', html: '💻', css: '💻', json: '💻', xml: '💻',
    // Archives
    zip: '📦', rar: '📦', tar: '📦', gz: '📦', '7z': '📦',
    // Apps
    apk: '📲', exe: '⚙️', dmg: '💿', iso: '💿',
  };
  return icons[ext] || '📄';
}

/**
 * Human-readable file size.
 */
function formatFileSize(bytes) {
  if (bytes === 0 || bytes === undefined || bytes === null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

/**
 * Friendly date string.
 */
function formatDate(dateInput) {
  if (!dateInput) return '—';
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return String(dateInput);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * Classic debounce — delays `fn` until `delay` ms after last invocation.
 */
function debounce(fn, delay = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

/**
 * Escape HTML to prevent injection when inserting user-supplied text.
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/* ======================================================================
   TOAST NOTIFICATIONS
   ====================================================================== */

/**
 * Show a small notification toast.
 * @param {string} message
 * @param {'success'|'error'|'info'} type
 */
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icons = { success: '✓', error: '✗', info: 'ℹ' };
  toast.innerHTML = `<span class="toast-icon">${icons[type] || icons.info}</span><span class="toast-msg">${escapeHtml(message)}</span>`;

  // Position styles (in case CSS doesn't cover dynamic toasts)
  Object.assign(toast.style, {
    position: 'fixed',
    bottom: '24px',
    right: '24px',
    padding: '12px 20px',
    borderRadius: '8px',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    color: '#fff',
    fontSize: '13px',
    fontWeight: '500',
    zIndex: '9999',
    opacity: '0',
    transform: 'translateY(12px)',
    transition: 'opacity 0.3s ease, transform 0.3s ease',
    background: type === 'success' ? '#16a34a' : type === 'error' ? '#dc2626' : '#2563eb',
    boxShadow: '0 4px 12px rgba(0,0,0,0.25)',
    maxWidth: '360px',
  });

  document.body.appendChild(toast);

  // Trigger entrance animation
  requestAnimationFrame(() => {
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
  });

  // Auto-dismiss after 3s
  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(12px)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

/* ======================================================================
   OVERLAY / SCREEN HELPERS
   ====================================================================== */

function showScreen(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'flex';
}

function hideScreen(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

function setTransferOverlay(visible) {
  state.isTransferring = visible;
  if (visible) {
    showScreen('transfer-overlay');
    // Reset progress
    const fill = document.querySelector('#transfer-overlay .progress-bar-fill');
    const pct = document.getElementById('progress-percent');
    const fname = document.getElementById('progress-filename');
    if (fill) fill.style.width = '0%';
    if (pct) pct.textContent = '0%';
    if (fname) fname.textContent = '';
  } else {
    hideScreen('transfer-overlay');
  }
}

/* ======================================================================
   DEVICE BAR & CONNECTION BADGE
   ====================================================================== */

function getActiveDisplayDevice() {
  if (state.remoteSource && state.remoteSource !== 'mac') {
    return state.devices.find(d => d.id === state.remoteSource);
  }
  if (state.localSource && state.localSource !== 'mac') {
    return state.devices.find(d => d.id === state.localSource);
  }
  return null;
}

function updateDeviceBar() {
  const activeDev = getActiveDisplayDevice();
  const deviceBar = document.getElementById('device-bar');
  if (!deviceBar) return;

  if (!activeDev) {
    deviceBar.style.display = 'none';
    return;
  }

  deviceBar.style.display = '';
  const modelEl = document.getElementById('device-model');
  const metaEl = document.getElementById('device-meta');

  if (modelEl) modelEl.textContent = activeDev.model || 'Unknown Device';
  if (metaEl) {
    const parts = [activeDev.manufacturer, activeDev.androidVersion ? `Android ${activeDev.androidVersion}` : null].filter(Boolean);
    metaEl.textContent = parts.join(' · ') || '';
  }
}

async function loadStorageInfo() {
  const activeDev = getActiveDisplayDevice();
  const fill = document.getElementById('storage-bar-fill');
  const text = document.getElementById('storage-text');

  if (!activeDev) {
    if (fill) fill.style.width = '0%';
    if (text) text.textContent = '';
    return;
  }

  try {
    const storage = await window.droidBridge.getStorageInfo(activeDev.id);
    if (storage && storage.total > 0) {
      const usedPct = ((storage.used / storage.total) * 100).toFixed(1);
      if (fill) fill.style.width = usedPct + '%';
      if (text) text.textContent = `${formatFileSize(storage.used)} / ${formatFileSize(storage.total)} used`;
    } else {
      if (fill) fill.style.width = '0%';
      if (text) text.textContent = 'Storage info unavailable';
    }
  } catch (err) {
    console.error('Failed to load storage info:', err);
  }
}

/* ======================================================================
   BREADCRUMBS
   ====================================================================== */

function renderLocalBreadcrumb() {
  const container = document.getElementById('local-breadcrumb');
  if (!container) return;
  container.innerHTML = '';
  renderBreadcrumb(container, state.localPath, (path) => loadLocalFiles(path));
}

function renderRemoteBreadcrumb() {
  const container = document.getElementById('remote-breadcrumb');
  if (!container) return;
  container.innerHTML = '';
  renderBreadcrumb(container, state.remotePath, (path) => loadRemoteFiles(path));
}

/**
 * Shared breadcrumb renderer.
 * @param {HTMLElement} container
 * @param {string} fullPath
 * @param {function} navigateFn
 */
function renderBreadcrumb(container, fullPath, navigateFn) {
  // Split path into segments, keeping leading '/' for absolute paths
  const parts = fullPath.split('/').filter((p) => p !== '');
  const isAbsolute = fullPath.startsWith('/');

  // Root item
  const rootItem = document.createElement('span');
  rootItem.className = 'breadcrumb-item';
  rootItem.textContent = isAbsolute ? '/' : parts[0] || '/';
  rootItem.addEventListener('click', () => navigateFn(isAbsolute ? '/' : parts[0]));
  container.appendChild(rootItem);

  const startIdx = isAbsolute ? 0 : 1;
  for (let i = startIdx; i < parts.length; i++) {
    // Separator
    const sep = document.createElement('span');
    sep.className = 'breadcrumb-sep';
    sep.textContent = '›';
    container.appendChild(sep);

    // Segment
    const item = document.createElement('span');
    const segmentPath = (isAbsolute ? '/' : '') + parts.slice(0, i + 1).join('/');
    item.className = 'breadcrumb-item' + (i === parts.length - 1 ? ' active' : '');
    item.textContent = parts[i];
    item.addEventListener('click', () => navigateFn(segmentPath));
    container.appendChild(item);
  }
}

/* ======================================================================
   FILE LIST RENDERING
   ====================================================================== */

/**
 * Build the visible (search-filtered) file list.
 */
/**
 * Build the visible (search-filtered) file list.
 */
function getFilteredFiles(files, query) {
  if (!query) return files;
  const q = query.toLowerCase();
  return files.filter((f) => f.name.toLowerCase().includes(q));
}

/**
 * Sort files: directories first, then by the selected key and order.
 */
function sortFiles(files, key, order) {
  const multiplier = order === 'asc' ? 1 : -1;
  return [...files].sort((a, b) => {
    // Directories always first
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }

    if (key === 'name') {
      return multiplier * a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    }

    if (key === 'size') {
      const sizeA = a.isDirectory ? 0 : (a.size || 0);
      const sizeB = b.isDirectory ? 0 : (b.size || 0);
      return multiplier * (sizeA - sizeB);
    }

    if (key === 'date') {
      const timeA = a.modified ? new Date(a.modified).getTime() : 0;
      const timeB = b.modified ? new Date(b.modified).getTime() : 0;
      return multiplier * (timeA - timeB);
    }

    if (key === 'kind') {
      const kindA = getFileKind(a).toLowerCase();
      const kindB = getFileKind(b).toLowerCase();
      return multiplier * kindA.localeCompare(kindB, undefined, { sensitivity: 'base' });
    }

    return 0;
  });
}

function getFileKind(file) {
  if (file.isDirectory) return 'Folder';
  const ext = (file.extension || file.name.split('.').pop() || '').toUpperCase();
  if (!ext || ext === file.name.toUpperCase()) return 'File';
  return ext + ' File';
}

function renderLocalFiles() {
  const container = document.getElementById('local-file-list');
  if (!container) return;
  const sorted = sortFiles(
    getFilteredFiles(state.localFiles, state.localSearchQuery),
    state.localSortKey,
    state.localSortOrder
  );
  renderFileList(container, sorted, state.localSelected, 'local');
}

function renderRemoteFiles() {
  const container = document.getElementById('remote-file-list');
  if (!container) return;
  const sorted = sortFiles(
    getFilteredFiles(state.remoteFiles, state.remoteSearchQuery),
    state.remoteSortKey,
    state.remoteSortOrder
  );
  renderFileList(container, sorted, state.remoteSelected, 'remote');
}

/**
 * Render a list of files into the given container.
 * @param {HTMLElement} container
 * @param {Array} files
 * @param {Set} selectionSet
 * @param {'local'|'remote'} side
 */
function renderFileList(container, files, selectionSet, side) {
  container.innerHTML = '';

  if (files.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-dir';
    empty.textContent = 'This folder is empty';
    container.appendChild(empty);
    return;
  }

  files.forEach((file, index) => {
    const item = document.createElement('div');
    item.className = 'file-item' + (selectionSet.has(file.fullPath) ? ' selected' : '');
    item.dataset.index = index;
    item.dataset.fullPath = file.fullPath;

    // Icon
    const icon = document.createElement('span');
    icon.className = 'file-icon';
    icon.textContent = getFileIcon(file);

    // Name
    const nameContainer = document.createElement('div');
    nameContainer.className = 'file-name-container';

    const name = document.createElement('span');
    name.className = 'file-name';
    name.textContent = file.name;
    name.title = file.name;
    nameContainer.appendChild(name);

    // Comparison Badge
    if (state.comparisonActive) {
      const otherFiles = side === 'local' ? state.remoteFiles : state.localFiles;
      const match = otherFiles.find((f) => f.name.toLowerCase() === file.name.toLowerCase());
      const compBadge = document.createElement('span');
      compBadge.className = 'comp-badge';

      if (match) {
        if (file.isDirectory && match.isDirectory) {
          compBadge.textContent = 'Match';
          compBadge.classList.add('comp-match');
        } else if (file.isDirectory !== match.isDirectory) {
          compBadge.textContent = 'Type Diff';
          compBadge.classList.add('comp-diff');
        } else {
          if (file.size === match.size) {
            compBadge.textContent = 'Match';
            compBadge.classList.add('comp-match');
          } else {
            compBadge.textContent = 'Size Diff';
            compBadge.classList.add('comp-diff');
          }
        }
      } else {
        compBadge.textContent = 'Unique';
        compBadge.classList.add('comp-unique');
      }
      nameContainer.appendChild(compBadge);
    }

    // Kind
    const kind = document.createElement('span');
    kind.className = 'file-kind';
    kind.textContent = getFileKind(file);
    kind.title = kind.textContent;

    // Size
    const size = document.createElement('span');
    size.className = 'file-size';
    size.textContent = file.isDirectory ? '—' : formatFileSize(file.size);

    // Date
    const date = document.createElement('span');
    date.className = 'file-date';
    date.textContent = formatDate(file.modified);

    item.appendChild(icon);
    item.appendChild(nameContainer);
    item.appendChild(kind);
    item.appendChild(size);
    item.appendChild(date);

    // --- Event Handlers ---

    // Single click — selection
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      handleFileClick(file, index, e, side);
    });

    // Double click — navigate into directories
    item.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (file.isDirectory) {
        if (side === 'local') {
          loadLocalFiles(file.fullPath);
        } else {
          loadRemoteFiles(file.fullPath);
        }
      }
    });

    // Right-click — context menu
    item.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // If right-clicked file isn't selected, select it alone
      if (!selectionSet.has(file.fullPath)) {
        selectionSet.clear();
        selectionSet.add(file.fullPath);
        if (side === 'local') renderLocalFiles();
        else renderRemoteFiles();
      }
      showContextMenu(e, file, side);
    });

    container.appendChild(item);
  });
}

/* ======================================================================
   FILE SELECTION
   ====================================================================== */

/**
 * Handle click on a file item with support for Cmd+Click and Shift+Click.
 */
function handleFileClick(file, index, event, side) {
  setActivePanel(side);
  const selectionSet = side === 'local' ? state.localSelected : state.remoteSelected;
  const files = sortFiles(
    getFilteredFiles(
      side === 'local' ? state.localFiles : state.remoteFiles,
      side === 'local' ? state.localSearchQuery : state.remoteSearchQuery
    ),
    side === 'local' ? state.localSortKey : state.remoteSortKey,
    side === 'local' ? state.localSortOrder : state.remoteSortOrder
  );
  const lastClicked = side === 'local' ? state.lastClickedLocal : state.lastClickedRemote;

  if (event.shiftKey && lastClicked !== null) {
    // Shift+Click — range select
    const anchor = side === 'local' ? state.localShiftAnchor : state.remoteShiftAnchor;
    const start = Math.min(anchor !== null ? anchor : lastClicked, index);
    const end = Math.max(anchor !== null ? anchor : lastClicked, index);
    // If not holding Cmd/Ctrl, clear existing selection first
    if (!event.metaKey && !event.ctrlKey) selectionSet.clear();
    for (let i = start; i <= end; i++) {
      selectionSet.add(files[i].fullPath);
    }
  } else if (event.metaKey || event.ctrlKey) {
    // Cmd+Click or Ctrl+Click — toggle individual file
    if (selectionSet.has(file.fullPath)) {
      selectionSet.delete(file.fullPath);
    } else {
      selectionSet.add(file.fullPath);
    }
    if (side === 'local') {
      state.localShiftAnchor = index;
    } else {
      state.remoteShiftAnchor = index;
    }
  } else {
    // Plain click — single select
    selectionSet.clear();
    selectionSet.add(file.fullPath);
    if (side === 'local') {
      state.localShiftAnchor = index;
    } else {
      state.remoteShiftAnchor = index;
    }
  }

  // Track last clicked index (cursor)
  if (side === 'local') {
    state.lastClickedLocal = index;
  } else {
    state.lastClickedRemote = index;
  }

  // Re-render the affected panel and update transfer buttons
  if (side === 'local') renderLocalFiles();
  else renderRemoteFiles();
  updateTransferButtons();
}

function setActivePanel(side) {
  state.activePanel = side;
  
  const localPanel = document.getElementById('local-panel');
  const remotePanel = document.getElementById('remote-panel');
  
  if (side === 'local') {
    if (localPanel) localPanel.classList.add('active-panel');
    if (remotePanel) remotePanel.classList.remove('active-panel');
  } else {
    if (localPanel) localPanel.classList.remove('active-panel');
    if (remotePanel) remotePanel.classList.add('active-panel');
  }
}

/* ======================================================================
   TRANSFER BUTTONS
   ====================================================================== */

function getSourceName(source) {
  if (source === 'mac') return 'Mac';
  const dev = state.devices.find(d => d.id === source);
  return dev ? dev.model : 'Phone';
}

function updateTransferButtons() {
  const toPhone = document.getElementById('btn-to-phone');
  const toMac = document.getElementById('btn-to-mac');
  const labelToPhone = document.getElementById('label-to-phone');
  const labelToMac = document.getElementById('label-to-mac');

  const leftName = getSourceName(state.localSource);
  const rightName = getSourceName(state.remoteSource);

  if (labelToPhone) labelToPhone.textContent = `To ${rightName}`;
  if (labelToMac) labelToMac.textContent = `To ${leftName}`;

  const sameSource = state.localSource === state.remoteSource;

  if (toPhone) {
    toPhone.disabled = sameSource || state.localSelected.size === 0 || state.isTransferring;
    toPhone.title = `Copy selected files from ${leftName} to ${rightName}`;
  }
  if (toMac) {
    toMac.disabled = sameSource || state.remoteSelected.size === 0 || state.isTransferring;
    toMac.title = `Copy selected files from ${rightName} to ${leftName}`;
  }
}

/* ======================================================================
   FILE TRANSFER HELPERS
   ====================================================================== */

function formatTransferError(errors, defaultMsg) {
  if (!errors || errors.length === 0) return defaultMsg;
  const first = errors[0];
  if (typeof first === 'string') return first;
  if (first && typeof first === 'object') {
    if (first.file && first.error) {
      return `${first.file}: ${first.error}`;
    }
    return first.error || first.message || JSON.stringify(first);
  }
  return String(first);
}

/* ======================================================================
   FILE TRANSFER
   ====================================================================== */

async function transferToPhone() {
  const leftName = getSourceName(state.localSource);
  const rightName = getSourceName(state.remoteSource);

  if (state.localSource === state.remoteSource) {
    showToast('Cannot transfer to the same storage source', 'error');
    return;
  }
  if (state.localSelected.size === 0) {
    showToast(`Select files on ${leftName} to transfer`, 'info');
    return;
  }

  const sourcePaths = [...state.localSelected];

  // 1. Phone to Phone
  if (state.localSource !== 'mac' && state.remoteSource !== 'mac') {
    await executePhoneToPhoneTransfer(state.localSource, state.remoteSource, sourcePaths, state.remotePath);
    return;
  }

  setTransferOverlay(true);

  try {
    let result;
    if (state.localSource === 'mac' && state.remoteSource !== 'mac') {
      // Mac to Phone
      result = await window.droidBridge.pushFiles(
        state.remoteSource,
        sourcePaths,
        state.remotePath,
      );
    } else if (state.localSource !== 'mac' && state.remoteSource === 'mac') {
      // Phone to Mac
      result = await window.droidBridge.pullFiles(
        state.localSource,
        sourcePaths,
        state.remotePath,
      );
    }

    setTransferOverlay(false);

    if (result && result.success) {
      showToast(`Transferred ${result.transferred} file(s) to ${rightName}`, 'success');
    } else if (result) {
      const errMsg = formatTransferError(result.errors, 'Transfer failed');
      showToast(errMsg, 'error');
    }

    // Refresh listing
    await loadRemoteFiles(state.remotePath);
    await loadStorageInfo();
  } catch (err) {
    setTransferOverlay(false);
    showToast('Transfer failed: ' + (err.message || err), 'error');
    console.error('transferToPhone error:', err);
  }
}

async function transferToMac() {
  const leftName = getSourceName(state.localSource);
  const rightName = getSourceName(state.remoteSource);

  if (state.localSource === state.remoteSource) {
    showToast('Cannot transfer to the same storage source', 'error');
    return;
  }
  if (state.remoteSelected.size === 0) {
    showToast(`Select files on ${rightName} to transfer`, 'info');
    return;
  }

  const sourcePaths = [...state.remoteSelected];

  // 1. Phone to Phone (from Right Panel to Left Panel)
  if (state.localSource !== 'mac' && state.remoteSource !== 'mac') {
    await executePhoneToPhoneTransfer(state.remoteSource, state.localSource, sourcePaths, state.localPath);
    return;
  }

  setTransferOverlay(true);

  try {
    let result;
    if (state.remoteSource === 'mac' && state.localSource !== 'mac') {
      // Mac to Phone (Right to Left)
      result = await window.droidBridge.pushFiles(
        state.localSource,
        sourcePaths,
        state.localPath,
      );
    } else if (state.remoteSource !== 'mac' && state.localSource === 'mac') {
      // Phone to Mac (Right to Left)
      result = await window.droidBridge.pullFiles(
        state.remoteSource,
        sourcePaths,
        state.localPath,
      );
    }

    setTransferOverlay(false);

    if (result && result.success) {
      showToast(`Transferred ${result.transferred} file(s) to ${leftName}`, 'success');
    } else if (result) {
      const errMsg = formatTransferError(result.errors, 'Transfer failed');
      showToast(errMsg, 'error');
    }

    // Refresh listing
    await loadLocalFiles(state.localPath);
    await loadStorageInfo();
  } catch (err) {
    setTransferOverlay(false);
    showToast('Transfer failed: ' + (err.message || err), 'error');
    console.error('transferToMac error:', err);
  }
}

async function executePhoneToPhoneTransfer(srcDeviceId, destDeviceId, srcPaths, destPath) {
  setTransferOverlay(true);
  
  const progressPercent = document.getElementById('progress-percent');
  const progressFilename = document.getElementById('progress-filename');
  const progressBarFill = document.getElementById('progress-bar-fill');

  let tempDir = null;
  try {
    if (progressFilename) progressFilename.textContent = 'Phase 1/2: Preparing temp staging directory on Mac...';
    if (progressPercent) progressPercent.textContent = '0%';
    if (progressBarFill) progressBarFill.style.width = '0%';

    tempDir = await window.droidBridge.getTempDir();

    if (progressFilename) progressFilename.textContent = 'Phase 1/2: Copying files from source phone to Mac temp...';
    const pullResult = await window.droidBridge.pullFiles(srcDeviceId, srcPaths, tempDir);
    if (!pullResult.success) {
      const firstError = formatTransferError(pullResult.errors, 'Pull to temp folder failed');
      throw new Error(firstError);
    }

    if (progressFilename) progressFilename.textContent = 'Phase 2/2: Copying files from Mac temp to destination phone...';
    if (progressPercent) progressPercent.textContent = '0%';
    if (progressBarFill) progressBarFill.style.width = '0%';

    const localPathsToPush = srcPaths.map(p => {
      const base = p.split('/').pop();
      return tempDir + '/' + base;
    });

    const pushResult = await window.droidBridge.pushFiles(destDeviceId, localPathsToPush, destPath);
    if (!pushResult.success) {
      const firstError = formatTransferError(pushResult.errors, 'Push to destination failed');
      throw new Error(firstError);
    }

    showToast(`Transferred ${pushResult.transferred} file(s) between phones successfully`, 'success');
  } catch (err) {
    const errorStr = (err && typeof err === 'object') ? (err.message || JSON.stringify(err)) : String(err);
    showToast('Phone-to-Phone transfer failed: ' + errorStr, 'error');
    console.error('executePhoneToPhoneTransfer error:', err);
  } finally {
    setTransferOverlay(false);
    if (tempDir) {
      await window.droidBridge.cleanupDir(tempDir);
    }
    await loadLocalFiles(state.localPath);
    await loadRemoteFiles(state.remotePath);
    await loadStorageInfo();
  }
}

/* ======================================================================
   CONTEXT MENU
   ====================================================================== */

function showContextMenu(event, file, side) {
  closeContextMenu(); // close any existing one

  const menu = document.getElementById('context-menu');
  if (!menu) return;

  menu.innerHTML = '';
  menu.style.display = 'block';

  // Position at cursor, clamped to viewport
  const x = Math.min(event.clientX, window.innerWidth - 200);
  const y = Math.min(event.clientY, window.innerHeight - 200);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  /**
   * Helper to add a menu item.
   */
  function addItem(label, handler) {
    const item = document.createElement('div');
    item.className = 'context-menu-item';
    item.textContent = label;
    item.addEventListener('click', (e) => {
      e.stopPropagation();
      closeContextMenu();
      handler();
    });
    menu.appendChild(item);
  }

  function addSeparator() {
    const sep = document.createElement('div');
    sep.className = 'context-menu-separator';
    menu.appendChild(sep);
  }

  const leftName = getSourceName(state.localSource);
  const rightName = getSourceName(state.remoteSource);

  if (side === 'local') {
    addItem('Open in Finder', () => {
      if (state.localSource === 'mac') {
        window.droidBridge.openInFinder(file.fullPath);
      } else {
        showToast('Can only reveal local files in Finder', 'info');
      }
    });
    if (state.localSource !== state.remoteSource) {
      addItem(`Transfer to ${rightName}`, () => transferToPhone());
    }
    addSeparator();
    addItem('Select All', () => selectAll('local'));
  } else {
    if (state.localSource !== state.remoteSource) {
      addItem(`Transfer to ${leftName}`, () => transferToMac());
    }
    if (state.remoteSource !== 'mac') {
      addItem('Delete', () => deleteRemoteSelected());
      addItem('New Folder', () => promptNewRemoteFolder());
    }
    addSeparator();
    addItem('Select All', () => selectAll('remote'));
  }
}

function closeContextMenu() {
  const menu = document.getElementById('context-menu');
  if (menu) {
    menu.style.display = 'none';
    menu.innerHTML = '';
  }
}

/* ======================================================================
   REMOTE FILE ACTIONS (DELETE / NEW FOLDER)
   ====================================================================== */

async function deleteRemoteSelected() {
  if (state.remoteSource === 'mac' || state.remoteSelected.size === 0) return;

  const paths = [...state.remoteSelected];
  let successCount = 0;
  let lastError = null;

  for (const remotePath of paths) {
    try {
      const result = await window.droidBridge.deleteRemote(state.remoteSource, remotePath);
      if (result.success) {
        successCount++;
      } else {
        lastError = result.error;
      }
    } catch (err) {
      lastError = err.message || err;
    }
  }

  if (successCount > 0) {
    showToast(`Deleted ${successCount} item(s)`, 'success');
  }
  if (lastError) {
    showToast('Some deletes failed: ' + lastError, 'error');
  }

  state.remoteSelected.clear();
  await loadRemoteFiles(state.remotePath);
  await loadStorageInfo();
}

function promptNewRemoteFolder() {
  const name = prompt('New folder name:');
  if (!name || !name.trim()) return;
  createRemoteFolder(name.trim());
}

async function createRemoteFolder(name) {
  if (state.remoteSource === 'mac') return;
  const fullPath = state.remotePath.replace(/\/$/, '') + '/' + name;
  try {
    const result = await window.droidBridge.createRemoteDir(state.remoteSource, fullPath);
    if (result.success) {
      showToast(`Created folder "${name}"`, 'success');
      await loadRemoteFiles(state.remotePath);
    } else {
      showToast('Failed: ' + (result.error || 'unknown error'), 'error');
    }
  } catch (err) {
    showToast('Failed to create folder: ' + (err.message || err), 'error');
  }
}

/* ======================================================================
   SELECT ALL
   ====================================================================== */

function selectAll(side) {
  const files = side === 'local' ? state.localFiles : state.remoteFiles;
  const set = side === 'local' ? state.localSelected : state.remoteSelected;
  set.clear();
  files.forEach((f) => set.add(f.fullPath));
  if (side === 'local') renderLocalFiles();
  else renderRemoteFiles();
  updateTransferButtons();
}

/* ======================================================================
   FILE LOADING
   ====================================================================== */

async function loadLocalFiles(dirPath) {
  try {
    let result;
    if (state.localSource === 'mac') {
      let targetPath = dirPath;
      if (dirPath.startsWith('/sdcard') || dirPath.startsWith('/storage') || dirPath === '') {
        const homeDir = await window.droidBridge.getHomeDir();
        targetPath = homeDir || '/';
      }
      result = await window.droidBridge.listLocalFiles(targetPath);
    } else {
      let targetPath = dirPath;
      if (!dirPath.startsWith('/') && !dirPath.startsWith('\\')) {
        targetPath = '/sdcard';
      }
      result = await window.droidBridge.listRemoteFiles(state.localSource, targetPath);
    }
    state.localPath = result.currentPath || dirPath;
    state.localFiles = result.files || [];
    state.localSelected.clear();
    state.lastClickedLocal = null;
    renderLocalFiles();
    renderLocalBreadcrumb();
    updateTransferButtons();
  } catch (err) {
    showToast('Failed to list files: ' + (err.message || err), 'error');
    console.error('loadLocalFiles error:', err);
  }
}

async function loadRemoteFiles(dirPath) {
  try {
    let result;
    if (state.remoteSource === 'mac') {
      let targetPath = dirPath;
      if (dirPath.startsWith('/sdcard') || dirPath.startsWith('/storage') || dirPath === '') {
        const homeDir = await window.droidBridge.getHomeDir();
        targetPath = homeDir || '/';
      }
      result = await window.droidBridge.listLocalFiles(targetPath);
    } else {
      let targetPath = dirPath;
      if (!dirPath.startsWith('/') && !dirPath.startsWith('\\')) {
        targetPath = '/sdcard';
      }
      result = await window.droidBridge.listRemoteFiles(state.remoteSource, targetPath);
    }
    state.remotePath = result.currentPath || dirPath;
    state.remoteFiles = result.files || [];
    state.remoteSelected.clear();
    state.lastClickedRemote = null;
    renderRemoteFiles();
    renderRemoteBreadcrumb();
    updateTransferButtons();
  } catch (err) {
    showToast('Failed to list files: ' + (err.message || err), 'error');
    console.error('loadRemoteFiles error:', err);
  }
}

/* ======================================================================
   DEVICE EVENT HANDLERS
   ====================================================================== */

async function refreshDevicesList() {
  try {
    const activeDevices = await window.droidBridge.getDevices();
    const updatedDevices = [];

    for (const dev of activeDevices) {
      if (dev.status === 'device') {
        let info = {};
        try {
          info = await window.droidBridge.getDeviceInfo(dev.id);
        } catch (err) {
          console.warn('Failed to fetch info for device:', dev.id, err);
        }
        updatedDevices.push({
          id: dev.id,
          model: info.model || dev.model || 'Android Device',
          manufacturer: info.manufacturer || '',
          androidVersion: info.androidVersion || '',
          status: dev.status
        });
      } else {
        updatedDevices.push({
          id: dev.id,
          model: `Android Device (unauthorized)`,
          manufacturer: '',
          androidVersion: '',
          status: dev.status
        });
      }
    }

    // Compare with current state.devices to detect changes or show toasts
    const prevIds = state.devices.map(d => d.id);
    const currIds = updatedDevices.map(d => d.id);

    // Connected toasts
    for (const d of updatedDevices) {
      if (!prevIds.includes(d.id)) {
        showToast(`${d.model} connected`, 'success');
      }
    }

    // Disconnected toasts
    for (const d of state.devices) {
      if (!currIds.includes(d.id)) {
        showToast(`${d.model} disconnected`, 'info');
      }
    }

    state.devices = updatedDevices;

    // Check if we need to show the "no-device" overlay
    if (state.devices.length === 0) {
      showScreen('no-device-screen');
      state.localSource = 'mac';
      state.remoteSource = 'mac';
    } else {
      hideScreen('no-device-screen');
    }

    // Update connection badge (top right)
    const badge = document.getElementById('connection-badge');
    const badgeText = document.getElementById('connection-text');
    const dot = document.getElementById('connection-dot');

    if (state.devices.length === 0) {
      if (badge) {
        badge.className = 'disconnected';
      }
      if (badgeText) badgeText.textContent = 'No Device';
      if (dot) dot.className = 'status-dot disconnected';
    } else {
      if (badge) {
        badge.className = 'connected';
      }
      if (badgeText) {
        badgeText.textContent = state.devices.length === 1 
          ? state.devices[0].model 
          : `${state.devices.length} Devices`;
      }
      if (dot) dot.className = 'status-dot connected';
    }

    // Update the dropdown menus
    updateSourceDropdowns();

    // Refresh display
    updateDeviceBar();
    loadStorageInfo();

    // Reload files for panels if their source changed or if we need to load them first time
    if (!state.localPath) {
      const homeDir = await window.droidBridge.getHomeDir();
      await loadLocalFiles(homeDir || '/');
    } else {
      await loadLocalFiles(state.localPath);
    }

    if (!state.remotePath) {
      state.remotePath = '/sdcard';
    }
    await loadRemoteFiles(state.remotePath);

  } catch (err) {
    console.error('Error refreshing devices list:', err);
  }
}

function updateSourceDropdowns() {
  const leftSelect = document.getElementById('left-source-select');
  const rightSelect = document.getElementById('right-source-select');
  if (!leftSelect || !rightSelect) return;

  const leftVal = leftSelect.value || 'mac';
  const rightVal = rightSelect.value || 'mac';

  // Clear options
  leftSelect.innerHTML = '';
  rightSelect.innerHTML = '';

  // Add Mac option
  const optMacLeft = document.createElement('option');
  optMacLeft.value = 'mac';
  optMacLeft.textContent = '💻 macOS Filesystem';
  leftSelect.appendChild(optMacLeft);

  const optMacRight = document.createElement('option');
  optMacRight.value = 'mac';
  optMacRight.textContent = '💻 macOS Filesystem';
  rightSelect.appendChild(optMacRight);

  // Add each connected device
  for (const dev of state.devices) {
    const label = `📱 ${dev.manufacturer} ${dev.model} (${dev.id})`;
    
    const optLeft = document.createElement('option');
    optLeft.value = dev.id;
    optLeft.textContent = label;
    leftSelect.appendChild(optLeft);

    const optRight = document.createElement('option');
    optRight.value = dev.id;
    optRight.textContent = label;
    rightSelect.appendChild(optRight);
  }

  // Restore values if still connected, else reset
  const hasLeft = leftVal === 'mac' || state.devices.some(d => d.id === leftVal);
  leftSelect.value = hasLeft ? leftVal : 'mac';
  state.localSource = leftSelect.value;

  const hasRight = rightVal === 'mac' || state.devices.some(d => d.id === rightVal);
  if (hasRight) {
    rightSelect.value = rightVal;
  } else {
    // Default right panel to first device, if any
    rightSelect.value = state.devices.length > 0 ? state.devices[0].id : 'mac';
  }
  state.remoteSource = rightSelect.value;
}

function handleTransferProgress(progress) {
  if (!progress) return;
  const fill = document.querySelector('#transfer-overlay .progress-bar-fill');
  const pct = document.getElementById('progress-percent');
  const fname = document.getElementById('progress-filename');

  if (fill) fill.style.width = (progress.percent || 0) + '%';
  if (pct) pct.textContent = (progress.percent || 0) + '%';
  if (fname) {
    const fileLabel = progress.fileName || '';
    const progressLabel = (progress.total > 1 && progress.current) ? ` (${progress.current}/${progress.total})` : '';
    fname.textContent = fileLabel + progressLabel;
  }
}

/* ======================================================================
   SEARCH
   ====================================================================== */

function setupSearch() {
  const localSearch = document.getElementById('local-search');
  const remoteSearch = document.getElementById('remote-search');

  if (localSearch) {
    localSearch.addEventListener(
      'input',
      debounce((e) => {
        state.localSearchQuery = e.target.value;
        renderLocalFiles();
      }, 250),
    );
  }

  if (remoteSearch) {
    remoteSearch.addEventListener(
      'input',
      debounce((e) => {
        state.remoteSearchQuery = e.target.value;
        renderRemoteFiles();
      }, 250),
    );
  }
}

/* ======================================================================
   KEYBOARD SHORTCUTS
   ====================================================================== */

function setupKeyboard() {
  document.addEventListener('keydown', (e) => {
    // Close context menu on Escape
    if (e.key === 'Escape') {
      closeContextMenu();
      return;
    }

    // Cmd+A — Select all in focused panel
    if ((e.metaKey || e.ctrlKey) && e.key === 'a') {
      e.preventDefault();
      // Determine which panel is focused by checking active element ancestry
      const active = document.activeElement;
      if (active && active.closest('#remote-file-list, #remote-search')) {
        selectAll('remote');
      } else {
        selectAll('local');
      }
      return;
    }

    // Delete / Backspace — delete selected remote files
    if (e.key === 'Delete' || e.key === 'Backspace') {
      // Only act if there's a remote selection and we're not inside an input
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
      if (state.remoteSelected.size > 0 && state.remoteSource !== 'mac') {
        e.preventDefault();
        deleteRemoteSelected();
      }
      return;
    }

    // Arrow keys — navigate files
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      // Don't intercept arrow keys if we are editing an input box
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;

      e.preventDefault();
      const side = state.activePanel; // 'local' or 'remote'
      const files = sortFiles(
        getFilteredFiles(
          side === 'local' ? state.localFiles : state.remoteFiles,
          side === 'local' ? state.localSearchQuery : state.remoteSearchQuery
        ),
        side === 'local' ? state.localSortKey : state.remoteSortKey,
        side === 'local' ? state.localSortOrder : state.remoteSortOrder
      );

      if (files.length === 0) return;

      const selectionSet = side === 'local' ? state.localSelected : state.remoteSelected;
      let lastIndex = side === 'local' ? state.lastClickedLocal : state.lastClickedRemote;

      if (lastIndex === null || lastIndex === undefined || lastIndex < 0) {
        if (selectionSet.size > 0) {
          const selectedPaths = Array.from(selectionSet);
          lastIndex = files.findIndex(f => selectedPaths.includes(f.fullPath));
        } else {
          lastIndex = e.key === 'ArrowDown' ? -1 : files.length;
        }
      }

      let nextIndex = lastIndex + (e.key === 'ArrowDown' ? 1 : -1);
      if (nextIndex < 0) nextIndex = 0;
      if (nextIndex >= files.length) nextIndex = files.length - 1;

      const file = files[nextIndex];

      if (e.shiftKey) {
        // Extend selection range
        let anchor = side === 'local' ? state.localShiftAnchor : state.remoteShiftAnchor;
        if (anchor === null || anchor === undefined || anchor < 0) {
          anchor = lastIndex >= 0 ? lastIndex : 0;
          if (side === 'local') {
            state.localShiftAnchor = anchor;
          } else {
            state.remoteShiftAnchor = anchor;
          }
        }
        
        selectionSet.clear();
        const start = Math.min(anchor, nextIndex);
        const end = Math.max(anchor, nextIndex);
        for (let i = start; i <= end; i++) {
          selectionSet.add(files[i].fullPath);
        }
        
        // Update the cursor index for next arrow key press
        if (side === 'local') {
          state.lastClickedLocal = nextIndex;
        } else {
          state.lastClickedRemote = nextIndex;
        }
      } else {
        // Normal single selection — updates both anchor and cursor to nextIndex
        selectionSet.clear();
        selectionSet.add(file.fullPath);
        
        if (side === 'local') {
          state.lastClickedLocal = nextIndex;
          state.localShiftAnchor = nextIndex;
        } else {
          state.lastClickedRemote = nextIndex;
          state.remoteShiftAnchor = nextIndex;
        }
      }

      if (side === 'local') {
        renderLocalFiles();
      } else {
        renderRemoteFiles();
      }
      updateTransferButtons();

      // Scroll the selected item into view
      setTimeout(() => {
        const listContainer = document.getElementById(`${side}-file-list`);
        if (listContainer) {
          const activeItem = listContainer.querySelector(`.file-item[data-index="${nextIndex}"]`);
          if (activeItem) {
            activeItem.scrollIntoView({ block: 'nearest' });
          }
        }
      }, 10);
      return;
    }
  });
}

/* ======================================================================
   GLOBAL CLICK HANDLERS
   ====================================================================== */

function setupGlobalHandlers() {
  // Close context menu when clicking anywhere outside
  document.addEventListener('click', (e) => {
    const menu = document.getElementById('context-menu');
    if (menu && menu.style.display !== 'none' && !menu.contains(e.target)) {
      closeContextMenu();
    }
  });

  // Clicking empty area in local panel — clear local selection
  const localList = document.getElementById('local-file-list');
  if (localList) {
    localList.addEventListener('click', (e) => {
      setActivePanel('local');
      if (e.target === localList) {
        state.localSelected.clear();
        state.lastClickedLocal = null;
        renderLocalFiles();
        updateTransferButtons();
      }
    });
  }

  // Clicking empty area in remote panel — clear remote selection
  const remoteList = document.getElementById('remote-file-list');
  if (remoteList) {
    remoteList.addEventListener('click', (e) => {
      setActivePanel('remote');
      if (e.target === remoteList) {
        state.remoteSelected.clear();
        state.lastClickedRemote = null;
        renderRemoteFiles();
        updateTransferButtons();
      }
    });
  }

  // Transfer buttons
  const toPhone = document.getElementById('btn-to-phone');
  const toMac = document.getElementById('btn-to-mac');
  if (toPhone) toPhone.addEventListener('click', () => transferToPhone());
  if (toMac) toMac.addEventListener('click', () => transferToMac());

  // Refresh buttons
  const refreshLocal = document.getElementById('btn-refresh-local');
  const refreshRemote = document.getElementById('btn-refresh-remote');
  if (refreshLocal) {
    refreshLocal.addEventListener('click', () => {
      loadLocalFiles(state.localPath);
      showToast('Left panel refreshed', 'success');
    });
  }
  if (refreshRemote) {
    refreshRemote.addEventListener('click', () => {
      loadRemoteFiles(state.remotePath);
      loadStorageInfo();
      showToast('Right panel refreshed', 'success');
    });
  }

  // Source dropdown selectors
  const leftSelect = document.getElementById('left-source-select');
  const rightSelect = document.getElementById('right-source-select');

  if (leftSelect) {
    leftSelect.addEventListener('change', async (e) => {
      state.localSource = e.target.value;
      if (state.localSource === 'mac') {
        const homeDir = await window.droidBridge.getHomeDir();
        state.localPath = homeDir || '/';
      } else {
        state.localPath = '/sdcard';
      }
      await loadLocalFiles(state.localPath);
      updateDeviceBar();
      loadStorageInfo();
    });
  }

  if (rightSelect) {
    rightSelect.addEventListener('change', async (e) => {
      state.remoteSource = e.target.value;
      if (state.remoteSource === 'mac') {
        const homeDir = await window.droidBridge.getHomeDir();
        state.remotePath = homeDir || '/';
      } else {
        state.remotePath = '/sdcard';
      }
      await loadRemoteFiles(state.remotePath);
      updateDeviceBar();
      loadStorageInfo();
    });
  }

  // Compare buttons
  const compareLocal = document.getElementById('btn-compare-local');
  const compareRemote = document.getElementById('btn-compare-remote');
  if (compareLocal) compareLocal.addEventListener('click', toggleComparison);
  if (compareRemote) compareRemote.addEventListener('click', toggleComparison);

  // About modal click handlers
  const btnAbout = document.getElementById('btn-about');
  const btnCloseAbout = document.getElementById('btn-close-about');
  const aboutOverlay = document.getElementById('about-overlay');

  if (btnAbout) {
    btnAbout.addEventListener('click', () => {
      if (aboutOverlay) aboutOverlay.style.display = 'flex';
    });
  }

  if (btnCloseAbout) {
    btnCloseAbout.addEventListener('click', () => {
      if (aboutOverlay) aboutOverlay.style.display = 'none';
    });
  }

  if (aboutOverlay) {
    aboutOverlay.addEventListener('click', (e) => {
      if (e.target === aboutOverlay) {
        aboutOverlay.style.display = 'none';
      }
    });
  }

  // Wi-Fi click handlers
  const btnStartWifiSetup = document.getElementById('btn-start-wifi-setup');
  const btnStopWifi = document.getElementById('btn-stop-wifi');
  const btnCopyWifiUrl = document.getElementById('btn-copy-wifi-url');
  const btnOpenWifiDir = document.getElementById('btn-open-wifi-dir');

  if (btnStartWifiSetup) {
    btnStartWifiSetup.addEventListener('click', async () => {
      try {
        const result = await window.droidBridge.startWifiServer();
        if (result && result.success) {
          const qrImg = document.getElementById('wifi-qr-code');
          const urlInput = document.getElementById('wifi-url-text');
          const sharedPath = document.getElementById('wifi-shared-path');

          if (qrImg) qrImg.src = result.qrCode;
          if (urlInput) urlInput.value = `http://${result.ip}:${result.port}`;
          if (sharedPath) {
            sharedPath.textContent = result.sharedDir;
            sharedPath.title = result.sharedDir;
          }
          showScreen('wifi-transfer-screen');

          // Reset activity log
          const activityLog = document.getElementById('wifi-activity-log');
          if (activityLog) {
            activityLog.innerHTML = '<div class="activity-empty">No files transferred yet. Connect your phone to start uploading/downloading!</div>';
          }

          showToast('Wi-Fi Server started successfully', 'success');
        } else {
          showToast('Failed to start server: ' + (result?.error || 'unknown error'), 'error');
        }
      } catch (err) {
        showToast('Error starting Wi-Fi server: ' + (err.message || err), 'error');
      }
    });
  }

  const btnChooseWifiDir = document.getElementById('btn-choose-wifi-dir');
  if (btnChooseWifiDir) {
    btnChooseWifiDir.addEventListener('click', async () => {
      try {
        const selectedDir = await window.droidBridge.selectDirectory();
        if (selectedDir) {
          const res = await window.droidBridge.setWifiSharedDir(selectedDir);
          if (res && res.success) {
            const sharedPath = document.getElementById('wifi-shared-path');
            if (sharedPath) {
              sharedPath.textContent = res.sharedDir;
              sharedPath.title = res.sharedDir;
            }
            showToast('Shared folder updated successfully', 'success');
          }
        }
      } catch (err) {
        showToast('Error changing shared folder: ' + err.message, 'error');
      }
    });
  }

  if (btnStopWifi) {
    btnStopWifi.addEventListener('click', async () => {
      try {
        await window.droidBridge.stopWifiServer();
        hideScreen('wifi-transfer-screen');
        showToast('Wi-Fi Server stopped', 'info');
      } catch (err) {
        showToast('Error stopping Wi-Fi server: ' + (err.message || err), 'error');
      }
    });
  }

  if (btnCopyWifiUrl) {
    btnCopyWifiUrl.addEventListener('click', () => {
      const urlInput = document.getElementById('wifi-url-text');
      if (urlInput) {
        navigator.clipboard.writeText(urlInput.value);
        showToast('Link copied to clipboard!', 'success');
      }
    });
  }

  if (btnOpenWifiDir) {
    btnOpenWifiDir.addEventListener('click', () => {
      window.droidBridge.openWifiSharedDir();
    });
  }
}

function toggleComparison() {
  if (state.localSource === state.remoteSource) {
    showToast('Select different storage sources to compare files', 'error');
    return;
  }
  
  state.comparisonActive = !state.comparisonActive;
  
  const localBtn = document.getElementById('btn-compare-local');
  const remoteBtn = document.getElementById('btn-compare-remote');
  
  if (state.comparisonActive) {
    if (localBtn) localBtn.classList.add('active');
    if (remoteBtn) remoteBtn.classList.add('active');
    
    let matches = 0;
    let diffs = 0;
    let uniques = 0;
    
    state.localFiles.forEach(lf => {
      const match = state.remoteFiles.find(rf => rf.name.toLowerCase() === lf.name.toLowerCase());
      if (match) {
        if (lf.isDirectory && match.isDirectory) {
          matches++;
        } else if (lf.isDirectory !== match.isDirectory) {
          diffs++;
        } else {
          if (lf.size === match.size) {
            matches++;
          } else {
            diffs++;
          }
        }
      } else {
        uniques++;
      }
    });
    
    state.remoteFiles.forEach(rf => {
      const match = state.localFiles.find(lf => lf.name.toLowerCase() === rf.name.toLowerCase());
      if (!match) {
        uniques++;
      }
    });

    showToast(`Comparison complete: ${matches} matching, ${diffs} mismatching, ${uniques} unique`, 'success');
  } else {
    if (localBtn) localBtn.classList.remove('active');
    if (remoteBtn) remoteBtn.classList.remove('active');
    showToast('Comparison cleared', 'info');
  }
  
  renderLocalFiles();
  renderRemoteFiles();
}

/* ======================================================================
   SORTING HANDLERS
   ====================================================================== */

function setupSortHandlers() {
  const headers = document.querySelectorAll('.sortable');
  headers.forEach(header => {
    header.addEventListener('click', () => {
      const sortKey = header.dataset.sort;
      const panel = header.dataset.panel; // 'local' or 'remote'

      if (panel === 'local') {
        if (state.localSortKey === sortKey) {
          state.localSortOrder = state.localSortOrder === 'asc' ? 'desc' : 'asc';
        } else {
          state.localSortKey = sortKey;
          state.localSortOrder = 'asc';
        }
        renderLocalFiles();
      } else {
        if (state.remoteSortKey === sortKey) {
          state.remoteSortOrder = state.remoteSortOrder === 'asc' ? 'desc' : 'asc';
        } else {
          state.remoteSortKey = sortKey;
          state.remoteSortOrder = 'asc';
        }
        renderRemoteFiles();
      }

      // Update active sort indicator in UI
      updateSortHeaderUI();
    });
  });
}

function updateSortHeaderUI() {
  const headers = document.querySelectorAll('.sortable');
  headers.forEach(header => {
    const sortKey = header.dataset.sort;
    const panel = header.dataset.panel;
    const activeKey = panel === 'local' ? state.localSortKey : state.remoteSortKey;
    const activeOrder = panel === 'local' ? state.localSortOrder : state.remoteSortOrder;

    // Remove any existing indicators
    header.innerHTML = header.textContent.replace(/[▲▼]/g, '').trim();

    if (sortKey === activeKey) {
      header.classList.add('active-sort');
      header.innerHTML += activeOrder === 'asc' ? ' ▲' : ' ▼';
    } else {
      header.classList.remove('active-sort');
    }
  });
}

/* ======================================================================
   DEVICE POLLING (FALLBACK)
   Checks for devices periodically in case events are missed.
   ====================================================================== */

async function pollDevices() {
  await refreshDevicesList();
}

/* ======================================================================
   INITIALIZATION
   ====================================================================== */

async function init() {
  try {
    // 1. Check ADB installation
    const adbStatus = await window.droidBridge.checkAdb();
    state.adbInstalled = adbStatus && adbStatus.installed;

    // Do not block application load if ADB is missing, allowing Wi-Fi Share Mode usage.
    hideScreen('no-adb-screen');

    // 2. Get home directory and set as initial local path
    const homeDir = await window.droidBridge.getHomeDir();
    state.localPath = homeDir || '/';

    // 3. Load local files
    await loadLocalFiles(state.localPath);

    // 4. Initially show "no device" screen
    showScreen('no-device-screen');
    updateDeviceBar();
    updateTransferButtons();

    // 5. Register device event listeners
    window.droidBridge.onDeviceConnected(refreshDevicesList);
    window.droidBridge.onDeviceDisconnected(refreshDevicesList);
    window.droidBridge.onTransferProgress(handleTransferProgress);
    window.droidBridge.onShowAbout(() => {
      const aboutOverlay = document.getElementById('about-overlay');
      if (aboutOverlay) aboutOverlay.style.display = 'flex';
    });
    window.droidBridge.onWifiUploadProgress(updateWifiActivityLog);

    // 6. Setup UI event listeners
    setupSearch();
    setupKeyboard();
    setupGlobalHandlers();
    setupSortHandlers();
    updateSortHeaderUI();
    setActivePanel('local');

    // 7. Initial device check (in case a device is already connected)
    await refreshDevicesList();

    // 8. Periodic device poll every 5 seconds as a safety net
    setInterval(refreshDevicesList, 5000);

  } catch (err) {
    console.error('Initialization error:', err);
    showToast('Failed to initialize: ' + (err.message || err), 'error');
  }
}

function updateWifiActivityLog(progress) {
  const logContainer = document.getElementById('wifi-activity-log');
  if (!logContainer) return;

  // Remove empty state
  const empty = logContainer.querySelector('.activity-empty');
  if (empty) empty.remove();

  // Clean filename for ID matching
  const safeId = 'wifi-file-' + progress.fileName.replace(/[^a-zA-Z0-9]/g, '-');
  let item = document.getElementById(safeId);

  if (!item) {
    item = document.createElement('div');
    item.id = safeId;
    item.className = 'activity-item';
    logContainer.appendChild(item);
  }

  const statusText = progress.completed 
    ? '<span class="status">✓ Completed</span>' 
    : `<span class="percent">${progress.percent}%</span>`;

  item.innerHTML = `
    <span class="file">${escapeHtml(progress.fileName)}</span>
    ${statusText}
  `;

  // Auto scroll to bottom
  logContainer.scrollTop = logContainer.scrollHeight;

  // If completed, reload local directories (since files are received in the Mac shared folder)
  if (progress.completed) {
    loadLocalFiles(state.localPath);
  }
}

// --- Boot ---
document.addEventListener('DOMContentLoaded', init);
