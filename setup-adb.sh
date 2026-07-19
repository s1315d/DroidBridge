#!/bin/bash

# ==============================================================================
# DroidBridge - Automated ADB & Homebrew Installer for macOS
# ==============================================================================

set -e

echo "🌁 DroidBridge Setup Assistant"
echo "======================================"

# 1. Check if running on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
  echo "❌ Error: This script is intended for macOS only."
  exit 1
fi

# 2. Check if Homebrew is installed
if ! command -v brew &> /dev/null; then
  echo "🍺 Homebrew not found. Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  # Add brew to PATH for current session on Apple Silicon or Intel Macs
  if [[ -f "/opt/homebrew/bin/brew" ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -f "/usr/local/bin/brew" ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
else
  echo "✅ Homebrew is already installed."
fi

# 3. Check if ADB (android-platform-tools) is installed
if ! command -v adb &> /dev/null; then
  echo "📱 Installing Android Platform Tools (ADB) via Homebrew..."
  brew install android-platform-tools
else
  echo "✅ ADB (Android Platform Tools) is already installed."
fi

# 4. Verify ADB installation
echo "======================================"
if command -v adb &> /dev/null; then
  echo "🎉 Success! ADB is ready:"
  adb --version | head -n 2
  echo ""
  echo "You can now connect your Android device via USB and launch DroidBridge!"
else
  echo "⚠️ Setup finished, but 'adb' command was not found in PATH. You may need to restart your terminal."
fi
