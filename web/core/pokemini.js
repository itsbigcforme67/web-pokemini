// Web Pokémon mini - Copyright (C) 2026 the Web Pokémon mini authors.
// Free software under the GNU General Public License, version 3 or (at your option) any later
// version; see LICENSE. No warranty.
// The hardware behaviour, timings and some tables here follow PokeMini, Copyright (C) JustBurn
// and contributors (GPL-3.0-or-later), https://github.com/libretro/PokeMini
//
// Pokémon mini system emulation: memory map, I/O registers, interrupt controller, timers,
// 256 Hz / seconds counters, PRC (Program Rendering Chip), SED1565 LCD controller,
// EEPROM (I2C, bit-banged by the game), keypad, rumble and the piezo speaker.
// Hardware notes: pokemon-mini.net documentation and the behaviour of the PokeMini emulator.
//
// The core is plain JS with no DOM dependencies. One PokeMini object = one console.

import { S1C88, STATUS } from './s1c88.js';

// Bump when an emulation fix means older save states may be invalid (they're then discarded).
export const STATE_VERSION = 1;

export const CPU_HZ = 4000000;
export const LCD_W = 96, LCD_H = 64;
export const BTN = { A: 1, B: 2, C: 4, UP: 8, DOWN: 16, LEFT: 32, RIGHT: 64, POWER: 128 };
const KEY_IRQ = [0x1C, 0x1B, 0x1A, 0x19, 0x18, 0x17, 0x16, 0x15]; // A B C Up Down Left Right Power

// Power-on values of the I/O registers ($2000-$20FF)
const IO_INIT = new Uint8Array(256).fill(0xFF);
IO_INIT.set([0x7F, 0x20, 0x5C], 0x00);
IO_INIT.set([0x01, 0x00, 0x00, 0x00], 0x08);
IO_INIT[0x10] = 0x08;
IO_INIT.set([0, 0, 0, 0, 0, 0], 0x18);
IO_INIT.set([0x00, 0x30, 0x02, 0x00, 0x02, 0x00, 0x00, 0x40, 0x00, 0xC0, 0x40], 0x20);
IO_INIT.set([0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00, 0xFF, 0xFF], 0x30);
IO_INIT.set([0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00, 0xFF, 0xFF], 0x40);
IO_INIT.set([0xFF, 0x00, 0xFF, 0x00, 0x01, 0x01], 0x50);
IO_INIT.set([0x32, 0x64, 0x00], 0x60);
IO_INIT.set([0x00, 0x00], 0x70);
IO_INIT.set([0x00, 0x07, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0x80);
IO_INIT.set([0, 0, 0, 0, 0, 0, 0, 0], 0xF0);
IO_INIT[0xFE] = 0x40;

// Timer clock sources, as fixed-point (8.24) decrements per CPU cycle
const OSC1_DEC = [0, 0, 0, 0, 0, 0, 0, 0, 2, 8, 32, 64, 128, 256, 1024, 4096].map((d) => (d ? Math.floor(16777216 / d) : 0));
const OSC2_DEC = [0, 0, 0, 0, 0, 0, 0, 0, 122, 244, 488, 977, 1953, 3906, 7812, 15625].map((d) => (d ? Math.floor(16777216 / d) : 0));
const TIMER256_INC = Math.floor(16777216 / 15625);
const PRC_INC = Math.floor(16777216 / 855);
const SYNC_CYCLES = 8;

// LCD contrast (0..63) -> [off-pixel, on-pixel] darkness 0..255
const CONTRAST = [
  [0, 4], [0, 4], [0, 4], [0, 4], [0, 6], [0, 11], [0, 17], [0, 24], [0, 31], [0, 40], [0, 48], [0, 57], [0, 67], [0, 77], [0, 88], [0, 99],
  [0, 110], [0, 122], [0, 133], [0, 146], [0, 158], [0, 171], [0, 184], [0, 198], [0, 212], [0, 226], [0, 240], [0, 255], [2, 255], [5, 255], [10, 255], [15, 255],
  [21, 255], [27, 255], [34, 255], [41, 255], [48, 255], [56, 255], [64, 255], [73, 255], [81, 255], [90, 255], [100, 255], [109, 255], [119, 255], [129, 255], [139, 255], [149, 255],
  [160, 255], [171, 255], [182, 255], [193, 255], [204, 255], [216, 255], [228, 255], [240, 255], [240, 255], [240, 255], [240, 255], [240, 255], [240, 255], [240, 255], [240, 255], [240, 255],
];
const POPCOUNT4 = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
const BITREV = new Uint8Array(256).map((_, i) => {
  let r = 0; for (let b = 0; b < 8; b++) if (i & (1 << b)) r |= 0x80 >> b; return r;
});

// ROM header: "MN" at $2100, game code at $21AC, title at $21B0
export function romInfo(rom) {
  const str = (o, n) => { let s = ''; for (let i = 0; i < n && o + i < rom.length; i++) { const c = rom[o + i]; if (!c) break; s += String.fromCharCode(c); } return s; };
  const valid = rom.length > 0x21C0 && rom[0x2100] === 0x4D && rom[0x2101] === 0x4E;
  return { valid, code: valid ? str(0x21AC, 4) : '', title: valid ? str(0x21B0, 12).replace(/[^\x20-\x7E]/g, '').trim() : '' };
}

export class PokeMini {
  constructor(opts = {}) {
    this.bios = new Uint8Array(0x1000).fill(0xFF);
    if (opts.bios) this.bios.set(opts.bios.subarray(0, 0x1000));
    this.setRom(opts.rom || new Uint8Array(0x2000));
    this.ram = new Uint8Array(0x1000);
    this.io = new Uint8Array(256);
    this.eeprom = new Uint8Array(0x2000).fill(0xFF);
    if (opts.eeprom) this.eeprom.set(opts.eeprom.subarray(0, 0x2000));
    this.lcdData = new Uint8Array(256 * 9);
    this.lcdPix = new Uint8Array(LCD_W * LCD_H);   // last rendered on/off pixels
    this.lcdHist = new Uint8Array(LCD_W * LCD_H);  // last 4 refreshes, 1 bit each (grey levels via flicker)
    this.sampleRate = opts.sampleRate || 44100;
    this.audioOut = null;      // optional callback(Float32Array)
    this.onEepromWrite = null; // callback() when the game writes its save EEPROM
    this.onFrame = null;       // callback() on every LCD refresh (~72 Hz)
    this.cpu = new S1C88(this);
    this.powerOn(opts.date);
  }

  setRom(rom) {
    let size = 0x2000;
    while (size < rom.length && size < 0x200000) size <<= 1;
    this.rom = new Uint8Array(size).fill(0xFF);
    this.rom.set(rom.subarray(0, size));
    this.romMask = size - 1;
  }

  // Full power-on: clear RAM, reset all hardware, start the BIOS.
  powerOn(date) {
    this.ram.fill(0xFF);
    this.io.set(IO_INIT);
    this.masterIrq = 1;
    this.io[0x27] = this.io[0x28] = this.io[0x29] = this.io[0x2A] = 0;
    // timers
    this.secCnt = 0; this.secFrac = 0; this.tmr256 = 0;
    this.tDecA = [0, 0, 0]; this.tDecB = [0, 0, 0];
    this.tCntA = [0, 0, 0]; this.tCntB = [0, 0, 0];
    this.tPreA = [0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF]; this.tPreB = [0xFFFFFFFF, 0xFFFFFFFF, 0xFFFFFFFF];
    this.tWide = [0, 0, 0]; this.tEnaA = [0, 0, 0]; this.tEnaB = [0, 0, 0];
    this.t3cnt16 = 0; this.t3piv = 0; this.osc1 = 0; this.osc2 = 0;
    // PRC
    this.prcCnt = 0; this.prcBG = 0; this.prcSpr = 0; this.prcMode = 0; this.prcRateMatch = 0x10;
    this.prcMapPX = 0; this.prcMapPY = 0; this.prcMapTW = 12; this.prcMapTH = 16; this.prcState = 0; this.stall = 0;
    // LCD controller
    this.lcdData.fill(0); this.lcdPix.fill(0); this.lcdHist.fill(0);
    this.lcd = { column: 0, startLine: 0, setContrast: 0, contrast: 0x1F, segDir: 0, maxContrast: 0, allOn: 0, invert: 0, on: 0, page: 0, rowOrder: 0, rmw: 0, dummyRead: 0, rmwColumn: 0 };
    this.lcdContrast(0x1F);
    // I/O port, EEPROM bus
    this.eep = { lastPins: 0, listen: 0, oper: 0, data: 0, bit: 0, addr: 0 };
    this.keys = 0xFF; this.io[0x52] = 0xFF;
    this.rumble = false; this.rumbleLatch = false; this.shockHeld = false;
    // audio
    this.audioAcc = 0; this.audioCyc = 0; this.audioPos = 0; this.audioBuf = new Float32Array(512);
    this.hpPrevIn = 0; this.hpPrevOut = 0; this.vol = 0;
    // run state
    this.cycles = 0; this.time = 0; this.frames = 0; this.cycleDebt = 0;
    this.cpu.f = 0xC0; this.cpu.shiftU = 0;
    this.cpu.reset(2);
    if (!this.eepromFormatted()) this.formatEeprom();
    this.syncClock(date || new Date());
  }

  // A factory-fresh EEPROM is blank; the first game to run formats it (and that wipes the clock).
  // Formatting it up front, exactly as the console does, makes the first boot behave like any other.
  eepromFormatted() { const e = this.eeprom; return e[0] === 0x47 && e[1] === 0x42 && e[2] === 0x4D && e[3] === 0x4E; } // "GBMN"
  formatEeprom() {
    const e = this.eeprom;
    e.fill(0, 0, 0x90);
    e.set([0x47, 0x42, 0x4D, 0x4E], 0);
    e.set([0x01, 0x03, 0x01, 0x1F], 0x1FF2);
    e.fill(0, 0x1FF6, 0x2000);
  }

  // The BIOS keeps the time as "EEPROM timestamp + seconds counter". Setting both from the
  // host clock skips the BIOS clock-setting screen, like a real unit whose clock was already set.
  syncClock(d = new Date()) {
    const e = this.eeprom;
    const y = d.getFullYear() % 100, mo = d.getMonth() + 1, da = d.getDate(), h = d.getHours(), mi = d.getMinutes(), s = d.getSeconds();
    this.io[0x02] |= 0x02;
    e[0x1FF6] = 0; e[0x1FF7] = 0; e[0x1FF8] = 0;
    e[0x1FF9] = y; e[0x1FFA] = mo; e[0x1FFB] = da; e[0x1FFC] = h; e[0x1FFD] = mi; e[0x1FFE] = s;
    e[0x1FFF] = (y + mo + da + h + mi + s) & 0xFF;
    this.io[0x08] = 0x01;
    this.secCnt = 0; this.secFrac = 0;
  }

  // ======================================================================== memory map
  read(addr) {
    if (addr >= 0x2100) {
      if (addr >= 0x200000) return this.cpu.ir; // open bus
      return this.rom[addr & this.romMask];
    }
    if (addr >= 0x2000) return this.ioRead(addr & 0xFF);
    if (addr >= 0x1000) return this.ram[addr - 0x1000];
    return this.bios[addr];
  }

  write(addr, v) {
    if (addr >= 0x2100) return;
    if (addr >= 0x2000) { this.ioWrite(addr & 0xFF, v); return; }
    if (addr >= 0x1000) this.ram[addr - 0x1000] = v;
  }

  ioRead(r) {
    const io = this.io;
    switch (r) {
      case 0x00: case 0x01: case 0x02: return io[r];
      // seconds counter
      case 0x08: return io[0x08] & 1;
      case 0x09: return this.secCnt & 0xFF;
      case 0x0A: return (this.secCnt >> 8) & 0xFF;
      case 0x0B: return (this.secCnt >> 16) & 0xFF;
      case 0x10: return io[0x10];
      // timers
      case 0x18: case 0x1A: case 0x1C: return io[r];
      case 0x19: return io[0x19] & 0x33;
      case 0x1B: case 0x1D: return io[r] & 0x03;
      case 0x30: case 0x38: case 0x48: return io[r] & (io[r] & 0x80 ? 0x85 : 0x0D);
      case 0x31: case 0x39: case 0x49: return io[r] & (io[r - 1] & 0x80 ? 0x08 : 0x0D);
      case 0x32: case 0x3A: case 0x4A: return this.tPreA[this.tIdx(r)] >>> 24;
      case 0x33: case 0x3B: case 0x4B: return this.tPreB[this.tIdx(r)] >>> 24;
      case 0x34: case 0x35: case 0x3C: case 0x3D: return io[r];
      case 0x4C: return this.t3piv & 0xFF;
      case 0x4D: return this.t3piv >> 8;
      case 0x36: case 0x3E: case 0x4E: return this.tCntA[this.tIdx(r)] >>> 24;
      case 0x37: case 0x3F: case 0x4F: return this.tCntB[this.tIdx(r)] >>> 24;
      case 0x40: return io[0x40];
      case 0x41: return this.tmr256 >>> 24;
      // IRQ controller
      case 0x20: case 0x21: case 0x23: case 0x25: case 0x27: case 0x29: return io[r];
      case 0x22: return io[r] & 0x03;
      case 0x24: case 0x28: return io[r] & 0x3F;
      case 0x26: case 0x2A: return io[r] & 0xF7;
      // misc I/O
      case 0x44: case 0x45: case 0x46: case 0x47:
      case 0x50: case 0x51: case 0x53: case 0x54: case 0x55: case 0x60: case 0x62:
        return io[r];
      case 0x52: return io[0x52];
      case 0x61: {
        const dir = io[0x60];
        const input = this.eepRead() ? 0x04 : 0;
        return (io[0x61] & dir) | (input & ~dir);
      }
      // audio
      case 0x70: case 0x71: return io[r] & 0x07;
      // PRC
      case 0x80: return io[0x80] & 0x3F;
      case 0x81: return io[0x81];
      case 0x82: return io[0x82] & 0xF8;
      case 0x83: case 0x88: return io[r];
      case 0x84: case 0x89: return io[r] & 0x1F;
      case 0x85: case 0x86: return io[r] & 0x7F;
      case 0x87: return io[0x87] & 0xC0;
      case 0x8A: return (this.prcCnt >>> 24) & 0xFF;
      case 0x8B: case 0x8C: case 0x8D: case 0x8E: case 0x8F: return 0;
      // colour PRC (not fitted)
      case 0xF0: case 0xF1: case 0xF2: case 0xF3: case 0xF4: case 0xF5: case 0xF6: case 0xF7: return 0;
      // LCD
      case 0xFE: return this.lcdReadCtrl();
      case 0xFF: return this.lcdRead();
      default: return this.cpu.ir; // open bus
    }
  }

  ioWrite(r, v) {
    const io = this.io;
    switch (r) {
      case 0x00: case 0x01: case 0x02: io[r] = v; return;
      case 0x08: if (v & 0x02) this.secCnt = 0; io[0x08] = v & 1; return;
      case 0x10: io[0x10] = (io[0x10] & 0x20) | (v & 0x1F); return;
      // timers
      case 0x18: io[r] = v; this.timerScale(0); return;
      case 0x19:
        io[0x19] = v & 0x33;
        this.osc2 = v & 0x10; this.osc1 = v & 0x20;
        this.timerScale(0); this.timerScale(1); this.timerScale(2);
        return;
      case 0x1A: io[r] = v; this.timerScale(1); return;
      case 0x1B: io[r] = v & 3; this.timerScale(1); return;
      case 0x1C: io[r] = v; this.timerScale(2); return;
      case 0x1D: io[r] = v & 3; this.timerScale(2); return;
      case 0x30: case 0x38: case 0x48: {
        const t = this.tIdx(r);
        io[r] = v & 0x8D;
        this.tEnaA[t] = v & 0x04;
        this.tWide[t] = v & 0x80 ? 1 : 0;
        if (v & 0x02) { this.tCntA[t] = this.tPreA[t]; if (this.tWide[t]) this.tCntB[t] = this.tPreB[t]; }
        return;
      }
      case 0x31: case 0x39: case 0x49: {
        const t = this.tIdx(r);
        io[r] = v & 0x0D;
        this.tEnaB[t] = v & 0x04;
        if (!this.tWide[t] && (v & 0x02)) this.tCntB[t] = this.tPreB[t];
        return;
      }
      case 0x32: case 0x3A: case 0x4A: this.tPreA[this.tIdx(r)] = (v << 24) >>> 0; return;
      case 0x33: case 0x3B: case 0x4B: this.tPreB[this.tIdx(r)] = (v << 24) >>> 0; return;
      case 0x34: case 0x35: case 0x3C: case 0x3D: io[r] = v; return;
      case 0x4C: this.t3piv = (this.t3piv & 0xFF00) | v; return;
      case 0x4D: this.t3piv = (this.t3piv & 0x00FF) | (v << 8); return;
      case 0x40: io[0x40] = v & 1; if (v & 0x02) this.tmr256 = 0; return;
      // IRQ controller
      case 0x20: case 0x21: case 0x22: case 0x23: case 0x25: io[r] = v; this.irqProcess(); return;
      case 0x24: io[r] = v & 0x3F; this.irqProcess(); return;
      case 0x26: io[r] = v & 0xF7; this.irqProcess(); return;
      case 0x27: case 0x28: case 0x29: case 0x2A: io[r] &= ~v; return; // write 1 to acknowledge
      // misc I/O
      case 0x44: io[r] = v & 0xF7; return;
      case 0x45: case 0x47: io[r] = v & 0x0F; return;
      case 0x46: case 0x50: io[r] = v; return;
      case 0x51: io[r] = v & 0x03; return;
      case 0x53: io[r] = 0; return;
      case 0x54: io[r] = v & 0x77; return;
      case 0x55: io[r] = v & 0x07; return;
      case 0x60: case 0x61: io[r] = v; this.ioPortWrite(); return;
      case 0x62: io[r] = v & 0xF0; return;
      // audio
      case 0x70: case 0x71: io[r] = v & 0x07; this.audioVolume(); return;
      // PRC
      case 0x80:
        io[0x80] = v & 0x3F;
        this.prcMode = v & 0x08 ? (v & 0x06 ? 2 : 1) : 0;
        switch (v & 0x30) {
          case 0x00: this.prcMapTW = 12; this.prcMapTH = 16; break;
          case 0x10: this.prcMapTW = 16; this.prcMapTH = 12; break;
          case 0x20: this.prcMapTW = 24; this.prcMapTH = 8; break;
          default: this.prcMapTW = 24; this.prcMapTH = 16; break;
        }
        return;
      case 0x81:
        if ((io[0x81] & 0x0E) !== (v & 0x0E)) io[0x81] = v & 0x0F;
        else io[0x81] = (io[0x81] & 0xF0) | (v & 0x0F);
        this.prcRateMatch = [0x20, 0x50, 0x80, 0xB0, 0x10, 0x30, 0x50, 0x70][(v >> 1) & 7];
        return;
      case 0x82: io[r] = v & 0xF8; this.prcBG = (this.prcBG & 0x1FFF00) | io[r]; return;
      case 0x83: io[r] = v; this.prcBG = (this.prcBG & 0x1F00F8) | (v << 8); return;
      case 0x84: io[r] = v & 0x1F; this.prcBG = (this.prcBG & 0x00FFF8) | (io[r] << 16); return;
      case 0x85: io[r] = v & 0x7F; if (io[r] <= this.prcMapTH * 8 - 64) this.prcMapPY = io[r]; return;
      case 0x86: io[r] = v & 0x7F; if (io[r] <= this.prcMapTW * 8 - 96) this.prcMapPX = io[r]; return;
      case 0x87: io[r] = v & 0xC0; this.prcSpr = (this.prcSpr & 0x1FFF00) | io[r]; return;
      case 0x88: io[r] = v; this.prcSpr = (this.prcSpr & 0x1F00C0) | (v << 8); return;
      case 0x89: io[r] = v & 0x1F; this.prcSpr = (this.prcSpr & 0x00FFC0) | (io[r] << 16); return;
      // LCD
      case 0xFE: this.lcdWriteCtrl(v); return;
      case 0xFF: this.lcdWrite(v); return;
    }
  }

  tIdx(r) { return r < 0x38 ? 0 : r < 0x40 ? 1 : 2; }

  // ======================================================================== interrupts
  // IRQ sources: number -> [active register, bit]
  setIrq(n) {
    const io = this.io;
    if (n >= 0x03 && n <= 0x0A) io[0x27] |= 0x80 >> (n - 0x03);
    else if (n >= 0x0B && n <= 0x0E) io[0x28] |= 0x20 >> (n - 0x0B);
    else if (n === 0x0F) io[0x2A] |= 0x80;
    else if (n === 0x10) io[0x2A] |= 0x40;
    else if (n === 0x13) io[0x28] |= 0x02;
    else if (n === 0x14) io[0x28] |= 0x01;
    else if (n >= 0x15 && n <= 0x1C) io[0x29] |= 0x80 >> (n - 0x15);
    this.irqProcess();
  }

  // called by the CPU whenever F or the U-shift changes
  irqHandle(f, shiftU) {
    if (shiftU) this.masterIrq = 0;
    else if ((f & 0xC0) === 0xC0) this.masterIrq = 0;
    else { this.masterIrq = 1; this.irqProcess(); }
  }

  irqProcess() {
    if (!this.masterIrq) return;
    const io = this.io;
    const p1 = io[0x20], p2 = io[0x21], p3 = io[0x22];
    const e1 = io[0x23], e2 = io[0x24], e3 = io[0x25], e4 = io[0x26];
    const a1 = io[0x27] & e1, a2 = io[0x28] & e2, a3 = io[0x29] & e3, a4 = io[0x2A] & e4;
    let n = 0;
    if ((p1 & 0xC0) && (a1 & 0xC0)) n = a1 & 0x80 ? 0x03 : 0x04;
    else if ((p1 & 0x30) && (a1 & 0x30)) n = a1 & 0x20 ? 0x05 : 0x06;
    else if ((p1 & 0x0C) && (a1 & 0x0C)) n = a1 & 0x08 ? 0x07 : 0x08;
    else if ((p1 & 0x03) && (a1 & 0x03)) n = a1 & 0x02 ? 0x09 : 0x0A;
    else if ((p2 & 0xC0) && (a2 & 0x3C)) n = 0x0B + firstBit(a2, 0x20, 4);
    else if ((p3 & 0x03) && (a4 & 0xC0)) n = a4 & 0x80 ? 0x0F : 0x10;
    else if ((p2 & 0x30) && (a2 & 0x03)) n = a2 & 0x02 ? 0x13 : 0x14;
    else if ((p2 & 0x0C) && a3) n = 0x15 + firstBit(a3, 0x80, 8);
    else if ((p2 & 0x03) && (a4 & 0x07)) n = 0x1D + firstBit(a4, 0x04, 3);
    if (n) this.cpu.requestIrq(n << 1);
  }

  // ======================================================================== timers
  timerScale(t) {
    const io = this.io;
    const scale = io[0x18 + t * 2];
    const osc = t === 0 ? io[0x19] : io[0x1B + (t - 1) * 2];
    const dec = (useOsc2, s) => (useOsc2 ? (this.osc2 ? OSC2_DEC[s] : 0) : (this.osc1 ? OSC1_DEC[s] : 0));
    this.tDecA[t] = dec(osc & 1, scale & 15);
    this.tDecB[t] = dec(osc & 2, scale >> 4);
  }

  timersSync(cyc) {
    const io = this.io;
    // 256 Hz counter: 32 / 8 / 2 / 1 Hz interrupts
    if (io[0x40]) {
      const pre = this.tmr256;
      const now = (pre + TIMER256_INC * cyc) >>> 0;
      this.tmr256 = now;
      const ch = pre ^ now;
      if (ch & 0x08000000) this.setIrq(0x0B);
      if (ch & 0x20000000) this.setIrq(0x0C);
      if (ch & 0x80000000) this.setIrq(0x0D);
      if (pre > now) this.setIrq(0x0E);
    }
    // seconds counter
    if (io[0x08]) {
      this.secFrac += cyc;
      if (this.secFrac >= CPU_HZ) { this.secFrac -= CPU_HZ; this.secCnt = (this.secCnt + 1) & 0xFFFFFF; }
    }
    // timers 1-3 (count down; 8.24 fixed point)
    for (let t = 0; t < 3; t++) {
      if (!this.tEnaA[t] && !this.tEnaB[t]) continue;
      const irqHi = t === 0 ? 0x07 : t === 1 ? 0x05 : 0x09;
      if (this.tWide[t]) {
        if (!this.tEnaA[t]) continue;
        const pre = this.tCntA[t];
        const now = (pre - this.tDecA[t] * cyc) >>> 0;
        this.tCntA[t] = now;
        if (pre < now) { // low byte underflow
          const preB = this.tCntB[t];
          const nowB = (preB - 0x01000000) >>> 0;
          this.tCntB[t] = nowB;
          if (preB < nowB) {
            this.tCntA[t] = this.tPreA[t];
            this.tCntB[t] = this.tPreB[t];
            this.setIrq(irqHi);
          }
          if (t === 2) this.t3cnt16 = (this.t3cnt16 & 0xFF) | ((this.tCntB[2] >>> 24) << 8);
        }
        if (t === 2) {
          const prev = this.t3cnt16;
          this.t3cnt16 = (this.t3cnt16 & 0xFF00) | (this.tCntA[2] >>> 24);
          if (prev > this.t3piv && this.t3cnt16 <= this.t3piv) this.setIrq(0x0A);
        }
      } else {
        if (this.tEnaA[t]) {
          const pre = this.tCntA[t];
          const now = (pre - this.tDecA[t] * cyc) >>> 0;
          this.tCntA[t] = now;
          if (pre < now) {
            this.tCntA[t] = this.tPreA[t];
            if (t !== 2) this.setIrq(t === 0 ? 0x08 : 0x06);
          }
          if (t === 2) this.t3cnt16 = (this.t3cnt16 & 0xFF00) | (this.tCntA[2] >>> 24);
        }
        if (this.tEnaB[t]) {
          const pre = this.tCntB[t];
          const now = (pre - this.tDecB[t] * cyc) >>> 0;
          this.tCntB[t] = now;
          if (pre < now) {
            this.tCntB[t] = this.tPreB[t];
            this.setIrq(irqHi);
          }
          if (t === 2) {
            const prev = this.t3cnt16;
            this.t3cnt16 = (this.t3cnt16 & 0xFF) | ((this.tCntB[2] >>> 24) << 8);
            if (prev > this.t3piv && this.t3cnt16 <= this.t3piv) this.setIrq(0x0A);
          }
        }
      }
    }
  }

  // ======================================================================== PRC
  prcSync(cyc) {
    this.prcCnt = (this.prcCnt + PRC_INC * cyc) | 0;
    const io = this.io;
    if ((io[0x81] & 0xF0) >= this.prcRateMatch) {
      // active frame
      const hi = this.prcCnt & 0xFF000000;
      if (this.prcCnt < 0x18000000) {
        this.prcState = 0;
      } else if (hi === 0x18000000) {
        if (this.prcState === 1) return;
        if (this.prcMode === 2) {
          this.stall = 1;
          this.prcRender();
          this.prcState = 1;
        }
      } else if (hi === 0x39000000) {
        if (this.prcState === 2) return;
        if (this.prcMode) {
          this.stall = 1;
          this.prcCopyToLcd();
          this.setIrq(0x03);
          this.prcState = 2;
        }
      } else if (this.prcCnt >= 0x42000000) {
        this.stall = 0;
        io[0x81] &= 0x0F;
        this.prcCnt = 0x01000000;
        this.setIrq(0x04);
        this.refresh();
      }
    } else if (this.prcCnt >= 0x42000000) {
      io[0x81] = (io[0x81] + 0x10) & 0xFF;
      this.prcCnt = 0x01000000;
      this.refresh();
    }
  }

  prcRender() {
    const ram = this.ram, io = this.io;
    const mode = io[0x80];
    if (mode & 0x02) { // background map
      const TW = this.prcMapTW, PX = this.prcMapPX, PY = this.prcMapPY, base = this.prcBG, inv = mode & 0x01;
      let out = 0, lastIdx = -1, top = 0, bot = 0;
      for (let yC = 0; yC < 8; yC++) {
        const ty = (yC << 3) + PY, sh = ty & 7;
        for (let xC = 0; xC < 96; xC++) {
          const tx = xC + PX;
          const idx = 0x1360 + (ty >> 3) * TW + (tx >> 3);
          if (idx !== lastIdx) {
            top = base + this.read(idx) * 8;
            bot = base + this.read(idx + TW) * 8;
            lastIdx = idx;
          }
          let data = ((this.read(top + (tx & 7)) >> sh) | (this.read(bot + (tx & 7)) << (8 - sh))) & 0xFF;
          if (inv) data ^= 0xFF;
          ram[out++] = data;
        }
      }
    }
    if (mode & 0x04) { // sprites: 24 entries at $1300, drawn from last to first (entry 0 on top)
      for (let s = 23; s >= 0; s--) {
        const o = 0x300 + s * 4;
        const cfg = ram[o + 3];
        if (!(cfg & 0x08)) continue;
        const sx = (ram[o] & 0x7F) - 16, sy = (ram[o + 1] & 0x7F) - 16, tb = ram[o + 2] * 8;
        const fx = cfg & 1 ? 8 : 0, fy = cfg & 2 ? 8 : 0;
        this.drawSprite8(cfg, sx + fx, sy + fy, tb + 2, tb);
        this.drawSprite8(cfg, sx + fx, sy + 8 - fy, tb + 3, tb + 1);
        this.drawSprite8(cfg, sx + 8 - fx, sy + fy, tb + 6, tb + 4);
        this.drawSprite8(cfg, sx + 8 - fx, sy + 8 - fy, tb + 7, tb + 5);
      }
    }
  }

  drawSprite8(cfg, X, Y, drawT, maskT) {
    if (X < -7 || X >= 96 || Y < -7 || Y >= 64) return;
    const ram = this.ram, base = this.prcSpr;
    const sh = Y & 7;
    let vaddr = ((Y >> 3) * 96) + X;
    const pass = (rowAddr, top) => {
      for (let xC = 0; xC < 8; xC++) {
        const px = X + xC;
        if (px < 0 || px >= 96) continue;
        const xP = cfg & 1 ? 7 - xC : xC;
        let sdata = this.read(base + drawT * 8 + xP), smask = this.read(base + maskT * 8 + xP);
        if (cfg & 2) { sdata = BITREV[sdata]; smask = BITREV[smask]; }
        if (cfg & 4) sdata ^= 0xFF;
        const a = rowAddr + xC;
        let data;
        if (top) {
          data = ram[a] & (((smask << sh) | (0xFF >> (8 - sh))) & 0xFF);
          data |= ((sdata & ~smask) << sh) & 0xFF;
        } else {
          data = ram[a] & ((smask >> (8 - sh)) | (0xFF << sh)) & 0xFF;
          data |= (sdata & ~smask & 0xFF) >> (8 - sh);
        }
        ram[a] = data & 0xFF;
      }
    };
    if (Y >= 0) pass(vaddr, true);
    vaddr += 96;
    if (Y < 56 && sh) pass(vaddr, false);
  }

  prcCopyToLcd() {
    const d = this.lcdData, ram = this.ram;
    for (let p = 0; p < 8; p++) {
      if (this.lcd.segDir) for (let i = 0; i < 96; i++) d[p * 256 + 131 - i] = ram[p * 96 + i];
      else d.set(ram.subarray(p * 96, p * 96 + 96), p * 256);
    }
    const l = this.lcd;
    l.page = 7; l.column = 96; l.dummyRead = 1; l.rmw = 0;
  }

  // ======================================================================== LCD controller (SED1565)
  lcdContrast(v) {
    const l = this.lcd;
    l.contrast = v & 0x3F;
    const c = l.maxContrast ? [240, 255] : CONTRAST[l.contrast];
    this.pix0 = c[0]; this.pix1 = c[1];
  }
  lcdReadCtrl() {
    const l = this.lcd;
    if (l.setContrast) { l.setContrast = 0; this.lcdContrast(0x3F); return 0; }
    return 0x40 | (l.on ? 0x20 : 0);
  }
  lcdRead() {
    const l = this.lcd;
    if (l.setContrast) { l.setContrast = 0; this.lcdContrast(0x3F); return (this.lcdLast = 0); }
    if (!l.dummyRead) {
      let data = this.lcdData[(l.segDir ? 131 - l.column : l.column) + (l.page << 8)];
      if (l.page >= 8) data &= 1;
      if (!l.rmw) { l.column = Math.min(131, l.column + 1); l.dummyRead = 1; }
      this.lcdLast = data;
    } else l.dummyRead = 0;
    return this.lcdLast === undefined ? 0x40 : this.lcdLast;
  }
  lcdWriteCtrl(v) {
    const l = this.lcd;
    if (l.setContrast) { l.setContrast = 0; this.lcdContrast(v & 0x3F); return; }
    if (v < 0x10) { if (!l.rmw) { l.column = (l.column & 0xF0) | (v & 0x0F); l.dummyRead = 1; } return; }
    if (v < 0x20) { if (!l.rmw) { l.column = (l.column & 0x0F) | ((v & 0x0F) << 4); l.dummyRead = 1; } return; }
    if (v >= 0x40 && v < 0x80) { l.startLine = v - 0x40; return; }
    if (v >= 0xB0 && v <= 0xB8) { l.page = v & 15; return; }
    if (v >= 0xC0 && v < 0xD0) { l.rowOrder = v >= 0xC8 ? 1 : 0; return; }
    switch (v) {
      case 0x81: l.setContrast = 1; return;
      case 0xA0: case 0xA1: l.segDir = v & 1; return;
      case 0xA2: case 0xA3: l.maxContrast = v & 1; this.lcdContrast(l.contrast); return;
      case 0xA4: case 0xA5: l.allOn = v & 1; return;
      case 0xA6: case 0xA7: l.invert = v & 1; return;
      case 0xAE: case 0xAF: l.on = v & 1; return;
      case 0xE0: l.rmw = 1; l.rmwColumn = l.column; return;
      case 0xE2:
        Object.assign(l, { setContrast: 0, column: 0, startLine: 0, segDir: 0, maxContrast: 0, allOn: 0, invert: 0, on: 0, page: 0, rowOrder: 0, rmw: 0, dummyRead: 1, rmwColumn: 0 });
        this.lcdContrast(0x20);
        return;
      case 0xEE: l.rmw = 0; l.column = l.rmwColumn; return;
    }
  }
  lcdWrite(v) {
    const l = this.lcd;
    if (l.setContrast) { l.setContrast = 0; this.lcdContrast(v & 0x3F); return; }
    const addr = (l.segDir ? 131 - l.column : l.column) + (l.page << 8);
    if (addr >= 0 && addr < this.lcdData.length) this.lcdData[addr] = v;
    l.column = Math.min(131, l.column + 1);
    l.dummyRead = 1;
  }

  // ~72 Hz panel refresh: latch the controller RAM into pixels and the flicker history
  refresh() {
    const l = this.lcd, pix = this.lcdPix, hist = this.lcdHist, d = this.lcdData;
    if (l.on) {
      for (let y = 0; y < 64; y++) {
        let yp = (y + l.startLine) & 63;
        if (l.rowOrder) yp = 63 - yp;
        const row = (yp >> 3) * 256, bit = yp & 7;
        for (let x = 0; x < 96; x++) {
          const p = (((d[row + x] >> bit) & 1) ^ l.invert) | l.allOn;
          const i = y * 96 + x;
          pix[i] = p;
          hist[i] = (p << 3) | (hist[i] >> 1);
        }
      }
    } else {
      pix.fill(0);
      for (let i = 0; i < hist.length; i++) hist[i] >>= 1;
    }
    this.frames++;
    if (this.onFrame) this.onFrame();
  }

  // 96x64 darkness values 0..255. Games make grey by flickering pixels between refreshes,
  // so each pixel blends its last 4 refreshes, like the slow LCD on the real console.
  getFrame(out = new Uint8Array(LCD_W * LCD_H)) {
    const hist = this.lcdHist, p0 = this.pix0, p1 = this.pix1;
    const lvl = [0, 1, 2, 3, 4].map((n) => (p0 * (4 - n) + p1 * n) >> 2);
    for (let i = 0; i < out.length; i++) out[i] = lvl[POPCOUNT4[hist[i]]];
    return out;
  }

  // ======================================================================== I/O port: EEPROM, rumble
  ioPortWrite() {
    const dir = this.io[0x60];
    const out = (0x40 & ~dir) | (this.io[0x61] & dir);
    this.rumble = !!(out & 0x10);
    if (this.rumble) this.rumbleLatch = true; // stays set until the UI reads it (pulses are short)
    this.eepPins(out & 0xFF);
  }

  eepPins(bits) {
    const e = this.eep;
    const rise = bits & ~e.lastPins, fall = ~bits & e.lastPins;
    e.lastPins = bits;
    if ((fall & 0x04) && (bits & 0x08)) { e.listen = 1; e.oper = 0; e.bit = 8; e.data = 0; return; } // start
    if ((rise & 0x04) && (bits & 0x08)) { e.listen = 0; return; } // stop
    if (!e.listen) return;
    if (rise & 0x08) {
      if (e.bit < 0) { this.eepByte(e.data); e.bit = 8; e.data = 0; }
      else e.data = ((e.data << 1) | ((bits >> 2) & 1)) & 0xFF;
    } else if (fall & 0x08) e.bit--;
  }

  eepRead() {
    const e = this.eep;
    const valid = e.bit >= 0 && e.bit < 8;
    if (!e.listen) return 1;
    if (e.oper === 4) return valid ? (this.eeprom[e.addr & 0x1FFF] >> e.bit) & 1 : 0;
    return valid ? 1 : 0;
  }

  eepByte(data) {
    const e = this.eep;
    switch (e.oper) {
      case 0: if ((data & 0xF0) === 0xA0) e.oper = data & 1 ? 4 : 1; break; // device select
      case 1: e.addr = (e.addr & 0x00FF) | (data << 8); e.oper = 2; break;
      case 2: e.addr = (e.addr & 0xFF00) | data; e.oper = 3; break;
      case 3:
        this.eeprom[e.addr & 0x1FFF] = data;
        e.addr = (e.addr + 1) & 0xFFFF;
        this.eepromDirty = true;
        if (this.onEepromWrite) this.onEepromWrite();
        break;
      case 4: e.addr = (e.addr + 1) & 0xFFFF; break;
    }
  }

  // ======================================================================== input
  // mask: BTN bits (1 = pressed)
  setButtons(mask) {
    for (let b = 0; b < 8; b++) {
      const bit = 1 << b;
      const down = (mask & bit) !== 0, wasDown = (this.keys & bit) === 0;
      if (down && !wasDown) { this.keys &= ~bit; this.setIrq(KEY_IRQ[b]); }
      else if (!down && wasDown) this.keys |= bit;
    }
    this.io[0x52] = this.keys;
  }

  // shock sensor (shake): Pokémon Pinball Mini uses it to nudge the table
  shake() { this.setIrq(0x10); }

  // ======================================================================== sound
  audioVolume() {
    const io = this.io;
    if (io[0x70] & 0x03) this.vol = 0;
    else this.vol = [0, 0.5, 0.5, 1][io[0x71] & 3];
  }

  // The piezo is driven by timer 3: high while the 16-bit count is at or below the pivot.
  // The level is integrated per CPU sync step and box-filtered into output samples.
  audioSync(cyc) {
    if (!this.audioOut) return;
    let level = 0;
    if (this.vol && this.tEnaA[2] && this.tWide[2]) {
      const pre = (this.tPreA[2] >>> 24) | ((this.tPreB[2] >>> 24) << 8);
      if (pre >= 2 && this.t3cnt16 <= this.t3piv) level = this.vol;
    }
    const per = CPU_HZ / this.sampleRate;
    let c = cyc;
    while (c > 0) {
      const take = Math.min(c, per - this.audioCyc);
      this.audioAcc += level * take;
      this.audioCyc += take;
      c -= take;
      if (this.audioCyc >= per - 1e-9) {
        const s = this.audioAcc / per;
        // simple DC-blocking high-pass (piezo speakers don't reproduce DC)
        const out = s - this.hpPrevIn + 0.995 * this.hpPrevOut;
        this.hpPrevIn = s; this.hpPrevOut = out;
        this.audioBuf[this.audioPos++] = out;
        if (this.audioPos === this.audioBuf.length) { this.audioOut(this.audioBuf); this.audioPos = 0; }
        this.audioAcc = 0; this.audioCyc -= per;
      }
    }
  }

  // ======================================================================== main loop
  // Run for `seconds` of emulated time (the same structure as the hardware: the CPU runs in
  // short bursts, then timers, PRC and sound catch up).
  runCycles(n) {
    const cpu = this.cpu;
    let budget = n + this.cycleDebt;
    while (budget > 0) {
      let hw = 0;
      while (hw < SYNC_CYCLES) hw += this.stall ? 32 : cpu.step();
      this.timersSync(hw);
      this.prcSync(hw);
      this.audioSync(hw);
      budget -= hw;
      this.cycles += hw;
    }
    this.cycleDebt = budget;
    this.time = this.cycles / CPU_HZ;
  }
  runFor(seconds) { this.runCycles(Math.round(seconds * CPU_HZ)); }

  // ======================================================================== save states
  saveState() {
    return {
      v: STATE_VERSION,
      cpu: this.cpu.saveState(),
      ram: this.ram.slice(), io: this.io.slice(), eeprom: this.eeprom.slice(),
      lcdData: this.lcdData.slice(), lcdPix: this.lcdPix.slice(), lcdHist: this.lcdHist.slice(),
      lcd: { ...this.lcd },
      eep: { ...this.eep },
      t: {
        secCnt: this.secCnt, secFrac: this.secFrac, tmr256: this.tmr256,
        tDecA: [...this.tDecA], tDecB: [...this.tDecB], tCntA: [...this.tCntA], tCntB: [...this.tCntB],
        tPreA: [...this.tPreA], tPreB: [...this.tPreB], tWide: [...this.tWide], tEnaA: [...this.tEnaA], tEnaB: [...this.tEnaB],
        t3cnt16: this.t3cnt16, t3piv: this.t3piv, osc1: this.osc1, osc2: this.osc2,
      },
      prc: {
        prcCnt: this.prcCnt, prcBG: this.prcBG, prcSpr: this.prcSpr, prcMode: this.prcMode, prcRateMatch: this.prcRateMatch,
        prcMapPX: this.prcMapPX, prcMapPY: this.prcMapPY, prcMapTW: this.prcMapTW, prcMapTH: this.prcMapTH, prcState: this.prcState, stall: this.stall,
      },
      misc: { masterIrq: this.masterIrq, keys: this.keys, rumble: this.rumble, cycles: this.cycles, frames: this.frames, vol: this.vol, cycleDebt: this.cycleDebt, lcdLast: this.lcdLast },
      savedAt: Date.now(),
    };
  }

  // `date`: when given, the seconds counter is advanced by the real time since the state was saved
  loadState(s, date) {
    if (!s || s.v !== STATE_VERSION) throw new Error('incompatible save state');
    this.cpu.loadState(s.cpu);
    this.ram.set(s.ram); this.io.set(s.io); this.eeprom.set(s.eeprom);
    this.lcdData.set(s.lcdData); this.lcdPix.set(s.lcdPix); this.lcdHist.set(s.lcdHist);
    Object.assign(this.lcd, s.lcd); this.lcdContrast(this.lcd.contrast);
    Object.assign(this.eep, s.eep);
    const t = s.t;
    Object.assign(this, {
      secCnt: t.secCnt, secFrac: t.secFrac, tmr256: t.tmr256,
      tDecA: [...t.tDecA], tDecB: [...t.tDecB], tCntA: [...t.tCntA], tCntB: [...t.tCntB],
      tPreA: [...t.tPreA], tPreB: [...t.tPreB], tWide: [...t.tWide], tEnaA: [...t.tEnaA], tEnaB: [...t.tEnaB],
      t3cnt16: t.t3cnt16, t3piv: t.t3piv, osc1: t.osc1, osc2: t.osc2,
    });
    Object.assign(this, s.prc);
    Object.assign(this, s.misc);
    this.time = this.cycles / CPU_HZ;
    if (date && s.savedAt) {
      const dt = Math.floor((date.getTime() - s.savedAt) / 1000);
      if (dt > 0) this.secCnt = (this.secCnt + dt) & 0xFFFFFF;
    }
  }
}

function firstBit(v, startBit, count) {
  for (let i = 0; i < count; i++) if (v & (startBit >> i)) return i;
  return 0;
}
