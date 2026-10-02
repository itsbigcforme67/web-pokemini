// Shared helpers for the headless tests. ROMs/BIOS (.min files or zips of them) are looked up in
// $POKEMINI_ROMS, then ../roms, ../../roms and "../../legally extracted roms".
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { PokeMini, romInfo } from '../web/core/pokemini.js';

const here = path.dirname(decodeURIComponent(new URL(import.meta.url).pathname));
export const ROM_DIR = [process.env.POKEMINI_ROMS, path.join(here, '../roms'), path.join(here, '../../roms'), path.join(here, '../../legally extracted roms')]
  .find((d) => d && fs.existsSync(d));
if (!ROM_DIR) { console.error('No ROM folder found. Set POKEMINI_ROMS=/path/to/roms (folder with .min files or zips, plus the 4 KB BIOS).'); process.exit(2); }

// .min files, or the first .min inside each .zip
function unzipFirst(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) return null;
  let p = buf.readUInt32LE(e + 16);
  for (let n = buf.readUInt16LE(e + 10); n > 0; n--) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lo = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nl);
    p += 46 + nl + el + cl;
    if (!/\.(min|bin)$/i.test(name)) continue;
    const ds = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const raw = buf.subarray(ds, ds + csize);
    return new Uint8Array(method === 0 ? raw : zlib.inflateRawSync(raw));
  }
  return null;
}
let cache;
function files() {
  if (cache) return cache;
  cache = [];
  for (const name of fs.readdirSync(ROM_DIR).sort()) {
    const buf = fs.readFileSync(path.join(ROM_DIR, name));
    const data = /\.zip$/i.test(name) ? unzipFirst(buf) : /\.(min|bin)$/i.test(name) ? new Uint8Array(buf) : null;
    if (data) cache.push({ name: name.replace(/\.zip$/i, '.min'), data });
  }
  return cache;
}
export function listRoms() { return files().filter((f) => f.data.length > 4096).map((f) => f.name); }
export function loadBios() {
  const f = files().find((x) => x.data.length === 4096);
  if (!f) { console.error('No 4 KB BIOS file found in ' + ROM_DIR); process.exit(2); }
  return f.data;
}
export function findRom(part) {
  const f = listRoms().find((n) => n.toLowerCase().includes(part.toLowerCase()));
  if (!f) throw new Error('no ROM matching ' + part);
  return f;
}
export function boot(romFile, opts = {}) {
  const rom = files().find((f) => f.name === romFile).data;
  const pm = new PokeMini({ bios: loadBios(), rom, date: new Date(2026, 9, 1, 13, 30, 0), ...opts });
  return { pm, info: romInfo(rom) };
}
// 96x64 frame as text rows: ' ' light, '░▒▓█' darker
export function rows(pm) {
  const f = pm.getFrame();
  const ch = ' .:+#';
  const out = [];
  for (let y = 0; y < 64; y++) {
    let s = '';
    for (let x = 0; x < 96; x++) s += ch[Math.min(4, Math.round(f[y * 96 + x] / 64))];
    out.push(s);
  }
  return out;
}
// half-height rendering (2 pixel rows per text line) for compact logs
export function show(pm, label = '') {
  const f = pm.getFrame();
  const on = (x, y) => f[y * 96 + x] > 128;
  if (label) console.log(label);
  console.log('+' + '-'.repeat(96) + '+');
  for (let y = 0; y < 64; y += 2) {
    let s = '';
    for (let x = 0; x < 96; x++) { const a = on(x, y), b = on(x, y + 1); s += a && b ? '█' : a ? '▀' : b ? '▄' : ' '; }
    console.log('|' + s + '|');
  }
  console.log('+' + '-'.repeat(96) + '+');
}
// run a script: "w2" wait 2s, "A" tap A, "U/D/L/R/B/C/P" taps, "hA1.5" hold A 1.5s, "s" show frame
export function play(pm, script, { quiet = false } = {}) {
  const map = { A: 1, B: 2, C: 4, U: 8, D: 16, L: 32, R: 64, P: 128 };
  for (const tok of script.split(/\s+/).filter(Boolean)) {
    if (tok[0] === 'w') pm.runFor(+tok.slice(1));
    else if (tok === 's') { if (!quiet) show(pm, `t=${pm.time.toFixed(2)}s pc=${pm.cpu.v.toString(16)}:${pm.cpu.pc.toString(16)}`); }
    else if (tok[0] === 'h') { const k = tok[1]; pm.setButtons(map[k]); pm.runFor(+tok.slice(2) || 1); pm.setButtons(0); pm.runFor(0.1); }
    else { pm.setButtons(tok.split('').reduce((m, c) => m | (map[c] || 0), 0)); pm.runFor(0.1); pm.setButtons(0); pm.runFor(0.15); }
  }
}
