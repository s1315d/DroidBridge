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
  get connectedDevice() { return this.devices[0] || null; }, // Backward compatibility helper
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
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
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

  const icons = { success: '✓', error: '✗', warning: '⚠️', info: 'ℹ' };
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
    background: type === 'success' ? '#16a34a' : type === 'error' ? '#dc2626' : type === 'warning' ? '#d97706' : '#2563eb',
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

// Transfer timing state for speed / ETA estimation.
// `progress.percent` from the main process is a smooth 0-100 value across the
// entire batch (combining file index and within-file progress), so we derive
// ETA from percent-over-time rather than byte counts.
let transferStartTime = 0;
let transferEtaEma = 0;

function formatEta(seconds) {
  if (!isFinite(seconds) || seconds < 0) return '';
  if (seconds < 1) return '<1s';
  if (seconds < 60) return Math.round(seconds) + 's';
  if (seconds < 3600) {
    const m = Math.floor(seconds / 60);
    const s = Math.round(seconds % 60);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(seconds / 3600);
  const mm = Math.floor((seconds % 3600) / 60);
  return `${h}h ${mm}m`;
}

function showScreen(id) {
  const el = document.getElementById(id);
  if (el) {
    el.style.display = 'flex';
    el.classList.add('active');
  }
}

function hideScreen(id) {
  const el = document.getElementById(id);
  if (el) {
    el.style.display = 'none';
    el.classList.remove('active');
  }
}

function setTransferOverlay(visible) {
  state.isTransferring = visible;
  const etaEl = document.getElementById('progress-speed-eta');
  const cancelBtn = document.getElementById('btn-cancel-transfer');
  const pauseBtn = document.getElementById('btn-pause-transfer');
  if (visible) {
    showScreen('transfer-overlay');
    // Reset progress
    const fill = document.querySelector('#transfer-overlay .progress-bar-fill');
    const pct = document.getElementById('progress-percent');
    const fname = document.getElementById('progress-filename');
    if (fill) fill.style.width = '0%';
    if (pct) pct.textContent = '0%';
    if (fname) fname.textContent = '';
    if (etaEl) etaEl.textContent = '';
    if (cancelBtn) {
      cancelBtn.disabled = false;
      cancelBtn.textContent = '✕ Cancel Transfer';
    }
    if (pauseBtn) {
      pauseBtn.disabled = false;
      pauseBtn.textContent = '⏸ Pause';
      pauseBtn.classList.remove('paused');
    }
    transferStartTime = Date.now();
    transferEtaEma = 0;
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
      let timeA = a.modified ? new Date(a.modified).getTime() : 0;
      let timeB = b.modified ? new Date(b.modified).getTime() : 0;
      if (isNaN(timeA)) timeA = 0;
      if (isNaN(timeB)) timeB = 0;
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

  const localSelectAll = document.getElementById('local-select-all');
  if (localSelectAll) {
    if (sorted.length === 0) {
      localSelectAll.checked = false;
      localSelectAll.indeterminate = false;
    } else {
      const selectedCount = sorted.filter((f) => state.localSelected.has(f.fullPath)).length;
      localSelectAll.checked = selectedCount === sorted.length;
      localSelectAll.indeterminate = selectedCount > 0 && selectedCount < sorted.length;
    }
  }
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

  const remoteSelectAll = document.getElementById('remote-select-all');
  if (remoteSelectAll) {
    if (sorted.length === 0) {
      remoteSelectAll.checked = false;
      remoteSelectAll.indeterminate = false;
    } else {
      const selectedCount = sorted.filter((f) => state.remoteSelected.has(f.fullPath)).length;
      remoteSelectAll.checked = selectedCount === sorted.length;
      remoteSelectAll.indeterminate = selectedCount > 0 && selectedCount < sorted.length;
    }
  }
}

const THUMB_CACHE_MAX = 200;
const thumbCache = new Map(); // insertion order = LRU order (oldest first)

function thumbCacheGet(key) {
  if (!thumbCache.has(key)) return undefined;
  const value = thumbCache.get(key);
  thumbCache.delete(key); // move to end (most recently used)
  thumbCache.set(key, value);
  return value;
}

function thumbCacheSet(key, value) {
  if (thumbCache.has(key)) thumbCache.delete(key);
  thumbCache.set(key, value);
  while (thumbCache.size > THUMB_CACHE_MAX) {
    const oldestKey = thumbCache.keys().next().value;
    thumbCache.delete(oldestKey);
  }
}

/**
 * Render a list of files into the given container.
 * @param {HTMLElement} container
 * @param {Array} files
 * @param {Set} selectionSet
 * @param {'local'|'remote'} side
 */
/* ======================================================================
   VIRTUAL SCROLL FILE LIST RENDERING (#10)
   Only renders DOM elements for the visible rows + a small buffer,
   using spacer divs to maintain correct scroll height. This keeps
   the UI responsive even with 1000+ files in a directory.
   ====================================================================== */

const VIRTUAL_ROW_HEIGHT = 40;
const VIRTUAL_BUFFER = 8;

const virtualState = {
  local: { files: [], selectionSet: null, container: null },
  remote: { files: [], selectionSet: null, container: null },
};

let pendingScrollIndex = { local: null, remote: null };

/**
 * Store the file list + selection state and render the visible rows.
 */
function renderFileList(container, files, selectionSet, side) {
  virtualState[side] = { files, selectionSet, container };
  renderVisibleRows(side);
}

/**
 * Render only the rows visible in the current scroll viewport (+ buffer),
 * with top/bottom spacer divs to maintain the full scroll height.
 */
function renderVisibleRows(side) {
  const vs = virtualState[side];
  if (!vs || !vs.container) return;
  const container = vs.container;
  const files = vs.files;
  const selectionSet = vs.selectionSet;
  const total = files.length;

  // Handle pending scroll request (arrow key navigation): ensure the
  // target row is within the viewport before computing visible range.
  if (pendingScrollIndex[side] !== null && pendingScrollIndex[side] >= 0) {
    const idx = pendingScrollIndex[side];
    const targetTop = idx * VIRTUAL_ROW_HEIGHT;
    const scrollTop = container.scrollTop;
    const viewportBottom = scrollTop + container.clientHeight;
    if (targetTop < scrollTop) {
      container.scrollTop = targetTop;
    } else if (targetTop + VIRTUAL_ROW_HEIGHT > viewportBottom) {
      container.scrollTop = targetTop + VIRTUAL_ROW_HEIGHT - container.clientHeight;
    }
    pendingScrollIndex[side] = null;
  }

  if (total === 0) {
    container.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'empty-dir';
    empty.textContent = 'This folder is empty';
    container.appendChild(empty);
    return;
  }

  const scrollTop = container.scrollTop;
  const containerHeight = container.clientHeight;
  const startIndex = Math.max(0, Math.floor(scrollTop / VIRTUAL_ROW_HEIGHT) - VIRTUAL_BUFFER);
  const endIndex = Math.min(total, Math.ceil((scrollTop + containerHeight) / VIRTUAL_ROW_HEIGHT) + VIRTUAL_BUFFER);

  container.innerHTML = '';

  // Top spacer
  if (startIndex > 0) {
    const topSpacer = document.createElement('div');
    topSpacer.className = 'virtual-spacer';
    topSpacer.style.height = (startIndex * VIRTUAL_ROW_HEIGHT) + 'px';
    container.appendChild(topSpacer);
  }

  // Visible rows
  for (let i = startIndex; i < endIndex; i++) {
    const item = createFileItem(files[i], i, side, selectionSet);
    container.appendChild(item);
  }

  // Bottom spacer
  if (endIndex < total) {
    const bottomSpacer = document.createElement('div');
    bottomSpacer.className = 'virtual-spacer';
    bottomSpacer.style.height = ((total - endIndex) * VIRTUAL_ROW_HEIGHT) + 'px';
    container.appendChild(bottomSpacer);
  }
}

/**
 * Create a single file-item DOM element with all columns, icons, and
 * event handlers. Extracted from the original renderFileList forEach body.
 */
function createFileItem(file, index, side, selectionSet) {
  const item = document.createElement('div');
  item.className = 'file-item' + (selectionSet.has(file.fullPath) ? ' selected' : '');
  item.dataset.index = index;
  item.dataset.fullPath = file.fullPath;

  const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'];
  const videoExts = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', '3gp'];

  // Column 1: Icon
  const icon = document.createElement('span');
  icon.className = 'file-icon';
  icon.textContent = getFileIcon(file);

  // Asynchronously upgrade file icon to real thumbnail for photos/videos
  if (!file.isDirectory && (imageExts.includes(ext) || videoExts.includes(ext))) {
    const cached = thumbCacheGet(file.fullPath);
    if (cached) {
      const img = document.createElement('img');
      img.className = 'file-list-thumb';
      img.src = cached;
      icon.innerHTML = '';
      icon.appendChild(img);
    } else if ((side === 'local' && state.localSource === 'mac') || (side === 'remote' && state.remoteSource === 'mac')) {
      queueLocalThumbnail(file.fullPath, (thumbDataUrl) => {
        if (thumbDataUrl) {
          thumbCacheSet(file.fullPath, thumbDataUrl);
          const img = document.createElement('img');
          img.className = 'file-list-thumb';
          img.src = thumbDataUrl;
          img.onerror = () => {};
          icon.innerHTML = '';
          icon.appendChild(img);
        }
      });
    } else {
      const deviceId = side === 'local' ? state.localSource : state.remoteSource;
      if (deviceId && deviceId !== 'mac') {
        queueRemoteThumbnail(deviceId, file.fullPath, (thumbDataUrl) => {
          if (thumbDataUrl) {
            thumbCacheSet(file.fullPath, thumbDataUrl);
            const img = document.createElement('img');
            img.className = 'file-list-thumb';
            img.src = thumbDataUrl;
            img.onerror = () => {};
            icon.innerHTML = '';
            icon.appendChild(img);
          }
        });
      }
    }
  }

  // Column 2: Name
  const nameContainer = document.createElement('div');
  nameContainer.className = 'file-name-container';

  const name = document.createElement('span');
  name.className = 'file-name';
  name.textContent = file.name;
  name.title = file.name;
  nameContainer.appendChild(name);

  // Add hover preview button for photos/videos
  if (!file.isDirectory && (imageExts.includes(ext) || videoExts.includes(ext))) {
    const prevBtn = document.createElement('button');
    prevBtn.className = 'file-preview-hover-btn';
    prevBtn.textContent = '👁️ Preview';
    prevBtn.title = 'Preview media file';
    prevBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openFilePreview(file, side);
    });
    nameContainer.appendChild(prevBtn);
  }

  // Comparison Badge
  if (state.comparisonActive) {
    const otherFiles = side === 'local' ? state.remoteFiles : state.localFiles;
    const match = otherFiles.find((f) => f.name.toLowerCase() === file.name.toLowerCase());
    const compBadge = document.createElement('span');
    compBadge.className = 'comp-badge';

    if (match) {
      if (file.isDirectory !== match.isDirectory) {
        compBadge.textContent = 'Type Diff';
        compBadge.classList.add('comp-diff');
      } else if (file.isDirectory && match.isDirectory) {
        if (file.itemCount !== undefined && match.itemCount !== undefined) {
          if (file.itemCount === match.itemCount) {
            compBadge.textContent = `Match (${file.itemCount} items)`;
            compBadge.classList.add('comp-match');
          } else {
            compBadge.textContent = `Count Diff (${file.itemCount} vs ${match.itemCount})`;
            compBadge.classList.add('comp-diff');
          }
        } else if (file.size === match.size) {
          compBadge.textContent = 'Match';
          compBadge.classList.add('comp-match');
        } else {
          compBadge.textContent = 'Size Diff';
          compBadge.classList.add('comp-diff');
        }
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

  // Column 3: Kind
  const kind = document.createElement('span');
  kind.className = 'file-kind';
  kind.textContent = getFileKind(file);
  kind.title = kind.textContent;

  // Column 4: Size
  const size = document.createElement('span');
  size.className = 'file-size';
  size.textContent = file.isDirectory ? '—' : formatFileSize(file.size);

  // Column 5: Date
  const date = document.createElement('span');
  date.className = 'file-date';
  date.textContent = formatDate(file.modified);

  // Column 6: Actions (Checkbox + Delete Button)
  const actionsCol = document.createElement('div');
  actionsCol.className = 'col-actions';

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'file-checkbox';
  checkbox.checked = selectionSet.has(file.fullPath);
  checkbox.title = 'Select file';
  checkbox.addEventListener('click', (e) => {
    e.stopPropagation();
    if (checkbox.checked) {
      selectionSet.add(file.fullPath);
    } else {
      selectionSet.delete(file.fullPath);
    }
    if (side === 'local') renderLocalFiles();
    else renderRemoteFiles();
    updateTransferButtons();
  });

  const rowDelBtn = document.createElement('button');
  rowDelBtn.className = 'file-row-delete-btn';
  rowDelBtn.textContent = '🗑️';
  rowDelBtn.title = `Delete ${file.name}`;
  rowDelBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    requestDeleteFiles([file], side);
  });

  actionsCol.appendChild(checkbox);
  actionsCol.appendChild(rowDelBtn);

  item.appendChild(icon);
  item.appendChild(nameContainer);
  item.appendChild(kind);
  item.appendChild(size);
  item.appendChild(date);
  item.appendChild(actionsCol);

  // --- Event Handlers ---

  // Single click — selection
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    handleFileClick(file, index, e, side);
  });

  // Double click — navigate into directories OR preview files
  item.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    if (file.isDirectory || file.isSymlink) {
      if (side === 'local') {
        loadLocalFiles(file.fullPath);
      } else {
        loadRemoteFiles(file.fullPath);
      }
    } else {
      openFilePreview(file, side);
    }
  });

  // Right-click — context menu
  item.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectionSet.has(file.fullPath)) {
      selectionSet.clear();
      selectionSet.add(file.fullPath);
      if (side === 'local') renderLocalFiles();
      else renderRemoteFiles();
    }
    showContextMenu(e, file, side);
  });

  // Drag-and-drop support (#15)
  if (window.__makeDraggable) window.__makeDraggable(item, side);

  return item;
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
  const btnDeleteLocal = document.getElementById('btn-delete-local');
  const btnDeleteRemote = document.getElementById('btn-delete-remote');

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

  if (btnDeleteLocal) {
    btnDeleteLocal.disabled = state.localSelected.size === 0 || state.isTransferring;
    btnDeleteLocal.innerHTML = state.localSelected.size > 0 ? `🗑️ Delete (${state.localSelected.size})` : '🗑️ Delete';
  }
  if (btnDeleteRemote) {
    btnDeleteRemote.disabled = state.remoteSelected.size === 0 || state.isTransferring;
    btnDeleteRemote.innerHTML = state.remoteSelected.size > 0 ? `🗑️ Delete (${state.remoteSelected.size})` : '🗑️ Delete';
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

    if (result && result.cancelled) {
      showToast(`Transfer cancelled — ${result.transferred} file(s) transferred`, 'info');
    } else if (result && result.success) {
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

    if (result && result.cancelled) {
      showToast(`Transfer cancelled — ${result.transferred} file(s) transferred`, 'info');
    } else if (result && result.success) {
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
    if (pullResult.cancelled) {
      showToast(`Transfer cancelled — ${pullResult.transferred} file(s) transferred`, 'info');
      return;
    }
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
    if (pushResult.cancelled) {
      showToast(`Transfer cancelled — ${pushResult.transferred} file(s) transferred`, 'info');
      return;
    }
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
    if (!file.isDirectory) {
      addItem('👁️ Preview File', () => openFilePreview(file, side));
    }
    addItem('✏️ Rename', () => promptRename(file, side));
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
    addItem('🗑️ Delete Selected', () => requestDeleteSelected('local'));
    addSeparator();
    addItem('Select All', () => selectAll('local'));
  } else {
    if (!file.isDirectory) {
      addItem('👁️ Preview File', () => openFilePreview(file, side));
    }
    addItem('✏️ Rename', () => promptRename(file, side));
    if (state.localSource !== state.remoteSource) {
      addItem(`Transfer to ${leftName}`, () => transferToMac());
    }
    addItem('🗑️ Delete Selected', () => requestDeleteSelected('remote'));
    if (state.remoteSource !== 'mac') {
      addItem('New Folder', () => promptNewRemoteFolder());
    }
    addSeparator();
    addItem('Select All', () => selectAll('remote'));
  }
}

async function openFilePreview(file, side) {
  if (!file || file.isDirectory) return;

  const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : '';
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'];
  const videoExts = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', '3gp'];

  if (!imageExts.includes(ext) && !videoExts.includes(ext)) {
    if (side === 'local' && state.localSource === 'mac') {
      if (window.droidBridge && window.droidBridge.openFilePath) {
        window.droidBridge.openFilePath(file.fullPath);
      } else if (window.droidBridge && window.droidBridge.openInFinder) {
        window.droidBridge.openInFinder(file.fullPath);
      }
    } else {
      showToast('Preview is supported for photos and videos', 'info');
    }
    return;
  }

  const isMacLocal = (side === 'local' && state.localSource === 'mac') || (side === 'remote' && state.remoteSource === 'mac');

  if (isMacLocal) {
    openMacPreviewUrl(file.name, `file://${encodeURI(file.fullPath)}`, ext);
  } else {
    const deviceId = side === 'local' ? state.localSource : state.remoteSource;
    showToast('Fetching preview from phone...', 'info');
    try {
      const tempPreviewPath = await window.droidBridge.fetchRemotePreview(deviceId, file.fullPath);
      if (tempPreviewPath) {
        openMacPreviewUrl(file.name, `file://${encodeURI(tempPreviewPath)}`, ext);
      } else {
        showToast('Failed to fetch file from phone for preview', 'error');
      }
    } catch (err) {
      showToast('Preview error: ' + (err.message || err), 'error');
    }
  }
}

function openMacPreviewUrl(fileName, fileUrl, ext) {
  const modal = document.getElementById('mac-preview-modal');
  const title = document.getElementById('mac-preview-title');
  const body = document.getElementById('mac-preview-body');

  if (!modal || !body) return;

  const existingMedia = body.querySelectorAll('video, audio');
  existingMedia.forEach(m => {
    try {
      m.pause();
      m.src = '';
      m.load();
    } catch(e) {}
  });

  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'bmp'];
  const videoExts = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', '3gp'];

  title.textContent = fileName;
  body.innerHTML = '';

  if (imageExts.includes(ext)) {
    const img = document.createElement('img');
    img.src = fileUrl;
    img.alt = fileName;
    body.appendChild(img);
    modal.style.display = 'flex';
    modal.classList.add('active');
  } else if (videoExts.includes(ext)) {
    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.src = fileUrl;
    body.appendChild(video);
    modal.style.display = 'flex';
    modal.classList.add('active');
  } else {
    showToast('Preview not available for this file type', 'info');
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
   TWO-STEP FILE DELETION (LOCAL & REMOTE)
   ====================================================================== */

let pendingDeleteTask = null; // { files: Array, side: 'local'|'remote' }

function requestDeleteSelected(side) {
  const selectionSet = side === 'local' ? state.localSelected : state.remoteSelected;
  const filesList = side === 'local' ? state.localFiles : state.remoteFiles;
  if (selectionSet.size === 0) return;

  const targetFileObjs = filesList.filter((f) => selectionSet.has(f.fullPath));
  if (targetFileObjs.length > 0) {
    requestDeleteFiles(targetFileObjs, side);
  }
}

function requestDeleteFiles(targetFiles, side) {
  if (!targetFiles || targetFiles.length === 0) return;
  pendingDeleteTask = { files: targetFiles, side };

  const modal = document.getElementById('delete-modal');
  const step1 = document.getElementById('delete-step-1');
  const step2 = document.getElementById('delete-step-2');
  const step1Msg = document.getElementById('delete-step1-msg');
  const previewList = document.getElementById('delete-file-preview-list');

  const isMac = (side === 'local' && state.localSource === 'mac') || (side === 'remote' && state.remoteSource === 'mac');

  if (step1Msg) {
    step1Msg.textContent =
      targetFiles.length === 1
        ? `Are you sure you want to delete "${targetFiles[0].name}"?`
        : `Are you sure you want to delete ${targetFiles.length} selected item(s)?`;
  }

  // Update Step 2 dynamic notice
  const step2Icon = document.getElementById('delete-step2-icon');
  const step2Title = document.getElementById('delete-step2-title');
  const step2Bold = document.getElementById('delete-step2-bold');
  const step2Sub = document.getElementById('delete-step2-sub');
  const btnFinal = document.getElementById('btn-confirm-delete-final');

  if (isMac) {
    if (step2Icon) step2Icon.textContent = '🗑️';
    if (step2Title) {
      step2Title.textContent = 'MOVE TO MAC TRASH';
      step2Title.style.color = 'var(--text-primary)';
    }
    if (step2Bold) {
      step2Bold.textContent = 'ℹ️ Note: Selected Mac items will be moved to your macOS Trash (Bin).';
      step2Bold.style.color = '#a29bfe';
    }
    if (step2Sub) step2Sub.textContent = 'You can easily restore these items from your Trash bin anytime if needed.';
    if (btnFinal) {
      btnFinal.textContent = '🗑️ Move to Trash';
      btnFinal.className = 'modal-btn warning';
    }
  } else {
    if (step2Icon) step2Icon.textContent = '🚨';
    if (step2Title) {
      step2Title.textContent = 'PERMANENT DELETION WARNING';
      step2Title.style.color = '#e17055';
    }
    if (step2Bold) {
      step2Bold.textContent = '⚠️ Warning: Selected Android items will be PERMANENTLY deleted from your phone.';
      step2Bold.style.color = '#fdcb6e';
    }
    if (step2Sub) step2Sub.textContent = 'Once deleted over USB, these files CANNOT be recovered or restored!';
    if (btnFinal) {
      btnFinal.textContent = '🗑️ Yes, Delete Permanently';
      btnFinal.className = 'modal-btn danger';
    }
  }

  if (previewList) {
    previewList.innerHTML = '';
    targetFiles.slice(0, 30).forEach((f) => {
      const div = document.createElement('div');
      div.className = 'delete-preview-item';
      div.textContent = `${f.isDirectory ? '📁' : '📄'} ${f.name}`;
      previewList.appendChild(div);
    });
    if (targetFiles.length > 30) {
      const div = document.createElement('div');
      div.className = 'delete-preview-item';
      div.style.fontStyle = 'italic';
      div.style.opacity = '0.7';
      div.textContent = `...and ${targetFiles.length - 30} more item(s)`;
      previewList.appendChild(div);
    }
  }

  if (step1) step1.style.display = 'flex';
  if (step2) step2.style.display = 'none';
  if (modal) modal.classList.add('active');
}

function closeDeleteModal() {
  const modal = document.getElementById('delete-modal');
  if (modal) modal.classList.remove('active');
  pendingDeleteTask = null;
}

async function executePendingDelete() {
  if (!pendingDeleteTask || !pendingDeleteTask.files || pendingDeleteTask.files.length === 0) return;
  const { files, side } = pendingDeleteTask;
  closeDeleteModal();

  const isMac = (side === 'local' && state.localSource === 'mac') || (side === 'remote' && state.remoteSource === 'mac');

  let successCount = 0;
  let failCount = 0;

  for (const file of files) {
    try {
      if (side === 'local' && state.localSource === 'mac') {
        const res = await window.droidBridge.deleteLocal(file.fullPath);
        if (res && res.success) successCount++;
        else failCount++;
      } else if (side === 'remote' && state.remoteSource === 'mac') {
        const res = await window.droidBridge.deleteLocal(file.fullPath);
        if (res && res.success) successCount++;
        else failCount++;
      } else {
        const deviceId = side === 'local' ? state.localSource : state.remoteSource;
        const res = await window.droidBridge.deleteRemote(deviceId, file.fullPath);
        if (res && res.success) successCount++;
        else failCount++;
      }
    } catch (err) {
      console.error('Delete error:', err);
      failCount++;
    }
  }

  if (side === 'local') {
    state.localSelected.clear();
    await loadLocalFiles(state.localPath);
  } else {
    state.remoteSelected.clear();
    await loadRemoteFiles(state.remotePath);
    if (state.remoteSource !== 'mac') {
      loadStorageInfo();
    }
  }
  updateTransferButtons();

  if (failCount === 0) {
    if (isMac) {
      showToast(`Moved ${successCount} item(s) to macOS Trash (Bin)`, 'success');
    } else {
      showToast(`Successfully deleted ${successCount} item(s)`, 'success');
    }
  } else if (successCount > 0) {
    showToast(`Processed ${successCount} item(s), failed on ${failCount} item(s)`, 'warning');
  } else {
    showToast(`Failed to delete selected item(s)`, 'error');
  }
}

async function promptNewRemoteFolder() {
  const name = await showInputModal('New Folder', 'Folder name:', '');
  if (!name || !name.trim()) return;
  createRemoteFolder(name.trim());
}

async function promptRename(file, side) {
  if (!file) return;
  const newName = await showInputModal('Rename', 'New name:', file.name);
  if (!newName || !newName.trim() || newName.trim() === file.name) return;
  const trimmed = newName.trim();
  try {
    let result;
    const isMac = (side === 'local' && state.localSource === 'mac') || (side === 'remote' && state.remoteSource === 'mac');
    if (isMac) {
      result = await window.droidBridge.renameLocal(file.fullPath, trimmed);
    } else {
      const deviceId = side === 'local' ? state.localSource : state.remoteSource;
      result = await window.droidBridge.renameRemote(deviceId, file.fullPath, trimmed);
    }
    if (result.success) {
      showToast(`Renamed to "${trimmed}"`, 'success');
      if (side === 'local') await loadLocalFiles(state.localPath);
      else await loadRemoteFiles(state.remotePath);
    } else {
      showToast('Rename failed: ' + (result.error || 'unknown error'), 'error');
    }
  } catch (err) {
    showToast('Rename failed: ' + (err.message || err), 'error');
  }
}

/* ======================================================================
   SHARED INPUT MODAL (replaces window.prompt which is disabled in Electron)
   ====================================================================== */

let _inputModalResolve = null;

function showInputModal(title, label, defaultValue) {
  return new Promise((resolve) => {
    const overlay = document.getElementById('input-modal');
    const titleEl = document.getElementById('input-modal-title');
    const labelEl = document.getElementById('input-modal-label');
    const field = document.getElementById('input-modal-field');
    const btnConfirm = document.getElementById('btn-input-confirm');
    const btnCancel = document.getElementById('btn-input-cancel');
    const btnClose = document.getElementById('btn-close-input-modal');

    if (!overlay || !field) { resolve(null); return; }

    if (titleEl) titleEl.textContent = title || 'Input';
    if (labelEl) labelEl.textContent = label || '';
    field.value = defaultValue || '';

    _inputModalResolve = resolve;
    overlay.style.display = 'flex';

    // Focus + select after the modal is visible
    setTimeout(() => { field.focus(); field.select(); }, 50);

    // Clean up previous listeners by cloning
    const newConfirm = btnConfirm.cloneNode(true);
    const newCancel = btnCancel.cloneNode(true);
    const newClose = btnClose.cloneNode(true);
    btnConfirm.replaceWith(newConfirm);
    btnCancel.replaceWith(newCancel);
    btnClose.replaceWith(newClose);

    function close(value) {
      overlay.style.display = 'none';
      _inputModalResolve = null;
      newConfirm.replaceWith(newConfirm); // no-op, just keep ref
      resolve(value);
    }

    newConfirm.addEventListener('click', () => close(field.value));
    newCancel.addEventListener('click', () => close(null));
    newClose.addEventListener('click', () => close(null));

    field.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); close(field.value); }
      if (e.key === 'Escape') { e.preventDefault(); close(null); }
    };

    overlay.onclick = (e) => {
      if (e.target === overlay) close(null);
    };
  });
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
    clearRemoteThumbQueue();
    clearLocalThumbQueue();
    state.localSearchQuery = '';
    const localSearchInput = document.getElementById('local-search');
    if (localSearchInput) localSearchInput.value = '';

    const container = document.getElementById('local-file-list');
    if (container) {
      container.innerHTML = '<div class="empty-dir"><div class="spinner"></div><div class="empty-dir-text">Loading folder...</div></div>';
    }

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
    // Persist last local path (#17)
    if (state.localSource === 'mac' && window.droidBridge.setSettings) {
      window.droidBridge.setSettings({ lastLocalPath: state.localPath }).catch(() => {});
    }
  } catch (err) {
    showToast('Failed to list files: ' + (err.message || err), 'error');
    console.error('loadLocalFiles error:', err);
  }
}

const localThumbQueue = [];
let activeLocalThumbWorkers = 0;
const MAX_LOCAL_THUMB_WORKERS = 4;

function clearLocalThumbQueue() {
  localThumbQueue.length = 0;
}

function queueLocalThumbnail(filePath, callback) {
  localThumbQueue.push({ filePath, callback });
  processLocalThumbQueue();
}

function processLocalThumbQueue() {
  while (activeLocalThumbWorkers < MAX_LOCAL_THUMB_WORKERS && localThumbQueue.length > 0) {
    const task = localThumbQueue.shift();
    activeLocalThumbWorkers++;
    (async () => {
      try {
        if (window.droidBridge && window.droidBridge.getLocalThumbnail) {
          const thumbDataUrl = await window.droidBridge.getLocalThumbnail(task.filePath);
          if (thumbDataUrl) {
            task.callback(thumbDataUrl);
          }
        }
      } catch (err) {
        console.warn('Local thumbnail queue error:', err);
      } finally {
        activeLocalThumbWorkers--;
        processLocalThumbQueue();
      }
    })();
  }
}

const remoteThumbQueue = [];
let activeRemoteThumbWorkers = 0;
const MAX_REMOTE_THUMB_WORKERS = 4;

function clearRemoteThumbQueue() {
  remoteThumbQueue.length = 0;
}

function queueRemoteThumbnail(deviceId, remotePath, callback) {
  remoteThumbQueue.push({ deviceId, remotePath, callback });
  processRemoteThumbQueue();
}

function processRemoteThumbQueue() {
  while (activeRemoteThumbWorkers < MAX_REMOTE_THUMB_WORKERS && remoteThumbQueue.length > 0) {
    const task = remoteThumbQueue.shift();
    activeRemoteThumbWorkers++;
    (async () => {
      try {
        if (window.droidBridge && window.droidBridge.getRemoteThumbnail) {
          const thumbDataUrl = await window.droidBridge.getRemoteThumbnail(task.deviceId, task.remotePath);
          if (thumbDataUrl) {
            task.callback(thumbDataUrl);
          }
        }
      } catch (err) {
        console.warn('Remote thumbnail queue error:', err);
      } finally {
        activeRemoteThumbWorkers--;
        processRemoteThumbQueue();
      }
    })();
  }
}

async function loadRemoteFiles(dirPath) {
  try {
    clearRemoteThumbQueue();
    clearLocalThumbQueue();
    state.remoteSearchQuery = '';
    const remoteSearchInput = document.getElementById('remote-search');
    if (remoteSearchInput) remoteSearchInput.value = '';

    const container = document.getElementById('remote-file-list');
    if (container) {
      container.innerHTML = '<div class="empty-dir"><div class="spinner"></div><div class="empty-dir-text">Loading folder...</div></div>';
    }

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
    result = result || { currentPath: dirPath, files: [] };
    state.remotePath = result.currentPath || dirPath;
    state.remoteFiles = result.files || [];
    state.remoteSelected.clear();
    state.lastClickedRemote = null;
    renderRemoteFiles();
    renderRemoteBreadcrumb();
    updateTransferButtons();
    // Persist last remote path (#17)
    if (state.remoteSource !== 'mac' && window.droidBridge.setSettings) {
      window.droidBridge.setSettings({ lastRemotePath: state.remotePath }).catch(() => {});
    }
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
        showToast('USB Debugging not authorized. Check your phone for the "Allow USB debugging?" prompt and tap Allow.', 'warning');
      }
    }

    // Check if connected devices list actually changed
    const prevDeviceKey = state.devices.map(d => `${d.id}:${d.status}`).join('|');
    const currDeviceKey = updatedDevices.map(d => `${d.id}:${d.status}`).join('|');
    const devicesChanged = prevDeviceKey !== currDeviceKey;

    state.devices = updatedDevices;

    const btnStartUsbTransfer = document.getElementById('btn-start-usb-transfer');
    const usbStatusHint = document.getElementById('usb-status-hint');

    // Check if we need to show the "no-device" overlay
    if (state.devices.length === 0) {
      showScreen('no-device-screen');
      if (btnStartUsbTransfer) {
        btnStartUsbTransfer.disabled = true;
        btnStartUsbTransfer.title = 'Connect phone via USB to enable USB transfer';
      }
      if (usbStatusHint) {
        usbStatusHint.textContent = '🔌 Connect Android phone via USB to enable USB transfer, or click Wi-Fi mode anytime';
      }
      state.localSource = 'mac';
      state.remoteSource = '';
      state.remoteFiles = [];
      const remoteContainer = document.getElementById('remote-file-list');
      if (remoteContainer) {
        remoteContainer.innerHTML = '<div class="empty-dir">No device connected</div>';
      }
      const remoteBreadcrumb = document.getElementById('remote-breadcrumb');
      if (remoteBreadcrumb) {
        remoteBreadcrumb.innerHTML = '';
      }
    } else {
      if (btnStartUsbTransfer) {
        btnStartUsbTransfer.disabled = false;
        btnStartUsbTransfer.title = 'Click to open USB File Manager';
      }
      if (usbStatusHint) {
        const hasUnauthorized = state.devices.some(d => d.status === 'unauthorized');
        if (hasUnauthorized) {
          usbStatusHint.innerHTML = '⚠️ <strong>USB Debugging not authorized.</strong> Look for the "Allow USB debugging?" dialog on your phone, check "Always allow from this computer", and tap <strong>Allow</strong>. Then reconnect the USB cable.';
        } else {
          const devText = state.devices.length > 1 
            ? 'Multiple Android devices' 
            : (state.devices[0]?.model || 'Android Phone');
          const devName = escapeHtml(devText);
          usbStatusHint.innerHTML = `✅ <strong>${devName} connected via USB!</strong> Click ⚡ Continue with USB Transfer or Wi-Fi mode`;
        }
      }
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

    // Only update dropdowns and reload file panels IF devices list actually changed or on initial load
    if (devicesChanged || !state.localPath || !state.remotePathLoaded) {
      state.remotePathLoaded = true;
      updateSourceDropdowns();
      updateDeviceBar();
      loadStorageInfo();

      if (!state.localPath) {
        const homeDir = await window.droidBridge.getHomeDir();
        await loadLocalFiles(homeDir || '/');
      }

      if (!state.remotePath) {
        state.remotePath = '/sdcard';
      }

      if (state.remoteSource && state.remoteSource !== 'mac') {
        await loadRemoteFiles(state.remotePath);
      }
    }

  } catch (err) {
    console.error('Error refreshing devices list:', err);
  }
}

function updateSourceDropdowns() {
  const leftSelect = document.getElementById('left-source-select');
  const rightSelect = document.getElementById('right-source-select');
  if (!leftSelect || !rightSelect) return;

  const leftVal = leftSelect.value || 'mac';
  const rightVal = rightSelect.value;

  // Clear options
  leftSelect.innerHTML = '';
  rightSelect.innerHTML = '';

  // Add Mac option for left
  const optMacLeft = document.createElement('option');
  optMacLeft.value = 'mac';
  optMacLeft.textContent = '💻 macOS Filesystem';
  leftSelect.appendChild(optMacLeft);

  if (state.devices.length === 0) {
    const optNoDev = document.createElement('option');
    optNoDev.value = '';
    optNoDev.textContent = '📱 No Device Connected';
    optNoDev.disabled = true;
    rightSelect.appendChild(optNoDev);

    const optMacRight = document.createElement('option');
    optMacRight.value = 'mac';
    optMacRight.textContent = '💻 macOS Filesystem';
    rightSelect.appendChild(optMacRight);

    if (rightVal === 'mac') {
      rightSelect.value = 'mac';
    } else {
      rightSelect.value = '';
    }
  } else {
    const optMacRight = document.createElement('option');
    optMacRight.value = 'mac';
    optMacRight.textContent = '💻 macOS Filesystem';
    rightSelect.appendChild(optMacRight);

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

    const hasRight = (rightVal === 'mac' || state.devices.some(d => d.id === rightVal)) && rightVal !== '';
    if (hasRight) {
      rightSelect.value = rightVal;
    } else {
      rightSelect.value = state.devices[0].id;
    }
  }

  const hasLeft = leftVal === 'mac' || state.devices.some(d => d.id === leftVal);
  leftSelect.value = hasLeft ? leftVal : 'mac';

  state.localSource = leftSelect.value;
  state.remoteSource = rightSelect.value;
}

function handleTransferProgress(progress) {
  if (!progress) return;
  const fill = document.querySelector('#transfer-overlay .progress-bar-fill');
  const pct = document.getElementById('progress-percent');
  const fname = document.getElementById('progress-filename');
  const etaEl = document.getElementById('progress-speed-eta');

  const percent = Math.max(0, Math.min(100, progress.percent || 0));
  if (fill) fill.style.width = percent + '%';
  if (pct) pct.textContent = percent + '%';
  if (fname) {
    const fileLabel = progress.fileName || '';
    const progressLabel = (progress.total > 1 && progress.current) ? ` (${progress.current}/${progress.total})` : '';
    fname.textContent = fileLabel + progressLabel;
  }

  // Speed / ETA estimation from the smooth overall percent value.
  if (etaEl) {
    if (percent >= 100) {
      const elapsed = (Date.now() - transferStartTime) / 1000;
      etaEl.textContent = `Completed in ${formatEta(elapsed)}`;
    } else if (percent > 0 && transferStartTime > 0) {
      const elapsed = (Date.now() - transferStartTime) / 1000;
      if (elapsed > 0.5) {
        const rate = percent / elapsed;        // percent per second
        const remaining = 100 - percent;
        const eta = remaining / rate;            // seconds
        // Exponential moving average to smooth jitter as files start/finish.
        transferEtaEma = transferEtaEma === 0 ? eta : transferEtaEma * 0.7 + eta * 0.3;
        etaEl.textContent = `~${formatEta(transferEtaEma)} remaining`;
      }
    }
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
      }, 100),
    );
  }

  if (remoteSearch) {
    remoteSearch.addEventListener(
      'input',
      debounce((e) => {
        state.remoteSearchQuery = e.target.value;
        renderRemoteFiles();
      }, 100),
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

    // Delete / Backspace — delete selected files in active panel
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
      e.preventDefault();
      requestDeleteSelected(state.activePanel);
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
        pendingScrollIndex.local = nextIndex;
        renderLocalFiles();
      } else {
        pendingScrollIndex.remote = nextIndex;
        renderRemoteFiles();
      }
      updateTransferButtons();

      // Scroll the selected item into view (fine-tune after virtual render)
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

  // Cancel transfer button
  const btnCancelTransfer = document.getElementById('btn-cancel-transfer');
  if (btnCancelTransfer) {
    btnCancelTransfer.addEventListener('click', async () => {
      btnCancelTransfer.disabled = true;
      btnCancelTransfer.textContent = 'Cancelling...';
      const etaEl = document.getElementById('progress-speed-eta');
      if (etaEl) etaEl.textContent = 'Cancelling...';
      try {
        await window.droidBridge.cancelTransfer();
      } catch (err) {
        console.error('Cancel transfer failed:', err);
      }
    });
  }

  // Pause / Resume transfer button
  const btnPauseTransfer = document.getElementById('btn-pause-transfer');
  let transferPaused = false;
  if (btnPauseTransfer) {
    btnPauseTransfer.addEventListener('click', async () => {
      try {
        if (!transferPaused) {
          const result = await window.droidBridge.pauseTransfer();
          if (result && result.success) {
            transferPaused = true;
            btnPauseTransfer.textContent = '▶ Resume';
            btnPauseTransfer.classList.add('paused');
            const etaEl = document.getElementById('progress-speed-eta');
            if (etaEl) etaEl.textContent = '⏸ Paused';
          }
        } else {
          const result = await window.droidBridge.resumeTransfer();
          if (result && result.success) {
            transferPaused = false;
            btnPauseTransfer.textContent = '⏸ Pause';
            btnPauseTransfer.classList.remove('paused');
            const etaEl = document.getElementById('progress-speed-eta');
            if (etaEl) etaEl.textContent = '';
            transferStartTime = Date.now() - (transferEtaEma * 1000); // adjust start time
          }
        }
      } catch (err) {
        console.error('Pause/resume failed:', err);
      }
    });
  }

  // Delete buttons
  const btnDeleteLocal = document.getElementById('btn-delete-local');
  const btnDeleteRemote = document.getElementById('btn-delete-remote');
  if (btnDeleteLocal) btnDeleteLocal.addEventListener('click', () => requestDeleteSelected('local'));
  if (btnDeleteRemote) btnDeleteRemote.addEventListener('click', () => requestDeleteSelected('remote'));

  // Header select-all checkboxes
  const localSelectAll = document.getElementById('local-select-all');
  const remoteSelectAll = document.getElementById('remote-select-all');

  if (localSelectAll) {
    localSelectAll.addEventListener('change', (e) => {
      const visibleFiles = getFilteredFiles(state.localFiles, state.localSearchQuery);
      if (e.target.checked) {
        visibleFiles.forEach((f) => state.localSelected.add(f.fullPath));
      } else {
        state.localSelected.clear();
      }
      renderLocalFiles();
      updateTransferButtons();
    });
  }

  if (remoteSelectAll) {
    remoteSelectAll.addEventListener('change', (e) => {
      const visibleFiles = getFilteredFiles(state.remoteFiles, state.remoteSearchQuery);
      if (e.target.checked) {
        visibleFiles.forEach((f) => state.remoteSelected.add(f.fullPath));
      } else {
        state.remoteSelected.clear();
      }
      renderRemoteFiles();
      updateTransferButtons();
    });
  }

  // Two-step Delete modal handlers
  const btnCloseDelete = document.getElementById('btn-close-delete');
  const btnCancelDelete1 = document.getElementById('btn-cancel-delete-1');
  const btnNextDelete1 = document.getElementById('btn-next-delete-1');
  const btnCancelDelete2 = document.getElementById('btn-cancel-delete-2');
  const btnConfirmDeleteFinal = document.getElementById('btn-confirm-delete-final');
  const deleteModal = document.getElementById('delete-modal');

  if (btnCloseDelete) btnCloseDelete.addEventListener('click', closeDeleteModal);
  if (btnCancelDelete1) btnCancelDelete1.addEventListener('click', closeDeleteModal);
  if (btnCancelDelete2) btnCancelDelete2.addEventListener('click', closeDeleteModal);

  if (deleteModal) {
    deleteModal.addEventListener('click', (e) => {
      if (e.target === deleteModal) closeDeleteModal();
    });
  }

  if (btnNextDelete1) {
    btnNextDelete1.addEventListener('click', () => {
      const step1 = document.getElementById('delete-step-1');
      const step2 = document.getElementById('delete-step-2');
      if (step1) step1.style.display = 'none';
      if (step2) step2.style.display = 'flex';
    });
  }

  if (btnConfirmDeleteFinal) {
    btnConfirmDeleteFinal.addEventListener('click', () => {
      executePendingDelete();
    });
  }

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

  // USB Transfer click handler
  const btnStartUsbTransfer = document.getElementById('btn-start-usb-transfer');
  if (btnStartUsbTransfer) {
    btnStartUsbTransfer.addEventListener('click', () => {
      if (state.devices.length > 0) {
        hideScreen('no-device-screen');
        showToast(`Opened USB File Manager for ${state.devices[0].model}`, 'success');
      } else {
        showToast('Please connect your Android phone via USB cable first', 'warning');
      }
    });
  }

  // Wi-Fi click handlers
  const btnStartWifiSetup = document.getElementById('btn-start-wifi-setup');
  const btnStopWifi = document.getElementById('btn-stop-wifi');
  const btnCopyWifiUrl = document.getElementById('btn-copy-wifi-url');
  const btnCopyWifiToken = document.getElementById('btn-copy-wifi-token');
  const btnOpenWifiDir = document.getElementById('btn-open-wifi-dir');

  if (btnStartWifiSetup) {
    btnStartWifiSetup.addEventListener('click', async () => {
      try {
        const result = await window.droidBridge.startWifiServer();
        if (result && result.success) {
          const qrImg = document.getElementById('wifi-qr-code');
          const urlInput = document.getElementById('wifi-url-text');
          const tokenText = document.getElementById('wifi-token-text');
          const sharedPath = document.getElementById('wifi-shared-path');

          if (qrImg) qrImg.src = result.qrCode;
          if (urlInput) urlInput.value = `http://${result.ip}:${result.port}/?token=${result.token}`;
          if (tokenText) tokenText.textContent = result.token || '—';
          if (sharedPath) {
            sharedPath.textContent = result.sharedDir;
            sharedPath.title = result.sharedDir;
          }
          state.wifiSharedDir = result.sharedDir;
          state.wifiPort = result.port;
          state.wifiToken = result.token;
          hideScreen('no-device-screen');
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
            state.wifiSharedDir = res.sharedDir;
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
        if (state.devices.length === 0) {
          showScreen('no-device-screen');
        }
        showToast('Wi-Fi Server stopped', 'info');
      } catch (err) {
        showToast('Error stopping Wi-Fi server: ' + (err.message || err), 'error');
      }
    });
  }

  if (btnCopyWifiUrl) {
    btnCopyWifiUrl.addEventListener('click', async () => {
      const urlInput = document.getElementById('wifi-url-text');
      if (urlInput) {
        const text = urlInput.value;
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(text);
          } else if (window.droidBridge.copyToClipboard) {
            await window.droidBridge.copyToClipboard(text);
          }
          showToast('Link copied to clipboard!', 'success');
        } catch (err) {
          if (window.droidBridge.copyToClipboard) {
            await window.droidBridge.copyToClipboard(text);
            showToast('Link copied to clipboard!', 'success');
          } else {
            showToast('Copy failed', 'error');
          }
        }
      }
    });
  }

  if (btnCopyWifiToken) {
    btnCopyWifiToken.addEventListener('click', async () => {
      const tokenText = document.getElementById('wifi-token-text');
      const token = tokenText ? tokenText.textContent : '';
      if (token && token !== '—') {
        try {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            await navigator.clipboard.writeText(token);
          } else if (window.droidBridge.copyToClipboard) {
            await window.droidBridge.copyToClipboard(token);
          }
          showToast('Access token copied to clipboard!', 'success');
        } catch (err) {
          if (window.droidBridge.copyToClipboard) {
            await window.droidBridge.copyToClipboard(token);
            showToast('Access token copied to clipboard!', 'success');
          } else {
            showToast('Copy failed', 'error');
          }
        }
      }
    });
  }

  const btnCloseMacPreview = document.getElementById('btn-close-mac-preview');
  if (btnCloseMacPreview) {
    btnCloseMacPreview.addEventListener('click', closeMacPreview);
  }
  const macModal = document.getElementById('mac-preview-modal');
  if (macModal) {
    macModal.addEventListener('click', (e) => {
      if (e.target === macModal) closeMacPreview();
    });
  }

  if (btnOpenWifiDir) {
    btnOpenWifiDir.addEventListener('click', () => {
      window.droidBridge.openWifiSharedDir();
    });
  }

  // --- Settings modal (#18) ---
  const btnSettings = document.getElementById('btn-settings');
  const btnCloseSettings = document.getElementById('btn-close-settings');
  const btnSaveSettings = document.getElementById('btn-save-settings');
  const btnCheckUpdates = document.getElementById('btn-check-updates');
  const settingsOverlay = document.getElementById('settings-overlay');

  if (btnSettings) {
    btnSettings.addEventListener('click', async () => {
      const s = await window.droidBridge.getSettings();
      const repoInput = document.getElementById('settings-update-repo');
      const portInput = document.getElementById('settings-wifi-port');
      if (repoInput) repoInput.value = s.updateRepo || '';
      if (portInput) portInput.value = s.wifiPort || '';
      const updateStatus = document.getElementById('update-status');
      if (updateStatus) updateStatus.textContent = '';
      if (settingsOverlay) settingsOverlay.style.display = 'flex';
    });
  }
  if (btnCloseSettings) {
    btnCloseSettings.addEventListener('click', () => {
      if (settingsOverlay) settingsOverlay.style.display = 'none';
    });
  }
  if (settingsOverlay) {
    settingsOverlay.addEventListener('click', (e) => {
      if (e.target === settingsOverlay) settingsOverlay.style.display = 'none';
    });
  }
  if (btnSaveSettings) {
    btnSaveSettings.addEventListener('click', async () => {
      const repoInput = document.getElementById('settings-update-repo');
      const portInput = document.getElementById('settings-wifi-port');
      const partial = {};
      if (repoInput) partial.updateRepo = repoInput.value.trim();
      if (portInput && portInput.value) partial.wifiPort = parseInt(portInput.value, 10);
      await window.droidBridge.setSettings(partial);
      showToast('Settings saved', 'success');
    });
  }
  if (btnCheckUpdates) {
    btnCheckUpdates.addEventListener('click', async () => {
      const updateStatus = document.getElementById('update-status');
      if (updateStatus) {
        updateStatus.textContent = 'Checking for updates...';
        updateStatus.className = 'update-status';
      }
      try {
        const result = await window.droidBridge.checkForUpdates();
        if (!result.success) {
          if (updateStatus) {
            updateStatus.textContent = result.error || 'Failed to check for updates';
            updateStatus.className = 'update-status error';
          }
          return;
        }
        if (result.hasUpdate) {
          if (updateStatus) {
            updateStatus.innerHTML = `New version ${result.latestVersion} available! (Current: ${result.currentVersion})<br><a href="${result.downloadUrl}" target="_blank" style="color: var(--primary-light);">View release →</a>`;
            updateStatus.className = 'update-status has-update';
          }
        } else {
          if (updateStatus) {
            updateStatus.textContent = `You're up to date! (v${result.currentVersion})`;
            updateStatus.className = 'update-status up-to-date';
          }
        }
      } catch (err) {
        if (updateStatus) {
          updateStatus.textContent = 'Error: ' + (err.message || err);
          updateStatus.className = 'update-status error';
        }
      }
    });
  }

  // --- History modal (#13) ---
  const btnHistory = document.getElementById('btn-history');
  const btnCloseHistory = document.getElementById('btn-close-history');
  const btnClearHistory = document.getElementById('btn-clear-history');
  const historyOverlay = document.getElementById('history-overlay');

  if (btnHistory) {
    btnHistory.addEventListener('click', async () => {
      await loadTransferHistory();
      if (historyOverlay) historyOverlay.style.display = 'flex';
    });
  }
  if (btnCloseHistory) {
    btnCloseHistory.addEventListener('click', () => {
      if (historyOverlay) historyOverlay.style.display = 'none';
    });
  }
  if (historyOverlay) {
    historyOverlay.addEventListener('click', (e) => {
      if (e.target === historyOverlay) historyOverlay.style.display = 'none';
    });
  }
  if (btnClearHistory) {
    btnClearHistory.addEventListener('click', async () => {
      await window.droidBridge.clearTransferHistory();
      await loadTransferHistory();
      showToast('History cleared', 'success');
    });
  }

  // Toggle compact / detailed history view (#13)
  const btnHistoryScale = document.getElementById('btn-history-scale');
  let historyDetailed = false;
  if (btnHistoryScale) {
    btnHistoryScale.addEventListener('click', () => {
      historyDetailed = !historyDetailed;
      const modalCard = historyOverlay ? historyOverlay.querySelector('.history-modal') : null;
      const listEl = document.getElementById('history-list');
      if (historyDetailed) {
        if (modalCard) modalCard.classList.add('detailed');
        if (listEl) listEl.classList.add('detailed');
        btnHistoryScale.textContent = '📏 Detailed';
      } else {
        if (modalCard) modalCard.classList.remove('detailed');
        if (listEl) listEl.classList.remove('detailed');
        btnHistoryScale.textContent = '📏 Compact';
      }
    });
  }

  // --- Drag-and-drop between panels (#15) ---
  setupDragAndDrop();

  // --- Virtual scroll listeners (#10) ---
  const localListEl = document.getElementById('local-file-list');
  const remoteListEl = document.getElementById('remote-file-list');
  if (localListEl) localListEl.addEventListener('scroll', () => renderVisibleRows('local'));
  if (remoteListEl) remoteListEl.addEventListener('scroll', () => renderVisibleRows('remote'));
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

    // Track which remote files have been matched to avoid double-counting uniques
    const remoteMatched = new Set();

    state.localFiles.forEach(lf => {
      const match = state.remoteFiles.find(rf => rf.name.toLowerCase() === lf.name.toLowerCase());
      if (match) {
        remoteMatched.add(match.name.toLowerCase());
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

    // Only count remote files that had no match on the local side
    state.remoteFiles.forEach(rf => {
      if (!remoteMatched.has(rf.name.toLowerCase())) {
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
   TRANSFER HISTORY LOADER (#13)
   ====================================================================== */

async function loadTransferHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;
  try {
    const history = await window.droidBridge.getTransferHistory();
    if (!history || history.length === 0) {
      list.innerHTML = '<div class="history-empty">No transfers yet.</div>';
      return;
    }
    list.innerHTML = '';
    history.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'history-item';
      let dir, dirLabel, path;
      if (entry.direction === 'wifi-upload') {
        dir = '📶';
        dirLabel = 'Wi-Fi Upload';
        path = entry.fileName || '';
      } else if (entry.direction === 'push') {
        dir = '📤';
        dirLabel = 'Mac → Phone';
        path = entry.remotePath || '';
      } else {
        dir = '📥';
        dirLabel = 'Phone → Mac';
        path = entry.localPath || '';
      }
      const date = new Date(entry.timestamp);
      const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
        date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
      const sizeStr = entry.fileSize ? ' · ' + formatFileSize(entry.fileSize) : '';
      const metaStr = dateStr + sizeStr + (entry.failed > 0 ? ' · ' + entry.failed + ' failed' : '');

      // Extra details shown in detailed view (client IP, etc.)
      let extraHtml = '';
      if (entry.clientIp) {
        extraHtml += `<div class="history-extra">IP: ${escapeHtml(entry.clientIp)}</div>`;
      }
      if (entry.deviceId) {
        extraHtml += `<div class="history-extra">Device: ${escapeHtml(entry.deviceId)}</div>`;
      }

      item.innerHTML =
        `<div class="history-top-row">` +
        `<span class="history-dir">${dir}</span>` +
        `<div class="history-info">` +
        `<div class="history-path">${escapeHtml(dirLabel)} → ${escapeHtml(path)}</div>` +
        `<div class="history-meta">${metaStr}</div>` +
        extraHtml +
        `</div>` +
        `<span class="history-count">${entry.fileCount} file(s)</span>` +
        `</div>`;
      list.appendChild(item);
    });
  } catch (err) {
    console.error('Failed to load history:', err);
  }
}

/* ======================================================================
   DRAG AND DROP BETWEEN PANELS (#15)
   ====================================================================== */

function setupDragAndDrop() {
  const localList = document.getElementById('local-file-list');
  const remoteList = document.getElementById('remote-file-list');

  function makeDraggable(itemEl, side) {
    itemEl.draggable = true;
    itemEl.addEventListener('dragstart', (e) => {
      const selectionSet = side === 'local' ? state.localSelected : state.remoteSelected;
      const paths = [...selectionSet];
      if (paths.length === 0 && itemEl.dataset.fullPath) paths.push(itemEl.dataset.fullPath);
      e.dataTransfer.setData('text/plain', JSON.stringify({ side, paths }));
      e.dataTransfer.effectAllowed = 'copy';
    });
  }

  function makeDropTarget(listEl, targetSide) {
    listEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    listEl.addEventListener('drop', async (e) => {
      e.preventDefault();
      try {
        const data = JSON.parse(e.dataTransfer.getData('text/plain'));
        if (data.side === targetSide) return; // Can't drop on same panel
        const paths = data.paths;
        if (!paths || paths.length === 0) return;

        if (data.side === 'local' && targetSide === 'remote') {
          if (state.localSource === state.remoteSource) return;
          if (state.remoteSource !== 'mac' && state.localSource === 'mac') {
            setTransferOverlay(true);
            const result = await window.droidBridge.pushFiles(state.remoteSource, paths, state.remotePath);
            setTransferOverlay(false);
            if (result && result.success) showToast(`Transferred ${result.transferred} file(s)`, 'success');
            else if (result) showToast('Transfer failed', 'error');
            await loadRemoteFiles(state.remotePath);
          } else if (state.localSource !== 'mac' && state.remoteSource === 'mac') {
            setTransferOverlay(true);
            const result = await window.droidBridge.pullFiles(state.localSource, paths, state.localPath);
            setTransferOverlay(false);
            if (result && result.success) showToast(`Transferred ${result.transferred} file(s)`, 'success');
            else if (result) showToast('Transfer failed', 'error');
            await loadLocalFiles(state.localPath);
          }
        } else if (data.side === 'remote' && targetSide === 'local') {
          if (state.localSource === state.remoteSource) return;
          if (state.remoteSource !== 'mac' && state.localSource === 'mac') {
            setTransferOverlay(true);
            const result = await window.droidBridge.pullFiles(state.remoteSource, paths, state.localPath);
            setTransferOverlay(false);
            if (result && result.success) showToast(`Transferred ${result.transferred} file(s)`, 'success');
            else if (result) showToast('Transfer failed', 'error');
            await loadLocalFiles(state.localPath);
          } else if (state.remoteSource === 'mac' && state.localSource !== 'mac') {
            setTransferOverlay(true);
            const result = await window.droidBridge.pushFiles(state.localSource, paths, state.localPath);
            setTransferOverlay(false);
            if (result && result.success) showToast(`Transferred ${result.transferred} file(s)`, 'success');
            else if (result) showToast('Transfer failed', 'error');
            await loadLocalFiles(state.localPath);
          }
        }
      } catch (err) {
        console.error('Drag-drop error:', err);
      }
    });
  }

  if (localList) makeDropTarget(localList, 'local');
  if (remoteList) makeDropTarget(remoteList, 'remote');

  // Expose makeDraggable for renderFileList to call on each item
  window.__makeDraggable = makeDraggable;
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

    // 2. Get home directory; load remembered last paths from settings (#17)
    const homeDir = await window.droidBridge.getHomeDir();
    let settings = {};
    try { settings = await window.droidBridge.getSettings(); } catch (e) {}
    state.localPath = settings.lastLocalPath || homeDir || '/';
    state.remotePath = settings.lastRemotePath || '/sdcard';

    // Auto-sync version display in About modal
    if (window.droidBridge.getAppVersion) {
      window.droidBridge.getAppVersion().then((ver) => {
        const el = document.querySelector('.about-version');
        if (el && ver) {
          el.textContent = `Version ${ver}`;
        }
      }).catch(() => {});
    }

    // 3. Load local files (left panel)
    await loadLocalFiles(state.localPath);

    // 3b. Load right panel files (defaults to mac, same as left)
    // If remotePath is /sdcard (Android default) but source is mac, redirect to home dir.
    if (state.remoteSource === 'mac' && (state.remotePath === '/sdcard' || !state.remotePath)) {
      state.remotePath = homeDir || '/';
    }
    await loadRemoteFiles(state.remotePath);

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

    // No renderer-side polling: the main process polls `adb devices` every 3s
    // and pushes device-connected / device-disconnected events, which we
    // already listen to above. This avoids redundant IPC traffic.

  } catch (err) {
    console.error('Initialization error:', err);
    showToast('Failed to initialize: ' + (err.message || err), 'error');
  }
}

async function updateWifiActivityLog(progress) {
  const logContainer = document.getElementById('wifi-activity-log');
  if (!logContainer) return;

  const empty = logContainer.querySelector('.activity-empty');
  if (empty) empty.remove();

  const safeId = 'wifi-file-' + progress.fileName.replace(/[^a-zA-Z0-9]/g, '-');
  let item = document.getElementById(safeId);

  if (!item) {
    item = document.createElement('div');
    item.id = safeId;
    item.className = 'activity-item';
    logContainer.appendChild(item);
  }

  // Prevent out-of-order progress events from overwriting completed status!
  if (item.dataset.completed === 'true' && !progress.completed) {
    return;
  }

  const fileName = progress.fileName;
  const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
  const videoExts = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', '3gp'];

  const isCompleted = progress.completed || item.dataset.completed === 'true';

  // 1. Initial Badge / Placeholder setup
  let thumbEl = item.querySelector('.activity-thumb, .activity-badge');
  if (!thumbEl) {
    const badge = document.createElement('div');
    badge.className = 'activity-badge';
    badge.textContent = videoExts.includes(ext) ? '🎬' : (imageExts.includes(ext) ? '🖼️' : '📄');
    thumbEl = badge;
  }

  // Add click handler to entire row for easy preview
  item.style.cursor = 'pointer';
  item.onclick = () => {
    openMacPreview(fileName);
  };

  // 2. Update Item Layout
  if (item.children.length === 0) {
    const leftDiv = document.createElement('div');
    leftDiv.className = 'activity-left';
    leftDiv.appendChild(thumbEl);

    const fileSpan = document.createElement('span');
    fileSpan.className = 'activity-file-name';
    fileSpan.textContent = fileName;
    fileSpan.title = fileName;
    leftDiv.appendChild(fileSpan);

    const rightDiv = document.createElement('div');
    rightDiv.className = 'activity-right';

    if (isCompleted) {
      item.dataset.completed = 'true';
      const previewBtn = document.createElement('button');
      previewBtn.className = 'activity-preview-btn';
      previewBtn.innerHTML = '👁️ Preview';
      previewBtn.onclick = (e) => {
        e.stopPropagation();
        openMacPreview(fileName);
      };
      rightDiv.appendChild(previewBtn);

      const statusSpan = document.createElement('span');
      statusSpan.className = 'status';
      statusSpan.textContent = '✓ Completed';
      rightDiv.appendChild(statusSpan);
    } else {
      const pctSpan = document.createElement('span');
      pctSpan.className = 'percent';
      pctSpan.textContent = `${progress.percent || 0}%`;
      rightDiv.appendChild(pctSpan);
    }

    const leftWrapper = document.createElement('div');
    leftWrapper.className = 'activity-left-wrapper';
    leftWrapper.appendChild(leftDiv);

    item.appendChild(leftWrapper);
    item.appendChild(rightDiv);
  } else {
    // Update right side based on completion state
    if (isCompleted) {
      item.dataset.completed = 'true';
      const rightDiv = item.querySelector('.activity-right');
      if (rightDiv && !rightDiv.querySelector('.activity-preview-btn')) {
        rightDiv.innerHTML = '';
        const previewBtn = document.createElement('button');
        previewBtn.className = 'activity-preview-btn';
        previewBtn.innerHTML = '👁️ Preview';
        previewBtn.onclick = (e) => {
          e.stopPropagation();
          openMacPreview(fileName);
        };
        rightDiv.appendChild(previewBtn);

        const statusSpan = document.createElement('span');
        statusSpan.className = 'status';
        statusSpan.textContent = '✓ Completed';
        rightDiv.appendChild(statusSpan);
      }
    } else {
      const pctSpan = item.querySelector('.percent');
      if (pctSpan) pctSpan.textContent = `${progress.percent || 0}%`;
    }
  }

  // 3. Upgrade to real thumbnail once transfer is completed!
  if (isCompleted && !item.querySelector('.activity-thumb') && !item.dataset.loadingThumb) {
    if (imageExts.includes(ext) || videoExts.includes(ext)) {
      item.dataset.loadingThumb = 'true';
      try {
        if (window.droidBridge && window.droidBridge.getFileThumbnail) {
          const thumbnailDataUrl = await window.droidBridge.getFileThumbnail(fileName);
          if (thumbnailDataUrl) {
            const img = document.createElement('img');
            img.className = 'activity-thumb';
            img.src = thumbnailDataUrl;
            img.onerror = () => {
              // keep fallback badge if thumbnail load fails
            };

            const currentBadge = item.querySelector('.activity-badge');
            if (currentBadge) {
              currentBadge.replaceWith(img);
            }
          }
        }
      } catch (err) {
        console.warn('[WiFi] Thumbnail fetch error:', err);
      }
      delete item.dataset.loadingThumb;
    }
  }

  logContainer.scrollTop = logContainer.scrollHeight;

  if (progress.completed) {
    loadLocalFiles(state.localPath);
  }
}

function openMacPreview(fileName) {
  const modal = document.getElementById('mac-preview-modal');
  const title = document.getElementById('mac-preview-title');
  const body = document.getElementById('mac-preview-body');

  if (!modal || !body) return;

  // Clean previous media & stop audio playback
  const existingMedia = body.querySelectorAll('video, audio');
  existingMedia.forEach(m => {
    try {
      m.pause();
      m.src = '';
      m.load();
    } catch(e) {}
  });

  const ext = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : '';
  const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
  const videoExts = ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', '3gp'];

  const sharedDir = state.wifiSharedDir || document.getElementById('wifi-shared-path')?.textContent || '';
  const fullPath = sharedDir ? `${sharedDir}/${fileName}` : '';
  const port = state.wifiPort || 8080;
  const httpUrl = `http://127.0.0.1:${port}/download?file=` + encodeURIComponent(fileName);
  const localUrl = fullPath ? `file://${encodeURI(fullPath)}` : httpUrl;

  title.textContent = fileName;
  body.innerHTML = '';

  if (imageExts.includes(ext)) {
    const img = document.createElement('img');
    img.src = localUrl;
    img.alt = fileName;
    img.onerror = () => {
      img.src = httpUrl;
    };

    body.appendChild(img);
    modal.style.display = 'flex';
    modal.classList.add('active');
  } else if (videoExts.includes(ext)) {
    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.src = localUrl;
    video.onerror = () => {
      video.src = httpUrl;
    };

    body.appendChild(video);
    modal.style.display = 'flex';
    modal.classList.add('active');
  } else {
    // For non-media files (PDF, doc, zip, etc.), open directly on Mac
    if (fullPath) {
      if (window.droidBridge.openFilePath) {
        window.droidBridge.openFilePath(fullPath);
      } else {
        window.droidBridge.openInFinder(fullPath);
      }
    }
  }
}

function closeMacPreview(e) {
  if (e && e.stopPropagation) e.stopPropagation();
  const modal = document.getElementById('mac-preview-modal');
  const body = document.getElementById('mac-preview-body');
  
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
  
  if (modal) {
    modal.style.display = 'none';
    modal.classList.remove('active');
  }
}

// --- Boot ---
document.addEventListener('DOMContentLoaded', init);
