/**
 * Takes the official Claude icon and overlays a bold "M" on top.
 * Generates build/icon.png (app icon) and src/main/resources/tray.png (tray icon).
 * Run: node scripts/generate-icon.js
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// --------------- PNG Decoder ---------------

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(filePath) {
  const data = fs.readFileSync(filePath);

  // Verify signature
  if (data[0] !== 137 || data[1] !== 80 || data[2] !== 78 || data[3] !== 71)
    throw new Error('Not a PNG file');

  let offset = 8;
  let width, height, bitDepth, colorType;
  const idatChunks = [];

  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const chunkData = data.subarray(offset + 8, offset + 8 + length);

    if (type === 'IHDR') {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
    } else if (type === 'IDAT') {
      idatChunks.push(chunkData);
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }

  if (!width || !height) throw new Error('Missing IHDR');
  if (bitDepth !== 8) throw new Error(`Unsupported bit depth: ${bitDepth}`);

  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const rowBytes = width * bpp;

  const compressed = Buffer.concat(idatChunks);
  const raw = zlib.inflateSync(compressed);

  const pixels = Buffer.alloc(width * height * 4);
  let prevRow = Buffer.alloc(rowBytes);

  for (let y = 0; y < height; y++) {
    const filterByte = raw[y * (rowBytes + 1)];
    const curRow = Buffer.alloc(rowBytes);

    for (let i = 0; i < rowBytes; i++) {
      const val = raw[y * (rowBytes + 1) + 1 + i];
      const a = i >= bpp ? curRow[i - bpp] : 0;
      const b = prevRow[i];
      const c = i >= bpp ? prevRow[i - bpp] : 0;

      switch (filterByte) {
        case 0: curRow[i] = val; break;
        case 1: curRow[i] = (val + a) & 0xFF; break;
        case 2: curRow[i] = (val + b) & 0xFF; break;
        case 3: curRow[i] = (val + Math.floor((a + b) / 2)) & 0xFF; break;
        case 4: curRow[i] = (val + paeth(a, b, c)) & 0xFF; break;
      }
    }

    for (let x = 0; x < width; x++) {
      const src = x * bpp;
      const dst = (y * width + x) * 4;
      if (bpp === 4) {
        pixels[dst] = curRow[src]; pixels[dst + 1] = curRow[src + 1];
        pixels[dst + 2] = curRow[src + 2]; pixels[dst + 3] = curRow[src + 3];
      } else if (bpp === 3) {
        pixels[dst] = curRow[src]; pixels[dst + 1] = curRow[src + 1];
        pixels[dst + 2] = curRow[src + 2]; pixels[dst + 3] = 255;
      } else if (bpp === 2) {
        pixels[dst] = curRow[src]; pixels[dst + 1] = curRow[src];
        pixels[dst + 2] = curRow[src]; pixels[dst + 3] = curRow[src + 1];
      } else {
        pixels[dst] = curRow[src]; pixels[dst + 1] = curRow[src];
        pixels[dst + 2] = curRow[src]; pixels[dst + 3] = 255;
      }
    }
    prevRow = curRow;
  }

  return { width, height, pixels };
}

// --------------- PNG Encoder ---------------

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = c ^ buf[i];
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([len, typeBytes, data, crcBuf]);
}

function encodePng(width, height, rgbaData, filePath) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgbaData.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }

  const compressed = zlib.deflateSync(raw, { level: 9 });
  fs.writeFileSync(filePath, Buffer.concat([
    sig, makeChunk('IHDR', ihdr), makeChunk('IDAT', compressed), makeChunk('IEND', Buffer.alloc(0))
  ]));
}

// --------------- Bilinear Resize ---------------

function resize(srcPixels, srcW, srcH, dstW, dstH) {
  const dst = Buffer.alloc(dstW * dstH * 4);
  for (let dy = 0; dy < dstH; dy++) {
    for (let dx = 0; dx < dstW; dx++) {
      const sx = (dx + 0.5) * srcW / dstW - 0.5;
      const sy = (dy + 0.5) * srcH / dstH - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
      const x1 = Math.min(srcW - 1, x0 + 1), y1 = Math.min(srcH - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0;

      const di = (dy * dstW + dx) * 4;
      for (let c = 0; c < 4; c++) {
        const v00 = srcPixels[(y0 * srcW + x0) * 4 + c];
        const v10 = srcPixels[(y0 * srcW + x1) * 4 + c];
        const v01 = srcPixels[(y1 * srcW + x0) * 4 + c];
        const v11 = srcPixels[(y1 * srcW + x1) * 4 + c];
        dst[di + c] = Math.round(v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) +
                                  v01 * (1 - fx) * fy + v11 * fx * fy);
      }
    }
  }
  return dst;
}

// --------------- M Overlay ---------------

function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.sqrt((px - x1) ** 2 + (py - y1) ** 2);
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2));
  return Math.sqrt((px - (x1 + t * dx)) ** 2 + (py - (y1 + t * dy)) ** 2);
}

function overlayM(pixels, width, height) {
  // M is centered, occupies ~55% of the icon height
  const mHeight = height * 0.38;
  const mWidth = mHeight * 0.85;
  const ox = (width - mWidth) / 2;   // x offset to center
  const oy = (height - mHeight) / 2 + height * 0.02; // slightly below center

  const strokeW = mHeight * 0.16;     // bold stroke
  const outlineW = strokeW * 0.35;    // dark outline around M for contrast

  // M segments relative to the M bounding box
  const segs = [
    [ox,              oy,           ox,              oy + mHeight],  // left stem
    [ox,              oy,           ox + mWidth / 2, oy + mHeight * 0.6],  // left diagonal
    [ox + mWidth,     oy,           ox + mWidth / 2, oy + mHeight * 0.6],  // right diagonal
    [ox + mWidth,     oy,           ox + mWidth,     oy + mHeight],  // right stem
  ];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const srcAlpha = pixels[i + 3];
      if (srcAlpha === 0) continue; // skip transparent

      let minDist = Infinity;
      for (const s of segs) minDist = Math.min(minDist, distToSegment(x, y, s[0], s[1], s[2], s[3]));

      const halfStroke = strokeW / 2;
      const totalHalf = halfStroke + outlineW;

      // Black M foreground
      const mAlpha = minDist <= halfStroke - 0.8 ? 1 :
                     minDist <= halfStroke + 0.8 ? Math.max(0, (halfStroke + 0.8 - minDist) / 1.6) : 0;

      if (mAlpha > 0) {
        pixels[i]     = Math.round(pixels[i]     * (1 - mAlpha));
        pixels[i + 1] = Math.round(pixels[i + 1] * (1 - mAlpha));
        pixels[i + 2] = Math.round(pixels[i + 2] * (1 - mAlpha));
      }
    }
  }
}

// --------------- Main ---------------

const claudeIconPath = path.join('C:', 'Program Files', 'WindowsApps',
  'Claude_1.1.4498.0_x64__pzs8sxrjxfjjc', 'assets', 'Square150x150Logo.png');

console.log('Decoding official Claude icon...');
const icon = decodePng(claudeIconPath);
console.log(`  Source: ${icon.width}x${icon.height}`);

console.log('Overlaying M...');
overlayM(icon.pixels, icon.width, icon.height);

const appIconPath = path.join(__dirname, '..', 'build', 'icon.png');
encodePng(icon.width, icon.height, icon.pixels, appIconPath);
console.log(`  App icon: ${appIconPath} (${fs.statSync(appIconPath).size} bytes)`);

const trayPixels = resize(icon.pixels, icon.width, icon.height, 32, 32);
const trayIconPath = path.join(__dirname, '..', 'src', 'main', 'resources', 'tray.png');
encodePng(32, 32, trayPixels, trayIconPath);
console.log(`  Tray icon: ${trayIconPath} (${fs.statSync(trayIconPath).size} bytes)`);

console.log('Done.');
