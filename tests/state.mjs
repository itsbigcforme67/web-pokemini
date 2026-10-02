// Save-state round trip: state saved mid-game, restored into a fresh console, must continue identically.
// Also checks that the state survives structured cloning (what IndexedDB does).
import { listRoms, boot, play } from './common.mjs';
import { PokeMini } from '../web/core/pokemini.js';
let fail = 0;
for (const f of listRoms()) {
  const { pm } = boot(f);
  play(pm, 'w4 A w2 R w1 A w2', { quiet: true });
  const st = structuredClone(pm.saveState());
  play(pm, 'A w1 L w1 hA0.5 w2', { quiet: true });
  const a = pm.getFrame().slice(), ra = pm.ram.slice();
  const { pm: pm2 } = boot(f);
  pm2.loadState(st);
  play(pm2, 'A w1 L w1 hA0.5 w2', { quiet: true });
  const b = pm2.getFrame(), rb = pm2.ram;
  const same = a.every((v, i) => v === b[i]) && ra.every((v, i) => v === rb[i]) && pm.cpu.pc === pm2.cpu.pc;
  console.log(`${same ? 'ok  ' : 'FAIL'} ${f}  (state ${JSON.stringify(st, (k, v) => (v && v.BYTES_PER_ELEMENT ? Array.from(v) : v)).length >> 10} KB as JSON)`);
  if (!same) fail++;
}
// EEPROM: count writes during a short session per game
for (const f of listRoms()) {
  const { pm } = boot(f);
  let writes = 0; pm.onEepromWrite = () => writes++;
  play(pm, 'w4 A w3 A w3 A w3 A w3 R A w3', { quiet: true });
  console.log(`eeprom writes in ${f.slice(0, 32).padEnd(32)}: ${writes}`);
}
process.exit(fail ? 1 : 0);
