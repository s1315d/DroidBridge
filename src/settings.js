// ─────────────────────────────────────────────────────────────────────────────
// DroidBridge — Settings & History Persistence Module
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path');
const fs = require('fs');

function getSettingsFilePath(app) {
  return path.join(app.getPath('userData'), 'droidbridge-settings.json');
}

function loadSettings(app) {
  try {
    const filePath = getSettingsFilePath(app);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (err) {
    console.error('[Settings] Failed to load:', err.message);
  }
  return {};
}

function saveSettings(app, settings) {
  try {
    fs.writeFileSync(getSettingsFilePath(app), JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error('[Settings] Failed to save:', err.message);
  }
}

function getHistoryFilePath(app) {
  return path.join(app.getPath('userData'), 'droidbridge-history.json');
}

function loadHistory(app) {
  try {
    const filePath = getHistoryFilePath(app);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    }
  } catch (err) {
    console.error('[History] Failed to load:', err.message);
  }
  return [];
}

function saveHistory(app, history) {
  try {
    if (history.length > 200) history = history.slice(0, 200);
    fs.writeFileSync(getHistoryFilePath(app), JSON.stringify(history, null, 2));
  } catch (err) {
    console.error('[History] Failed to save:', err.message);
  }
}

function addHistoryEntry(app, entry) {
  const history = loadHistory(app);
  history.unshift(entry);
  saveHistory(app, history);
}

module.exports = { loadSettings, saveSettings, loadHistory, saveHistory, addHistoryEntry };
