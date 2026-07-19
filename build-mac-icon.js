const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const srcPng = path.join(__dirname, 'icon.png');
const iconsetDir = path.join(__dirname, 'icon.iconset');
const destIcns = path.join(__dirname, 'icon.icns');

// Only run on macOS
if (process.platform !== 'darwin') {
  console.log('Skipping macOS icon generation (not on macOS)');
  process.exit(0);
}

if (!fs.existsSync(srcPng)) {
  console.error('Source icon.png not found!');
  process.exit(1);
}

try {
  console.log('Generating macOS .icns from icon.png using native sips & iconutil...');

  // Ensure the source file is compiled to a true PNG format (since renamed JPEGs fail in iconutil)
  const tempPng = path.join(__dirname, 'temp_true_icon.png');
  execSync(`sips -s format png "${srcPng}" --out "${tempPng}"`, { stdio: 'ignore' });

  // Create temporary .iconset directory
  if (!fs.existsSync(iconsetDir)) {
    fs.mkdirSync(iconsetDir);
  }

  const sizes = [
    { name: 'icon_16x16.png', size: 16 },
    { name: 'icon_16x16@2x.png', size: 32 },
    { name: 'icon_32x32.png', size: 32 },
    { name: 'icon_32x32@2x.png', size: 64 },
    { name: 'icon_128x128.png', size: 128 },
    { name: 'icon_128x128@2x.png', size: 256 },
    { name: 'icon_256x256.png', size: 256 },
    { name: 'icon_256x256@2x.png', size: 512 },
    { name: 'icon_512x512.png', size: 512 },
    { name: 'icon_512x512@2x.png', size: 1024 }
  ];

  for (const s of sizes) {
    const outPath = path.join(iconsetDir, s.name);
    execSync(`sips -z ${s.size} ${s.size} "${tempPng}" --out "${outPath}"`, { stdio: 'ignore' });
  }

  // Remove temporary PNG file
  fs.rmSync(tempPng, { force: true });

  // Compile iconset to icns
  execSync(`iconutil -c icns "${iconsetDir}" -o "${destIcns}"`, { stdio: 'inherit' });

  // Clean up iconset directory
  fs.rmSync(iconsetDir, { recursive: true, force: true });

  console.log('Success! icon.icns created.');
} catch (error) {
  console.error('Failed to generate macOS .icns icon:', error.message);
  // Do not fail the build if icon conversion fails
}
