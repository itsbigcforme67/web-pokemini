// Render game audio to WAV files (for listening) and report levels.
//   node tests/audio.mjs [outDir] [seconds]
import fs from 'fs';
import { listRoms, boot, play } from './common.mjs';
const outDir = process.argv[2] || '.';
const secs = +(process.argv[3] || 10);
for (const f of listRoms()) {
  const { pm } = boot(f, { sampleRate: 22050 });
  const chunks = [];
  pm.audioOut = (b) => chunks.push(Float32Array.from(b));
  play(pm, `w${secs / 2} A w${secs / 4} A w${secs / 4}`, { quiet: true });
  const n = chunks.reduce((a, c) => a + c.length, 0);
  const pcm = new Int16Array(n);
  let i = 0, sum = 0, peak = 0, crossings = 0, prev = 0;
  for (const c of chunks) for (const v of c) { const s = Math.max(-1, Math.min(1, v * 0.8)); pcm[i++] = s * 32767; sum += s * s; peak = Math.max(peak, Math.abs(s)); if ((s > 0.05) !== (prev > 0.05)) crossings++; prev = s; }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + n * 2, 4); hdr.write('WAVEfmt ', 8); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22);
  hdr.writeUInt32LE(22050, 24); hdr.writeUInt32LE(44100, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write('data', 36); hdr.writeUInt32LE(n * 2, 40);
  const name = `${outDir}/${f.replace(/\.min$/, '')}.wav`;
  fs.writeFileSync(name, Buffer.concat([hdr, Buffer.from(pcm.buffer)]));
  console.log(`${f.slice(0, 36).padEnd(36)} ${(n / 22050).toFixed(1)}s rms=${Math.sqrt(sum / n).toFixed(3)} peak=${peak.toFixed(2)} ~${Math.round(crossings / 2 / (n / 22050))} Hz avg`);
}
