const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const files = [
  'background.js',
  'content.js',
  'popup.html',
  'popup.js',
  'popup.css',
  'icon-16.png',
  'icon-32.png',
  'icon-48.png',
  'icon-128.png'
];

const distDir = 'dist';

// Create dist folder
if (!fs.existsSync(distDir)) {
  fs.mkdirSync(distDir);
}

// Build Firefox
console.log('Building Firefox extension...');
const firefoxDir = path.join(distDir, 'firefox');
if (fs.existsSync(firefoxDir)) fs.rmSync(firefoxDir, { recursive: true });
fs.mkdirSync(firefoxDir);

fs.copyFileSync('manifest.json', path.join(firefoxDir, 'manifest.json'));
files.forEach(f => fs.copyFileSync(f, path.join(firefoxDir, f)));
console.log('Firefox build ready in dist/firefox/');

// Build Chrome
console.log('Building Chrome extension...');
const chromeDir = path.join(distDir, 'chrome');
if (fs.existsSync(chromeDir)) fs.rmSync(chromeDir, { recursive: true });
fs.mkdirSync(chromeDir);

fs.copyFileSync('manifest-chrome.json', path.join(chromeDir, 'manifest.json'));
files.forEach(f => fs.copyFileSync(f, path.join(chromeDir, f)));
console.log('Chrome build ready in dist/chrome/');

console.log('Done!');
