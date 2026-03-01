// Generate a 256x256 orange circle PNG icon for electron-builder
// Uses raw RGBA + zlib deflate to create valid PNG without dependencies
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const size = 256;
const cx = size / 2, cy = size / 2, r = size / 2 - 4;

// Build raw RGBA pixel data with filter bytes for PNG
const rawRows = [];
for (let y = 0; y < size; y++) {
  const row = Buffer.alloc(1 + size * 4); // 1 filter byte + RGBA
  row[0] = 0; // No filter
  for (let x = 0; x < size; x++) {
    const dx = x - cx, dy = y - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const i = 1 + x * 4;
    if (dist <= r - 1) {
      row[i] = 217; row[i+1] = 119; row[i+2] = 87; row[i+3] = 255;
    } else if (dist <= r + 1) {
      const alpha = Math.max(0, Math.min(255, Math.round((r + 1 - dist) * 128)));
      row[i] = 217; row[i+1] = 119; row[i+2] = 87; row[i+3] = alpha;
    } else {
      row[i] = 0; row[i+1] = 0; row[i+2] = 0; row[i+3] = 0;
    }
  }
  rawRows.push(row);
}

const rawData = Buffer.concat(rawRows);
const compressed = zlib.deflateSync(rawData);

// Build PNG file
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
    }
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeData = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeData));
  return Buffer.concat([len, typeData, crc]);
}

// IHDR
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(size, 0);
ihdr.writeUInt32BE(size, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // RGBA
ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
  chunk('IHDR', ihdr),
  chunk('IDAT', compressed),
  chunk('IEND', Buffer.alloc(0))
]);

const outPath = path.join(__dirname, '..', 'build', 'icon.png');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, png);
console.log(`Icon written: ${outPath} (${png.length} bytes)`);
