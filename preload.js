const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('droidBridge', {
  // ADB & Device
  checkAdb: () => ipcRenderer.invoke('check-adb'),
  getDevices: () => ipcRenderer.invoke('get-devices'),
  getDeviceInfo: (deviceId) => ipcRenderer.invoke('get-device-info', deviceId),
  getStorageInfo: (deviceId) => ipcRenderer.invoke('get-storage-info', deviceId),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),

  // Local filesystem
  listLocalFiles: (dirPath) => ipcRenderer.invoke('list-local-files', dirPath),
  getHomeDir: () => ipcRenderer.invoke('get-home-dir'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  selectFiles: () => ipcRenderer.invoke('select-files'),
  openInFinder: (filePath) => ipcRenderer.invoke('open-in-finder', filePath),
  openFilePath: (filePath) => ipcRenderer.invoke('open-file-path', filePath),
  getTempDir: () => ipcRenderer.invoke('get-temp-dir'),
  cleanupDir: (dirPath) => ipcRenderer.invoke('cleanup-dir', dirPath),

  // Remote (Android) filesystem
  listRemoteFiles: (deviceId, dirPath) => ipcRenderer.invoke('list-remote-files', { deviceId, dirPath }),
  deleteRemote: (deviceId, remotePath) => ipcRenderer.invoke('delete-remote', { deviceId, remotePath }),
  deleteLocal: (filePath) => ipcRenderer.invoke('delete-local', filePath),
  createRemoteDir: (deviceId, remotePath) => ipcRenderer.invoke('create-remote-dir', { deviceId, remotePath }),
  renameLocal: (oldPath, newName) => ipcRenderer.invoke('rename-local', { oldPath, newName }),
  renameRemote: (deviceId, remotePath, newName) => ipcRenderer.invoke('rename-remote', { deviceId, remotePath, newName }),

  // File transfer
  pushFiles: (deviceId, localPaths, remotePath) => ipcRenderer.invoke('push-files', { deviceId, localPaths, remotePath }),
  pullFiles: (deviceId, remotePaths, localPath) => ipcRenderer.invoke('pull-files', { deviceId, remotePaths, localPath }),
  cancelTransfer: () => ipcRenderer.invoke('cancel-transfer'),
  pauseTransfer: () => ipcRenderer.invoke('pause-transfer'),
  resumeTransfer: () => ipcRenderer.invoke('resume-transfer'),

  // Settings & History
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (partial) => ipcRenderer.invoke('set-settings', partial),
  getTransferHistory: () => ipcRenderer.invoke('get-transfer-history'),
  clearTransferHistory: () => ipcRenderer.invoke('clear-transfer-history'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),

  // Events from main process
  onDeviceConnected: (callback) => {
    ipcRenderer.on('device-connected', (_event, data) => callback(data));
  },
  onDeviceDisconnected: (callback) => {
    ipcRenderer.on('device-disconnected', () => callback());
  },
  onTransferProgress: (callback) => {
    ipcRenderer.on('transfer-progress', (_event, data) => callback(data));
  },
  onShowAbout: (callback) => {
    ipcRenderer.on('show-about', () => callback());
  },

  // Wi-Fi Transfer IPC
  startWifiServer: () => ipcRenderer.invoke('start-wifi-server'),
  setWifiSharedDir: (dirPath) => ipcRenderer.invoke('set-wifi-shared-dir', dirPath),
  stopWifiServer: () => ipcRenderer.invoke('stop-wifi-server'),
  getWifiStatus: () => ipcRenderer.invoke('get-wifi-status'),
  openWifiSharedDir: () => ipcRenderer.invoke('open-wifi-shared-dir'),
  getFileThumbnail: (fileName) => ipcRenderer.invoke('get-file-thumbnail', fileName),
  getFileDataUrl: (fileName) => ipcRenderer.invoke('get-file-data-url', fileName),
  onWifiUploadProgress: (callback) => {
    ipcRenderer.on('wifi-upload-progress', (_event, data) => callback(data));
  },

  // Local & Remote File Thumbnail / Preview IPC
  getLocalThumbnail: (filePath) => ipcRenderer.invoke('get-local-thumbnail', filePath),
  getRemoteThumbnail: (deviceId, remotePath) => ipcRenderer.invoke('get-remote-thumbnail', { deviceId, remotePath }),
  fetchRemotePreview: (deviceId, remotePath) => ipcRenderer.invoke('fetch-remote-preview', { deviceId, remotePath }),
});
