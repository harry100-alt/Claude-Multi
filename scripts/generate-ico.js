/**
 * Takes the official Claude icon and overlays a bold "M" (rendered via GDI+ font)
 * Generates build/claude-multi.ico, build/icon.png, and src/main/resources/tray.png
 * Run: node scripts/generate-ico.js
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// --------------- PNG Decoder ---------------

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(filePath) {
  const data = fs.readFileSync(filePath);
  if (data[0] !== 137 || data[1] !== 80) throw new Error('Not a PNG');

  let offset = 8, width, height, bitDepth, colorType;
  const idatChunks = [];

  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const chunkData = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = chunkData.readUInt32BE(0); height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8]; colorType = chunkData[9];
    } else if (type === 'IDAT') { idatChunks.push(chunkData); }
    else if (type === 'IEND') { break; }
    offset += 12 + length;
  }

  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const rowBytes = width * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idatChunks));
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
      const src = x * bpp, dst = (y * width + x) * 4;
      if (bpp === 4) { pixels[dst]=curRow[src]; pixels[dst+1]=curRow[src+1]; pixels[dst+2]=curRow[src+2]; pixels[dst+3]=curRow[src+3]; }
      else if (bpp === 3) { pixels[dst]=curRow[src]; pixels[dst+1]=curRow[src+1]; pixels[dst+2]=curRow[src+2]; pixels[dst+3]=255; }
      else if (bpp === 2) { pixels[dst]=curRow[src]; pixels[dst+1]=curRow[src]; pixels[dst+2]=curRow[src]; pixels[dst+3]=curRow[src+1]; }
      else { pixels[dst]=curRow[src]; pixels[dst+1]=curRow[src]; pixels[dst+2]=curRow[src]; pixels[dst+3]=255; }
    }
    prevRow = curRow;
  }
  return { width, height, pixels };
}

// --------------- PNG Encoder ---------------

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) { c = c ^ buf[i]; for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (c & 1 ? 0xEDB88320 : 0); }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type);
  const crcBuf = Buffer.alloc(4); crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([len, typeBytes, data, crcBuf]);
}

function encodePngBuffer(width, height, rgbaData) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0;
    rgbaData.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, makeChunk('IHDR', ihdr), makeChunk('IDAT', compressed), makeChunk('IEND', Buffer.alloc(0))]);
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
        const v00 = srcPixels[(y0*srcW+x0)*4+c], v10 = srcPixels[(y0*srcW+x1)*4+c];
        const v01 = srcPixels[(y1*srcW+x0)*4+c], v11 = srcPixels[(y1*srcW+x1)*4+c];
        dst[di+c] = Math.round(v00*(1-fx)*(1-fy) + v10*fx*(1-fy) + v01*(1-fx)*fy + v11*fx*fy);
      }
    }
  }
  return dst;
}

// --------------- Render M via GDI+ ---------------

function renderMask(size, outPath) {
  const scriptPath = path.join(__dirname, 'render-m.ps1');
  // Use Windows PowerShell 5.1 (has System.Drawing built-in)
  const psExe = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
  execSync(`"${psExe}" -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}" -Size ${size} -OutPath "${outPath}"`, { stdio: 'pipe' });
}

// --------------- Composite M onto icon ---------------

function overlayMask(iconPixels, iconW, iconH, maskPixels, maskW, maskH) {
  // Scale mask to fit ~63% of icon height, centered, 20% wider
  const targetH = Math.round(iconH * 0.63);
  const scale = targetH / maskH;
  const targetW = Math.round(maskW * scale * 1.2);
  const ox = Math.round((iconW - targetW) / 2);
  const oy = Math.round((iconH - targetH) / 2);

  for (let dy = 0; dy < targetH; dy++) {
    for (let dx = 0; dx < targetW; dx++) {
      const ix = ox + dx, iy = oy + dy;
      if (ix < 0 || ix >= iconW || iy < 0 || iy >= iconH) continue;

      // Sample mask with bilinear interpolation
      const sx = (dx + 0.5) * maskW / targetW - 0.5;
      const sy = (dy + 0.5) * maskH / targetH - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), y0 = Math.max(0, Math.floor(sy));
      const x1 = Math.min(maskW - 1, x0 + 1), y1 = Math.min(maskH - 1, y0 + 1);
      const fx = sx - x0, fy = sy - y0;

      // Sample alpha channel of mask (black text on transparent = alpha indicates coverage)
      const a00 = maskPixels[(y0 * maskW + x0) * 4 + 3];
      const a10 = maskPixels[(y0 * maskW + x1) * 4 + 3];
      const a01 = maskPixels[(y1 * maskW + x0) * 4 + 3];
      const a11 = maskPixels[(y1 * maskW + x1) * 4 + 3];
      const maskAlpha = (a00 * (1-fx) * (1-fy) + a10 * fx * (1-fy) +
                         a01 * (1-fx) * fy + a11 * fx * fy) / 255;

      if (maskAlpha > 0.01) {
        const i = (iy * iconW + ix) * 4;
        if (iconPixels[i + 3] === 0) continue;
        const a = Math.min(1, maskAlpha);
        // Composite black (0,0,0) over existing pixel
        iconPixels[i]     = Math.round(iconPixels[i]     * (1 - a));
        iconPixels[i + 1] = Math.round(iconPixels[i + 1] * (1 - a));
        iconPixels[i + 2] = Math.round(iconPixels[i + 2] * (1 - a));
      }
    }
  }
}

// --------------- ICO Writer ---------------

function writeIco(pngBuffers, sizes, filePath) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(pngBuffers.length, 4);
  const dirEntries = [];
  let dataOffset = 6 + pngBuffers.length * 16;
  for (let i = 0; i < pngBuffers.length; i++) {
    const entry = Buffer.alloc(16);
    entry[0] = sizes[i] >= 256 ? 0 : sizes[i];
    entry[1] = sizes[i] >= 256 ? 0 : sizes[i];
    entry.writeUInt16LE(1, 4); entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(pngBuffers[i].length, 8);
    entry.writeUInt32LE(dataOffset, 12);
    dataOffset += pngBuffers[i].length;
    dirEntries.push(entry);
  }
  fs.writeFileSync(filePath, Buffer.concat([header, ...dirEntries, ...pngBuffers]));
}

// --------------- Main ---------------

const claudeIconPath = path.join('C:', 'Program Files', 'WindowsApps',
  'Claude_1.1.4498.0_x64__pzs8sxrjxfjjc', 'assets', 'Square150x150Logo.png');

console.log('Decoding official Claude icon...');
const icon = decodePng(claudeIconPath);
console.log(`  Source: ${icon.width}x${icon.height}`);

// Render M mask using GDI+ with Impact font
const maskSize = 512;
const maskPath = path.join(__dirname, '..', 'build', '_m-mask.png');
console.log('Rendering M with Impact font via GDI+...');
renderMask(maskSize, maskPath);

const mask = decodePng(maskPath);
console.log(`  Mask: ${mask.width}x${mask.height}`);

// Composite M onto icon
console.log('Compositing...');
overlayMask(icon.pixels, icon.width, icon.height, mask.pixels, mask.width, mask.height);

// Clean up temp mask
fs.unlinkSync(maskPath);

// Generate ICO with multiple sizes
const icoSizes = [256, 48, 32, 16];
const pngBuffers = [];
for (const size of icoSizes) {
  const resized = size === icon.width ? icon.pixels : resize(icon.pixels, icon.width, icon.height, size, size);
  pngBuffers.push(encodePngBuffer(size, size, resized));
  console.log(`  Generated ${size}x${size} (${pngBuffers[pngBuffers.length - 1].length} bytes)`);
}

const icoPath = path.join(__dirname, '..', 'build', 'claude-multi.ico');
writeIco(pngBuffers, icoSizes, icoPath);
console.log(`\nICO saved: ${icoPath} (${fs.statSync(icoPath).size} bytes)`);

const pngPath = path.join(__dirname, '..', 'build', 'icon.png');
fs.writeFileSync(pngPath, encodePngBuffer(icon.width, icon.height, icon.pixels));
console.log(`PNG saved: ${pngPath} (${fs.statSync(pngPath).size} bytes)`);

const trayPixels = resize(icon.pixels, icon.width, icon.height, 32, 32);
const trayPath = path.join(__dirname, '..', 'src', 'main', 'resources', 'tray.png');
fs.writeFileSync(trayPath, encodePngBuffer(32, 32, trayPixels));
console.log(`Tray icon: ${trayPath} (${fs.statSync(trayPath).size} bytes)`);

const windowPixels = resize(icon.pixels, icon.width, icon.height, 256, 256);
const windowPath = path.join(__dirname, '..', 'src', 'main', 'resources', 'icon.png');
fs.writeFileSync(windowPath, encodePngBuffer(256, 256, windowPixels));
console.log(`Window icon: ${windowPath} (${fs.statSync(windowPath).size} bytes)`);
