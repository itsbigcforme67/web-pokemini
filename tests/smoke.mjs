// Boot every ROM, press a few buttons, print the screen and timing.
//   node tests/smoke.mjs [rom-name-part] ["script"]
import { listRoms, findRom, boot, play, show } from './common.mjs';
const only = process.argv[2];
const script = process.argv[3] || 'w3 s A w2 s A w2 s';
for (const f of only ? [findRom(only)] : listRoms()) {
  const { pm, info } = boot(f);
  const t0 = Date.now();
  console.log(`\n=== ${f}  [${info.code}] "${info.title}"`);
  play(pm, script);
  const wall = Date.now() - t0;
  console.log(`emu ${pm.time.toFixed(1)}s in ${wall}ms (${(pm.time * 1000 / wall).toFixed(1)}x realtime), frames=${pm.frames}, pc=${pm.cpu.v.toString(16)}:${pm.cpu.pc.toString(16)} status=${pm.cpu.status}`);
}
