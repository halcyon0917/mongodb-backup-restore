'use strict';

/**
 * Builds build/icon.ico from build/icon.svg:
 *
 *   npm run icon
 *
 * Rasterises the SVG at every size Windows asks for and packs the PNGs into a
 * multi-resolution .ico. Sizes at or below 32px use build/icon-small.svg, whose
 * detail is reduced so the leaf stays readable at taskbar size.
 *
 * Chromium does the rasterising (via a canvas in a hidden window) and the .ico
 * container is written by hand, so this needs no image libraries.
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const BUILD_DIR = path.join(__dirname, '..', 'build');
const DETAILED = path.join(BUILD_DIR, 'icon.svg');
const SIMPLIFIED = path.join(BUILD_DIR, 'icon-small.svg');
const ICO_OUT = path.join(BUILD_DIR, 'icon.ico');
const PNG_OUT = path.join(BUILD_DIR, 'icon.png');

// The set Windows picks from for the taskbar, alt-tab, Explorer and the shortcut.
const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
// Below 64px the cycle arcs and their arrowheads render as grey fuzz, adding
// noise instead of meaning, so everything up to 48px uses the leaf-only cut.
const SIMPLIFY_AT_OR_BELOW = 48;

// Optional extra sizes written as loose PNGs for previewing small-size legibility.
const PREVIEW_DIR = process.argv.includes('--preview')
  ? process.argv[process.argv.indexOf('--preview') + 1]
  : null;

/**
 * Pack PNG buffers into an .ico. Windows has accepted PNG-compressed icon
 * entries since Vista, which avoids hand-rolling BMP + AND-mask data.
 */
function packIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type 1 = icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((image, index) => {
    const at = index * 16;
    // 256 is encoded as 0 in a single byte.
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, at + 0);
    directory.writeUInt8(image.size >= 256 ? 0 : image.size, at + 1);
    directory.writeUInt8(0, at + 2); // palette size
    directory.writeUInt8(0, at + 3); // reserved
    directory.writeUInt16LE(1, at + 4); // colour planes
    directory.writeUInt16LE(32, at + 6); // bits per pixel
    directory.writeUInt32LE(image.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += image.png.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.png)]);
}

/** Read back what we wrote, so a malformed container cannot ship silently. */
function verifyIco(buffer) {
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) {
    throw new Error('not an icon file');
  }
  const count = buffer.readUInt16LE(4);
  const found = [];
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 16;
    const width = buffer.readUInt8(at) || 256;
    const bytes = buffer.readUInt32LE(at + 8);
    const start = buffer.readUInt32LE(at + 12);
    if (start + bytes > buffer.length) throw new Error(`entry ${width} runs past end of file`);
    // Every payload must be a real PNG.
    const signature = buffer.subarray(start, start + 8);
    if (!signature.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      throw new Error(`entry ${width} is not PNG data`);
    }
    found.push(width);
  }
  return found;
}

const RASTERISE = `(async (svg, size) => {
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const image = new Image();
  image.width = size;
  image.height = size;
  await new Promise((resolve, reject) => {
    image.onload = resolve;
    image.onerror = () => reject(new Error('the SVG failed to load'));
    image.src = url;
  });

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, size, size);
  context.drawImage(image, 0, 0, size, size);
  // A data: source does not taint the canvas, so this stays readable.
  return canvas.toDataURL('image/png');
})`;

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const detailed = fs.readFileSync(DETAILED, 'utf8');
  const simplified = fs.existsSync(SIMPLIFIED) ? fs.readFileSync(SIMPLIFIED, 'utf8') : detailed;

  const window = new BrowserWindow({
    show: false,
    width: 320,
    height: 320,
    webPreferences: { offscreen: true },
  });
  await window.loadURL('data:text/html,<!doctype html><meta charset="utf-8"><body></body>');

  try {
    const images = [];
    for (const size of SIZES) {
      const svg = size <= SIMPLIFY_AT_OR_BELOW ? simplified : detailed;
      const dataUrl = await window.webContents.executeJavaScript(
        `${RASTERISE}(${JSON.stringify(svg)}, ${size})`,
        true
      );
      const png = Buffer.from(dataUrl.split(',')[1], 'base64');
      images.push({ size, png });
      if (PREVIEW_DIR) {
        fs.writeFileSync(path.join(PREVIEW_DIR, `icon-${size}.png`), png);
      }
      console.log(
        `  ${String(size).padStart(3)}px  ${String(png.length).padStart(6)} bytes` +
          `${size <= SIMPLIFY_AT_OR_BELOW ? '  (simplified)' : ''}`
      );
    }

    if (PREVIEW_DIR) {
      // 512 cannot be stored in an .ico (the size field is one byte), so this
      // is preview-only — for judging the artwork at full size.
      const big = await window.webContents.executeJavaScript(
        `${RASTERISE}(${JSON.stringify(detailed)}, 512)`,
        true
      );
      fs.writeFileSync(
        path.join(PREVIEW_DIR, 'icon-512.png'),
        Buffer.from(big.split(',')[1], 'base64')
      );
      console.log('  512px  preview only (not stored in the .ico)');
    }

    const ico = packIco(images);
    fs.writeFileSync(ICO_OUT, ico);
    const present = verifyIco(fs.readFileSync(ICO_OUT));
    console.log(`\nWrote ${ICO_OUT} — ${ico.length} bytes, sizes: ${present.join(', ')}`);

    // A 256px PNG for any non-Windows target and for previewing the artwork.
    fs.writeFileSync(PNG_OUT, images.find((image) => image.size === 256).png);
    console.log(`Wrote ${PNG_OUT}`);
  } catch (error) {
    console.error('\nIcon generation failed:', error);
    app.exit(1);
    return;
  }

  app.exit(0);
});
