// Creates release/cofoundry-ai-phase-XX.zip from the working tree, excluding dependencies,
// build output, VCS data, secrets and caches. Pure Node (no zip CLI), so it works on Windows.
//
// Usage: npm run package:zip -- 01
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const phase = (process.argv[2] ?? '01').padStart(2, '0');
const outDir = path.join(root, 'release');
const outFile = path.join(outDir, `cofoundry-ai-phase-${phase}.zip`);

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  'release',
  '.vite',
  '.idea',
  '.vscode',
  '.turbo',
  'test-results',
  'playwright-report',
  // Private runtime data, e.g. uploaded resumes (apps/server/var/resumes).
  'var',
]);
const EXCLUDED_FILES = [
  /^\.env$/,
  /^\.env\..+/,
  /\.log$/,
  /^\.DS_Store$/,
  /^Thumbs\.db$/,
  /\.tsbuildinfo$/,
];
const ALLOWED_ENV = new Set(['.env.example']);

function excludedFile(name) {
  if (ALLOWED_ENV.has(name)) return false;
  return EXCLUDED_FILES.some((re) => re.test(name));
}

function walk(dir, rel = '') {
  const out = [];
  for (const entry of fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) out.push(...walk(abs, relPath));
    } else if (entry.isFile() && !excludedFile(entry.name)) {
      out.push({ abs, rel: relPath });
    }
  }
  return out;
}

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(date) {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

const files = walk(root);
const chunks = [];
const central = [];
let offset = 0;
const { time, day } = dosTime(new Date());

for (const file of files) {
  const data = fs.readFileSync(file.abs);
  const compressed = zlib.deflateRawSync(data, { level: 9 });
  const name = Buffer.from(`cofoundry-ai/${file.rel}`, 'utf8');
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(day, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  chunks.push(local, name, compressed);

  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(8, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(day, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(compressed.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(name.length, 28);
  header.writeUInt32LE(offset, 42);
  central.push(header, name);

  offset += local.length + name.length + compressed.length;
}

const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outFile, Buffer.concat([...chunks, centralBuf, end]));
console.log(
  `Wrote ${path.relative(root, outFile)} (${files.length} files, ${(fs.statSync(outFile).size / 1024).toFixed(0)} KiB)`,
);
