// Instruction trace in a fixed text format, for comparing against a reference emulator.
//   node tests/trace.mjs <rom-part> <maxCycles> <fromCycle> ["cycle:mask,cycle:mask"]
import { findRom, boot } from './common.mjs';
const [part, maxc, from, sched = ''] = process.argv.slice(2);
const { pm } = boot(findRom(part));
const cpu = pm.cpu;
const events = sched ? sched.split(',').map((s) => s.split(':').map(Number)) : [];
const hex = (v, n) => v.toString(16).toUpperCase().padStart(n, '0');
const out = [];
let total = 0;
const max = +maxc, start = +from;
while (total < max) {
  while (events.length && total >= events[0][0]) pm.setButtons(events.shift()[1]);
  let hw = 0;
  while (hw < 8) {
    if (pm.stall) hw += 32;
    else {
      if (start >= 0 && total + hw >= start) out.push(`${total + hw} ${hex(cpu.v, 2)}:${hex(cpu.pc, 4)} BA=${hex(cpu.ba, 4)} HL=${hex(cpu.i, 2)}${hex(cpu.hl, 4)} X=${hex(cpu.x, 4)} Y=${hex(cpu.y, 4)} SP=${hex(cpu.sp, 4)} F=${hex(cpu.f, 2)}`);
      hw += cpu.step();
    }
  }
  pm.timersSync(hw); pm.prcSync(hw);
  const before = total;
  total += hw;
  if (start < 0 && Math.floor(before / 1e6) !== Math.floor(total / 1e6)) {
    let h = 0;
    for (const arr of [pm.ram, pm.lcdData, pm.eeprom]) for (let i = 0; i < arr.length; i++) h = (Math.imul(h, 31) + arr[i]) >>> 0;
    out.push(`${total} ${hex(cpu.v, 2)}:${hex(cpu.pc, 4)} BA=${hex(cpu.ba, 4)} F=${hex(cpu.f, 2)} h=${h.toString(16).padStart(8, '0')}`);
  }
  if (out.length > 20000) { process.stdout.write(out.join('\n') + '\n'); out.length = 0; }
}
process.stdout.write(out.join('\n') + (out.length ? '\n' : ''));
let h = 0; for (let i = 0; i < 256 * 9; i++) h = (Math.imul(h, 31) + pm.lcdData[i]) >>> 0;
console.error(`end total=${total} lcdhash=${h.toString(16).padStart(8, '0')}`);
