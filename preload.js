const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('droidBridge', {
  // ADB & Device
  checkAdb: () => ipcRenderer.invoke('check-adb'),
  getDevices: () => ipcRenderer.invoke('get-devices'),
  getDeviceInfo: (deviceId) => ipcRenderer.invoke('get-device-info', deviceId),
  getStorageInfo: (deviceId) => ipcRenderer.invoke('get-storage-info', deviceId),

  // Local filesystem
  listLocalFiles: (dirPath) => ipcRenderer.invoke('list-local-files', dirPath),
  getHomeDir: () => ipcRenderer.invoke('get-home-dir'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  selectFiles: () => ipcRenderer.invoke('select-files'),
  openInFinder: (filePath) => ipcRenderer.invoke('open-in-finder', filePath),
  getTempDir: () => ipcRenderer.invoke('get-temp-dir'),
  cleanupDir: (dirPath) => ipcRenderer.invoke('cleanup-dir', dirPath),

  // Remote (Android) filesystem
  listRemoteFiles: (deviceId, dirPath) => ipcRenderer.invoke('list-remote-files', { deviceId, dirPath }),
  deleteRemote: (deviceId, remotePath) => ipcRenderer.invoke('delete-remote', { deviceId, remotePath }),
  createRemoteDir: (deviceId, remotePath) => ipcRenderer.invoke('create-remote-dir', { deviceId, remotePath }),

  // File transfer
  pushFiles: (deviceId, localPaths, remotePath) => ipcRenderer.invoke('push-files', { deviceId, localPaths, remotePath }),
  pullFiles: (deviceId, remotePaths, localPath) => ipcRenderer.invoke('pull-files', { deviceId, remotePaths, localPath }),

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
  onWifiUploadProgress: (callback) => {
    ipcRenderer.on('wifi-upload-progress', (_event, data) => callback(data));
  },
});
