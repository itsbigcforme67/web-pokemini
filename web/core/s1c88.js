// Web Pokémon mini - Copyright (C) 2026 the Web Pokémon mini authors.
// Free software under the GNU General Public License, version 3 or (at your option) any later
// version; see LICENSE. No warranty.
// The hardware behaviour, timings and some tables here follow PokeMini, Copyright (C) JustBurn
// and contributors (GPL-3.0-or-later), https://github.com/libretro/PokeMini
//
// Epson S1C88 ("Minx") CPU core, as used in the Pokémon mini.
// Plain JS, no dependencies: runs in browsers and in Node.
//
// Register model (24-bit addresses are "bank:16-bit"):
//   BA (A = low, B = high)   HL (+ I bank)   X (+ XI)   Y (+ YI)   SP   PC (+ V bank)
//   N  : high byte of the [N+#nn] page (its bank is I)
//   U  : pending code bank, applied by the branch that immediately follows MOV U
//   F  : flags  Z=01 C=02 V=04 S=08 D(BCD)=10 U(nibble)=20 I0=40 I1=80
//   E  : external condition bits (tested by JX/CALLX)
// Instruction timings and the less-documented corners follow the hardware notes at
// pokemon-mini.net and the behaviour of the established emulators.

export const FLAG = { Z: 0x01, C: 0x02, V: 0x04, S: 0x08, D: 0x10, U: 0x20, I0: 0x40, I1: 0x80 };

export const STATUS = { NORMAL: 0, HALT: 1, STOP: 2, IRQ: 3 };

const sx8 = (v) => (v & 0x80 ? v | 0xFF00 : v);

export class S1C88 {
  constructor(bus) {
    this.bus = bus; // needs read(addr), write(addr, v), irqHandle(f, shiftU)
    this.ba = 0; this.hl = 0; this.i = 0; this.n = 0;
    this.x = 0; this.xi = 0; this.y = 0; this.yi = 0;
    this.sp = 0; this.pc = 0; this.v = 0;
    this.u1 = 0; this.u2 = 0; this.shiftU = 0;
    this.f = 0xC0; this.e = 0; this.ir = 0;
    this.status = STATUS.NORMAL; this.irqVector = 0;
  }

  reset(vectorAddr = 2) {
    this.status = STATUS.NORMAL;
    this.pc = this.read16(vectorAddr);
    this.v = 0;
    this.e = 0x1F;
    this.f = 0xC0;
    this.setU(0);
    this.bus.irqHandle(this.f, this.shiftU);
  }

  // ------------------------------------------------------------ memory helpers
  rd(a) { return this.bus.read(a); }
  wr(a, v) { this.bus.write(a, v & 0xFF); }
  read16(a) { return this.bus.read(a) | (this.bus.read(a + 1) << 8); }

  fetch8() {
    const p = this.pc;
    this.pc = (p + 1) & 0xFFFF;
    return (this.ir = this.bus.read(p & 0x8000 ? (p & 0x7FFF) | (this.v << 15) : p));
  }
  fetch16() { const lo = this.fetch8(); return lo | (this.fetch8() << 8); }

  // addressing modes (all return a 24-bit address)
  aHL() { return (this.i << 16) | this.hl; }
  aX() { return (this.xi << 16) | this.x; }
  aY() { return (this.yi << 16) | this.y; }
  aNN(nn) { return (this.i << 16) | (this.n << 8) | nn; }
  aABS(nnnn) { return (this.i << 16) | nnnn; }
  aXd(d) { return (this.xi << 16) | ((this.x + sx8(d)) & 0xFFFF); }
  aYd(d) { return (this.yi << 16) | ((this.y + sx8(d)) & 0xFFFF); }

  get a() { return this.ba & 0xFF; }
  set a(v) { this.ba = (this.ba & 0xFF00) | (v & 0xFF); }
  get b() { return this.ba >> 8; }
  set b(v) { this.ba = (this.ba & 0x00FF) | ((v & 0xFF) << 8); }
  get l() { return this.hl & 0xFF; }
  set l(v) { this.hl = (this.hl & 0xFF00) | (v & 0xFF); }
  get h() { return this.hl >> 8; }
  set h(v) { this.hl = (this.hl & 0x00FF) | ((v & 0xFF) << 8); }

  push(v) { this.sp = (this.sp - 1) & 0xFFFF; this.bus.write(this.sp, v & 0xFF); }
  pop() { const v = this.bus.read(this.sp); this.sp = (this.sp + 1) & 0xFFFF; return v; }

  setU(val) {
    if (val !== this.u2) this.shiftU = 2;
    this.u1 = val;
    this.u2 = val;
    this.bus.irqHandle(this.f, this.shiftU);
  }
  setF(v) { this.f = v & 0xFF; this.bus.irqHandle(this.f, this.shiftU); }

  // ------------------------------------------------------------ flow control
  jmpRel(off) { // off: 16-bit; target is relative to the last byte of the instruction
    this.v = this.u1; this.u2 = this.u1;
    this.pc = (this.pc + off - 1) & 0xFFFF;
  }
  callRel(off) {
    this.push(this.v); this.push(this.pc >> 8); this.push(this.pc);
    this.jmpRel(off);
  }
  jmpAbs(addr) { this.v = this.u1; this.u2 = this.u1; this.pc = addr & 0xFFFF; }
  ret() {
    const lo = this.pop(), hi = this.pop();
    this.pc = lo | (hi << 8);
    this.v = this.pop();
    this.setU(this.v);
  }
  reti() {
    this.f = this.pop();
    const lo = this.pop(), hi = this.pop();
    this.pc = lo | (hi << 8);
    this.v = this.pop();
    this.setU(this.v);
    this.bus.irqHandle(this.f, this.shiftU);
  }
  callInt(vecAddr) { // used by CINT and hardware interrupts
    this.push(this.v); this.push(this.pc >> 8); this.push(this.pc); this.push(this.f);
    this.f |= 0xC0;
    this.v = this.u1; this.u2 = this.u1;
    this.pc = this.read16(vecAddr);
    this.bus.irqHandle(this.f, this.shiftU);
  }
  jmpInt(vecAddr) {
    this.push(this.f);
    this.f |= 0xC0;
    this.v = this.u1; this.u2 = this.u1;
    this.pc = this.read16(vecAddr);
    this.bus.irqHandle(this.f, this.shiftU);
  }
  // request a hardware interrupt (taken before the next instruction, even from HALT)
  requestIrq(vecAddr) {
    if (this.status === STATUS.IRQ) return false;
    this.status = STATUS.IRQ;
    this.irqVector = vecAddr;
    return true;
  }

  // ------------------------------------------------------------ ALU
  add8(a, b, c = 0) {
    let f = this.f & 0xF0, r;
    switch (f & 0x30) {
      case 0x00: {
        const s = a + b + c;
        r = s & 0xFF;
        if (s > 0xFF) f |= 0x02;
        if ((a ^ r) & ~(a ^ b) & 0x80) f |= 0x04;
        if (r & 0x80) f |= 0x08;
        break;
      }
      case 0x10: { // BCD
        let lo = (a & 15) + (b & 15) + c, hi = (a >> 4) + (b >> 4);
        if (lo >= 10) { lo -= 10; hi++; }
        if (hi >= 10) { hi -= 10; f |= 0x02; }
        r = ((hi << 4) | lo) & 0xFF;
        break;
      }
      case 0x20: { // nibble
        const s = (a & 15) + (b & 15) + c;
        r = s & 15;
        if (s >= 16) f |= 0x02;
        if ((a ^ s) & ~(a ^ b) & 0x08) f |= 0x04;
        if (s & 0x08) f |= 0x08;
        break;
      }
      default: { // BCD + nibble
        let s = (a & 15) + (b & 15) + c;
        if (s >= 10) s += 6;
        r = s & 15;
        if (s >= 16) f |= 0x02;
      }
    }
    if (r === 0) f |= 0x01;
    this.f = f;
    return r;
  }
  sub8(a, b, c = 0) {
    let f = this.f & 0xF0, r;
    switch (f & 0x30) {
      case 0x00: {
        const s = a - b - c;
        r = s & 0xFF;
        if (s < 0) f |= 0x02;
        if ((a ^ r) & (a ^ b) & 0x80) f |= 0x04;
        if (r & 0x80) f |= 0x08;
        break;
      }
      case 0x10: {
        let lo = (a & 15) - (b & 15) - c, hi = (a >> 4) - (b >> 4);
        if (lo < 0) { lo += 10; hi--; }
        if (hi < 0) { hi += 10; f |= 0x02; }
        r = ((hi << 4) | lo) & 0xFF;
        break;
      }
      case 0x20: {
        const s = (a & 15) - (b & 15) - c;
        r = s & 15;
        if (s < 0) f |= 0x02;
        if ((a ^ s) & (a ^ b) & 0x08) f |= 0x04;
        if (s & 0x08) f |= 0x08;
        break;
      }
      default: {
        let s = (a & 15) - (b & 15) - c;
        if (s < 0) { s -= 6; f |= 0x02; }
        r = s & 15;
      }
    }
    if (r === 0) f |= 0x01;
    this.f = f;
    return r;
  }
  adc8(a, b) { return this.add8(a, b, (this.f >> 1) & 1); }
  sbc8(a, b) { return this.sub8(a, b, (this.f >> 1) & 1); }

  add16(a, b, c = 0) {
    const s = a + b + c, r = s & 0xFFFF;
    let f = this.f & 0xF0;
    if (r === 0) f |= 0x01;
    if (s > 0xFFFF) f |= 0x02;
    if ((a ^ r) & ~(a ^ b) & 0x8000) f |= 0x04;
    if (r & 0x8000) f |= 0x08;
    this.f = f;
    return r;
  }
  sub16(a, b, c = 0) {
    const s = a - b - c, r = s & 0xFFFF;
    let f = this.f & 0xF0;
    if (r === 0) f |= 0x01;
    if (s < 0) f |= 0x02;
    if ((a ^ r) & (a ^ b) & 0x8000) f |= 0x04;
    if (r & 0x8000) f |= 0x08;
    this.f = f;
    return r;
  }
  adc16(a, b) { return this.add16(a, b, (this.f >> 1) & 1); }
  sbc16(a, b) { return this.sub16(a, b, (this.f >> 1) & 1); }

  logic(r) { // AND/OR/XOR/NOT result: Z and S, C and V kept
    let f = this.f & 0xF6;
    if (r === 0) f |= 0x01;
    if (r & 0x80) f |= 0x08;
    this.f = f;
    return r;
  }
  and8(a, b) { return this.logic(a & b); }
  or8(a, b) { return this.logic(a | b); }
  xor8(a, b) { return this.logic(a ^ b); }
  inc8(a) { a = (a + 1) & 0xFF; this.f = (this.f & 0xFE) | (a === 0 ? 1 : 0); return a; }
  dec8(a) { a = (a - 1) & 0xFF; this.f = (this.f & 0xFE) | (a === 0 ? 1 : 0); return a; }
  inc16(a) { a = (a + 1) & 0xFFFF; this.f = (this.f & 0xFE) | (a === 0 ? 1 : 0); return a; }
  dec16(a) { a = (a - 1) & 0xFFFF; this.f = (this.f & 0xFE) | (a === 0 ? 1 : 0); return a; }

  shiftOp(op, a) { // op 0..9: SAL SHL SAR SHR ROLC ROL RORC ROR NOT NEG
    let f, r;
    switch (op) {
      case 0: // SAL
        f = this.f & 0xF0;
        if (a & 0x80) f |= 0x02;
        if (((a >> 6) ^ (a >> 7)) & 1) f |= 0x04;
        r = (a << 1) & 0xFF;
        break;
      case 1: // SHL
        f = this.f & 0xF4;
        if (a & 0x80) f |= 0x02;
        r = (a << 1) & 0xFF;
        break;
      case 2: // SAR
        f = this.f & 0xF0;
        if (a & 1) f |= 0x02;
        r = (a & 0x80) | (a >> 1);
        break;
      case 3: // SHR
        f = this.f & 0xF4;
        if (a & 1) f |= 0x02;
        r = a >> 1;
        break;
      case 4: { // ROLC (through carry)
        const c = (this.f >> 1) & 1;
        f = this.f & 0xF4;
        if (a & 0x80) f |= 0x02;
        r = ((a << 1) | c) & 0xFF;
        break;
      }
      case 5: // ROL
        f = this.f & 0xF4;
        if (a & 0x80) f |= 0x02;
        r = ((a << 1) | (a >> 7)) & 0xFF;
        break;
      case 6: { // RORC
        const c = this.f & 0x02 ? 0x80 : 0;
        f = this.f & 0xF4;
        if (a & 1) f |= 0x02;
        r = (a >> 1) | c;
        break;
      }
      case 7: // ROR
        f = this.f & 0xF4;
        if (a & 1) f |= 0x02;
        r = ((a >> 1) | (a << 7)) & 0xFF;
        break;
      case 8: // NOT
        f = this.f & 0xF6;
        r = a ^ 0xFF;
        break;
      default: // NEG
        f = this.f & 0xF0;
        r = (-a) & 0xFF;
        if (r !== 0) f |= 0x02;
        if (r === 0x80) f |= 0x04;
        break;
    }
    if (r === 0) f |= 0x01;
    if (r & 0x80) f |= 0x08;
    this.f = f;
    return r;
  }

  // 8-bit ALU op by index: 0 ADD 1 ADC 2 SUB 3 SBC 4 AND 5 OR 6 CMP 7 XOR
  alu(op, a, b) {
    switch (op) {
      case 0: return this.add8(a, b);
      case 1: return this.adc8(a, b);
      case 2: return this.sub8(a, b);
      case 3: return this.sbc8(a, b);
      case 4: return this.and8(a, b);
      case 5: return this.or8(a, b);
      case 6: this.sub8(a, b); return a;
      default: return this.xor8(a, b);
    }
  }
  // 16-bit ALU op by index: 0 ADD 1 ADC 2 SUB 3 SBC (CMP handled by caller)
  alu16(op, a, b) {
    switch (op & 3) {
      case 0: return this.add16(a, b);
      case 1: return this.adc16(a, b);
      case 2: return this.sub16(a, b);
      default: return this.sbc16(a, b);
    }
  }

  // ------------------------------------------------------------ execute one instruction, return cycles
  step() {
    if (this.shiftU) {
      this.u1 = this.u2;
      this.u2 = this.v;
      this.shiftU--;
      this.bus.irqHandle(this.f, this.shiftU);
    }
    if (this.status !== STATUS.NORMAL) {
      if (this.status === STATUS.IRQ) {
        this.status = STATUS.NORMAL;
        this.callInt(this.irqVector);
        return 20;
      }
      return 8; // HALT / STOP: idle until an interrupt
    }

    const op = this.fetch8();
    let t, d, a;

    if (op < 0x40) { // ALU A, src
      const k = op >> 3;
      let cyc = 8;
      switch (op & 7) {
        case 0: t = this.a; break;
        case 1: t = this.b; break;
        case 2: t = this.fetch8(); break;
        case 3: t = this.rd(this.aHL()); break;
        case 4: t = this.rd(this.aNN(this.fetch8())); cyc = 12; break;
        case 5: t = this.rd(this.aABS(this.fetch16())); cyc = 16; break;
        case 6: t = this.rd(this.aX()); break;
        default: t = this.rd(this.aY()); break;
      }
      const r = this.alu(k, this.a, t);
      if (k !== 6) this.a = r;
      return cyc;
    }
    if (op < 0x60) { // MOV r, src
      let cyc = 8;
      switch (op & 7) {
        case 0: t = this.a; cyc = 4; break;
        case 1: t = this.b; cyc = 4; break;
        case 2: t = this.l; cyc = 4; break;
        case 3: t = this.h; cyc = 4; break;
        case 4: t = this.rd(this.aNN(this.fetch8())); cyc = 12; break;
        case 5: t = this.rd(this.aHL()); break;
        case 6: t = this.rd(this.aX()); break;
        default: t = this.rd(this.aY()); break;
      }
      switch ((op >> 3) & 3) {
        case 0: this.a = t; break;
        case 1: this.b = t; break;
        case 2: this.l = t; break;
        default: this.h = t; break;
      }
      return cyc;
    }
    if (op < 0x80) { // MOV [X]/[HL]/[Y]/[N+#nn], src
      if (op === 0x7C) { this.fetch8(); return 64; }
      const grp = (op >> 3) & 3;
      let dst;
      if (grp === 3) dst = this.aNN(this.fetch8());
      let cyc;
      switch (op & 7) {
        case 0: t = this.a; cyc = 8; break;
        case 1: t = this.b; cyc = 8; break;
        case 2: t = this.l; cyc = 8; break;
        case 3: t = this.h; cyc = 8; break;
        case 4: t = this.rd(this.aNN(this.fetch8())); cyc = 16; break;
        case 5: t = this.rd(this.aHL()); cyc = grp === 3 ? 16 : 12; break;
        case 6: t = this.rd(this.aX()); cyc = grp === 3 ? 16 : 12; break;
        default: t = this.rd(this.aY()); cyc = grp === 3 ? 16 : 12; break;
      }
      if (grp === 0) dst = this.aX();
      else if (grp === 1) dst = this.aHL();
      else if (grp === 2) dst = this.aY();
      this.wr(dst, t);
      return cyc;
    }

    switch (op) {
      case 0x80: this.a = this.inc8(this.a); return 8;
      case 0x81: this.b = this.inc8(this.b); return 8;
      case 0x82: this.l = this.inc8(this.l); return 8;
      case 0x83: this.h = this.inc8(this.h); return 8;
      case 0x84: this.n = this.inc8(this.n); return 8;
      case 0x85: a = this.aNN(this.fetch8()); this.wr(a, this.inc8(this.rd(a))); return 16;
      case 0x86: a = this.aHL(); this.wr(a, this.inc8(this.rd(a))); return 12;
      case 0x87: this.sp = this.inc16(this.sp); return 8;
      case 0x88: this.a = this.dec8(this.a); return 8;
      case 0x89: this.b = this.dec8(this.b); return 8;
      case 0x8A: this.l = this.dec8(this.l); return 8;
      case 0x8B: this.h = this.dec8(this.h); return 8;
      case 0x8C: this.n = this.dec8(this.n); return 8;
      case 0x8D: a = this.aNN(this.fetch8()); this.wr(a, this.dec8(this.rd(a))); return 16;
      case 0x8E: a = this.aHL(); this.wr(a, this.dec8(this.rd(a))); return 12;
      case 0x8F: this.sp = this.dec16(this.sp); return 8;

      case 0x90: this.ba = this.inc16(this.ba); return 8;
      case 0x91: this.hl = this.inc16(this.hl); return 8;
      case 0x92: this.x = this.inc16(this.x); return 8;
      case 0x93: this.y = this.inc16(this.y); return 8;
      case 0x94: this.and8(this.a, this.b); return 8;
      case 0x95: t = this.fetch8(); this.and8(this.rd(this.aHL()), t); return 12;
      case 0x96: this.and8(this.a, this.fetch8()); return 8;
      case 0x97: this.and8(this.b, this.fetch8()); return 8;
      case 0x98: this.ba = this.dec16(this.ba); return 8;
      case 0x99: this.hl = this.dec16(this.hl); return 8;
      case 0x9A: this.x = this.dec16(this.x); return 8;
      case 0x9B: this.y = this.dec16(this.y); return 8;
      case 0x9C: this.setF(this.f & this.fetch8()); return 12;
      case 0x9D: this.setF(this.f | this.fetch8()); return 12;
      case 0x9E: this.setF(this.f ^ this.fetch8()); return 12;
      case 0x9F: this.setF(this.fetch8()); return 12;

      case 0xA0: this.push(this.b); this.push(this.a); return 16;
      case 0xA1: this.push(this.h); this.push(this.l); return 16;
      case 0xA2: this.push(this.x >> 8); this.push(this.x); return 16;
      case 0xA3: this.push(this.y >> 8); this.push(this.y); return 16;
      case 0xA4: this.push(this.n); return 12;
      case 0xA5: this.push(this.i); return 12;
      case 0xA6: this.push(this.xi); this.push(this.yi); return 16;
      case 0xA7: this.push(this.f); return 12;
      case 0xA8: t = this.pop(); this.ba = t | (this.pop() << 8); return 12;
      case 0xA9: t = this.pop(); this.hl = t | (this.pop() << 8); return 12;
      case 0xAA: t = this.pop(); this.x = t | (this.pop() << 8); return 12;
      case 0xAB: t = this.pop(); this.y = t | (this.pop() << 8); return 12;
      case 0xAC: this.n = this.pop(); return 8;
      case 0xAD: this.i = this.pop(); return 8;
      case 0xAE: this.yi = this.pop(); this.xi = this.pop(); return 12;
      case 0xAF: this.setF(this.pop()); return 8;

      case 0xB0: this.a = this.fetch8(); return 8;
      case 0xB1: this.b = this.fetch8(); return 8;
      case 0xB2: this.l = this.fetch8(); return 8;
      case 0xB3: this.h = this.fetch8(); return 8;
      case 0xB4: this.n = this.fetch8(); return 8;
      case 0xB5: this.wr(this.aHL(), this.fetch8()); return 12;
      case 0xB6: this.wr(this.aX(), this.fetch8()); return 12;
      case 0xB7: this.wr(this.aY(), this.fetch8()); return 12;
      case 0xB8: case 0xB9: case 0xBA: case 0xBB: {
        t = this.fetch16();
        const lo = this.rd(this.aABS(t)), hi = this.rd(this.aABS((t + 1) & 0xFFFF));
        this.set16(op & 3, lo | (hi << 8));
        return 20;
      }
      case 0xBC: case 0xBD: case 0xBE: case 0xBF: {
        t = this.fetch16();
        const v = this.get16(op & 3);
        this.wr(this.aABS(t), v); this.wr(this.aABS((t + 1) & 0xFFFF), v >> 8);
        return 20;
      }

      case 0xC0: this.ba = this.add16(this.ba, this.fetch16()); return 12;
      case 0xC1: this.hl = this.add16(this.hl, this.fetch16()); return 12;
      case 0xC2: this.x = this.add16(this.x, this.fetch16()); return 12;
      case 0xC3: this.y = this.add16(this.y, this.fetch16()); return 12;
      case 0xC4: this.ba = this.fetch16(); return 12;
      case 0xC5: this.hl = this.fetch16(); return 12;
      case 0xC6: this.x = this.fetch16(); return 12;
      case 0xC7: this.y = this.fetch16(); return 12;
      case 0xC8: t = this.hl; this.hl = this.ba; this.ba = t; return 12;
      case 0xC9: t = this.x; this.x = this.ba; this.ba = t; return 12;
      case 0xCA: t = this.y; this.y = this.ba; this.ba = t; return 12;
      case 0xCB: t = this.sp; this.sp = this.ba; this.ba = t; return 12;
      case 0xCC: this.ba = ((this.ba & 0xFF) << 8) | (this.ba >> 8); return 8;
      case 0xCD: a = this.aHL(); t = this.rd(a); this.wr(a, this.a); this.a = t; return 12;
      case 0xCE: return this.execCE();
      case 0xCF: return this.execCF();

      case 0xD0: this.ba = this.sub16(this.ba, this.fetch16()); return 12;
      case 0xD1: this.hl = this.sub16(this.hl, this.fetch16()); return 12;
      case 0xD2: this.x = this.sub16(this.x, this.fetch16()); return 12;
      case 0xD3: this.y = this.sub16(this.y, this.fetch16()); return 12;
      case 0xD4: this.sub16(this.ba, this.fetch16()); return 12;
      case 0xD5: this.sub16(this.hl, this.fetch16()); return 12;
      case 0xD6: this.sub16(this.x, this.fetch16()); return 12;
      case 0xD7: this.sub16(this.y, this.fetch16()); return 12;
      case 0xD8: a = this.aNN(this.fetch8()); t = this.fetch8(); this.wr(a, this.and8(this.rd(a), t)); return 20;
      case 0xD9: a = this.aNN(this.fetch8()); t = this.fetch8(); this.wr(a, this.or8(this.rd(a), t)); return 20;
      case 0xDA: a = this.aNN(this.fetch8()); t = this.fetch8(); this.wr(a, this.xor8(this.rd(a), t)); return 20;
      case 0xDB: a = this.aNN(this.fetch8()); t = this.fetch8(); this.sub8(this.rd(a), t); return 16;
      case 0xDC: a = this.aNN(this.fetch8()); t = this.fetch8(); this.and8(this.rd(a), t); return 16;
      case 0xDD: a = this.aNN(this.fetch8()); t = this.fetch8(); this.wr(a, t); return 16;
      case 0xDE: this.a = (this.a & 0x0F) | (this.b << 4); return 8; // PACK
      case 0xDF: t = this.a; this.ba = ((t >> 4) << 8) | (t & 0x0F); return 8; // UNPACK

      // conditional relative calls / jumps (C, NC, Z, NZ)
      case 0xE0: d = this.fetch8(); if (this.f & 0x02) { this.callRel(sx8(d)); return 20; } return 8;
      case 0xE1: d = this.fetch8(); if (!(this.f & 0x02)) { this.callRel(sx8(d)); return 20; } return 8;
      case 0xE2: d = this.fetch8(); if (this.f & 0x01) { this.callRel(sx8(d)); return 20; } return 8;
      case 0xE3: d = this.fetch8(); if (!(this.f & 0x01)) { this.callRel(sx8(d)); return 20; } return 8;
      case 0xE4: d = this.fetch8(); if (this.f & 0x02) this.jmpRel(sx8(d)); return 8;
      case 0xE5: d = this.fetch8(); if (!(this.f & 0x02)) this.jmpRel(sx8(d)); return 8;
      case 0xE6: d = this.fetch8(); if (this.f & 0x01) this.jmpRel(sx8(d)); return 8;
      case 0xE7: d = this.fetch8(); if (!(this.f & 0x01)) this.jmpRel(sx8(d)); return 8;
      case 0xE8: d = this.fetch16(); if (this.f & 0x02) { this.callRel(d); return 24; } return 12;
      case 0xE9: d = this.fetch16(); if (!(this.f & 0x02)) { this.callRel(d); return 24; } return 12;
      case 0xEA: d = this.fetch16(); if (this.f & 0x01) { this.callRel(d); return 24; } return 12;
      case 0xEB: d = this.fetch16(); if (!(this.f & 0x01)) { this.callRel(d); return 24; } return 12;
      case 0xEC: d = this.fetch16(); if (this.f & 0x02) this.jmpRel(d); return 12;
      case 0xED: d = this.fetch16(); if (!(this.f & 0x02)) this.jmpRel(d); return 12;
      case 0xEE: d = this.fetch16(); if (this.f & 0x01) this.jmpRel(d); return 12;
      case 0xEF: d = this.fetch16(); if (!(this.f & 0x01)) this.jmpRel(d); return 12;

      case 0xF0: this.callRel(sx8(this.fetch8())); return 20;
      case 0xF1: this.jmpRel(sx8(this.fetch8())); return 8;
      case 0xF2: this.callRel(this.fetch16()); return 24;
      case 0xF3: this.jmpRel(this.fetch16()); return 12;
      case 0xF4: this.jmpAbs(this.hl); return 8;
      case 0xF5: // JDBNZ
        d = this.fetch8();
        this.b = this.dec8(this.b);
        if (this.b !== 0) this.jmpRel(sx8(d));
        return 16;
      case 0xF6: t = this.a; this.a = ((t << 4) | (t >> 4)) & 0xFF; return 8;
      case 0xF7: a = this.aHL(); t = this.rd(a); this.wr(a, (t << 4) | (t >> 4)); return 12;
      case 0xF8: this.ret(); return 16;
      case 0xF9: this.reti(); return 16;
      case 0xFA: this.ret(); this.pc = (this.pc + 2) & 0xFFFF; return 16;
      case 0xFB: { // CALL [#nnnn]
        t = this.fetch16();
        this.push(this.v); this.push(this.pc >> 8); this.push(this.pc);
        this.v = this.u1; this.u2 = this.u1;
        this.pc = this.read16(this.aABS(t));
        return 20;
      }
      case 0xFC: this.callInt(this.fetch8()); return 20; // CINT #nn
      case 0xFD: this.jmpInt(this.fetch8()); return 8;   // JINT #nn
      case 0xFF: return 8; // NOP
      default: return 4;   // 0xFE: undefined
    }
  }

  get16(k) { return k === 0 ? this.ba : k === 1 ? this.hl : k === 2 ? this.x : this.y; }
  set16(k, v) {
    v &= 0xFFFF;
    if (k === 0) this.ba = v; else if (k === 1) this.hl = v; else if (k === 2) this.x = v; else this.y = v;
  }
  getR8(k) { return k === 0 ? this.a : k === 1 ? this.b : k === 2 ? this.l : this.h; }
  setR8(k, v) { if (k === 0) this.a = v; else if (k === 1) this.b = v; else if (k === 2) this.l = v; else this.h = v; }
  // CE-page indexed modes: 0 [X+#ss] 1 [Y+#ss] 2 [X+L] 3 [Y+L]
  idx(k) {
    switch (k & 3) {
      case 0: return this.aXd(this.fetch8());
      case 1: return this.aYd(this.fetch8());
      case 2: return this.aXd(this.l);
      default: return this.aYd(this.l);
    }
  }

  // ------------------------------------------------------------ 0xCE page
  execCE() {
    const op = this.fetch8();
    let a, t, d;
    if (op < 0x40) { // ALU A,[idx] / ALU [HL],src
      const k = op >> 3, m = op & 7;
      if (m < 4) {
        const r = this.alu(k, this.a, this.rd(this.idx(m)));
        if (k !== 6) this.a = r;
        return 16;
      }
      let cyc = 20;
      a = this.aHL();
      if (m === 4) { t = this.a; cyc = 16; }
      else if (m === 5) t = this.fetch8();
      else if (m === 6) t = this.rd(this.aX());
      else t = this.rd(this.aY());
      const r = this.alu(k, this.rd(a), t);
      if (k !== 6) this.wr(a, r);
      return cyc;
    }
    if (op < 0x60) { // MOV r,[idx] / MOV [idx],r
      const r = (op >> 3) & 3, m = op & 7;
      if (m < 4) this.setR8(r, this.rd(this.idx(m)));
      else this.wr(this.idx(m), this.getR8(r));
      return 16;
    }
    if (op >= 0x80 && op < 0xA8) { // shifts / rotates / NOT / NEG
      const k = (op - 0x80) >> 2;
      switch (op & 3) {
        case 0: this.a = this.shiftOp(k, this.a); return 12;
        case 1: this.b = this.shiftOp(k, this.b); return 12;
        case 2: a = this.aNN(this.fetch8()); this.wr(a, this.shiftOp(k, this.rd(a))); return 20;
        default: a = this.aHL(); this.wr(a, this.shiftOp(k, this.rd(a))); return 16;
      }
    }
    switch (op) {
      case 0x60: case 0x61: case 0x62: case 0x63: this.wr(this.aHL(), this.rd(this.idx(op))); return 20;
      case 0x64: this.ba = this.adc16(this.ba, this.fetch16()); return 16;
      case 0x65: this.hl = this.adc16(this.hl, this.fetch16()); return 16;
      case 0x66: this.ba = this.adc16(this.ba, (this.fetch8() << 8) | this.l); return 24;
      case 0x67: this.hl = this.adc16(this.hl, (this.fetch8() << 8) | this.l); return 24;
      case 0x68: case 0x69: case 0x6A: case 0x6B: this.wr(this.aX(), this.rd(this.idx(op))); return 20;
      case 0x6C: this.sp = this.add16(this.sp, this.fetch8()); return 16;
      case 0x6D: d = this.fetch8(); this.hl = this.add16(this.x, ((d << 4) * 3) + ((d & 0x08) >> 3)); this.f &= ~0x02; return 40;
      case 0x6E: this.sp = this.add16(this.sp, (this.fetch8() << 8) | this.l); return 16;
      case 0x6F: d = this.l; this.hl = this.add16(this.x, ((d << 4) * 3) + ((d & 0x08) >> 3)); this.f &= ~0x02; return 40;
      case 0x70: case 0x71: this.pc = (this.pc + 1) & 0xFFFF; return 64;
      case 0x72: case 0x73: return 64;
      case 0x74: this.a = this.rd(this.aXd(this.fetch8())); return 64;
      case 0x75: this.l = this.rd(this.aYd(this.fetch8())); return 64;
      case 0x76: this.a = this.rd(this.aXd(this.l)); return 64;
      case 0x77: this.l = this.rd(this.aYd(this.l)); return 64;
      case 0x78: case 0x79: case 0x7A: case 0x7B: this.wr(this.aY(), this.rd(this.idx(op))); return 20;
      case 0x7C: this.pc = (this.pc + 1) & 0xFFFF; return 20;
      case 0x7D: this.pc = (this.pc + 1) & 0xFFFF; return 16;
      case 0x7E: return 20;
      case 0x7F: return 16;

      case 0xA8: this.ba = sx8(this.a); return 12; // EX BA,A (sign extend)
      case 0xA9: return 8;
      case 0xAA: return 12;
      case 0xAB: case 0xAC: case 0xAD: return 64;
      case 0xAE: this.status = STATUS.HALT; return 8;
      case 0xAF: this.status = STATUS.STOP; return 8;
      case 0xB0: this.b = this.and8(this.b, this.fetch8()); return 12;
      case 0xB1: this.l = this.and8(this.l, this.fetch8()); return 12;
      case 0xB2: this.h = this.and8(this.h, this.fetch8()); return 12;
      case 0xB3: this.h = this.v; return 12;
      case 0xB4: this.b = this.or8(this.b, this.fetch8()); return 12;
      case 0xB5: this.l = this.or8(this.l, this.fetch8()); return 12;
      case 0xB6: this.h = this.or8(this.h, this.fetch8()); return 12;
      case 0xB7: this.x = (this.x & 0xFF) | (this.v << 8); return 12;
      case 0xB8: this.b = this.xor8(this.b, this.fetch8()); return 12;
      case 0xB9: this.l = this.xor8(this.l, this.fetch8()); return 12;
      case 0xBA: this.h = this.xor8(this.h, this.fetch8()); return 12;
      case 0xBB: this.y = (this.y & 0xFF) | (this.v << 8); return 12;
      case 0xBC: this.sub8(this.b, this.fetch8()); return 12;
      case 0xBD: this.sub8(this.l, this.fetch8()); return 12;
      case 0xBE: this.sub8(this.h, this.fetch8()); return 12;
      case 0xBF: this.sub8(this.n, this.fetch8()); return 12;
      case 0xC0: this.a = this.n; return 8;
      case 0xC1: this.a = this.f; return 8;
      case 0xC2: this.n = this.a; return 8;
      case 0xC3: this.setF(this.a); return 8;
      case 0xC4: this.setU(this.fetch8()); return 16;
      case 0xC5: this.i = this.fetch8(); return 12;
      case 0xC6: this.xi = this.fetch8(); return 12;
      case 0xC7: this.yi = this.fetch8(); return 12;
      case 0xC8: this.a = this.v; return 8;
      case 0xC9: this.a = this.i; return 8;
      case 0xCA: this.a = this.xi; return 8;
      case 0xCB: this.a = this.yi; return 8;
      case 0xCC: this.setU(this.a); return 8;
      case 0xCD: this.i = this.a; return 8;
      case 0xCE: this.xi = this.a; return 8;
      case 0xCF: this.yi = this.a; return 8;
      case 0xD0: this.a = this.rd(this.fetch16()); return 20;
      case 0xD1: this.b = this.rd(this.fetch16()); return 20;
      case 0xD2: this.l = this.rd(this.fetch16()); return 20;
      case 0xD3: this.h = this.rd(this.fetch16()); return 20;
      case 0xD4: this.wr(this.fetch16(), this.a); return 20;
      case 0xD5: this.wr(this.fetch16(), this.b); return 20;
      case 0xD6: this.wr(this.fetch16(), this.l); return 20;
      case 0xD7: this.wr(this.fetch16(), this.h); return 20;
      case 0xD8: { // MUL L,A
        const r = (this.l * this.a) & 0xFFFF;
        this.hl = r;
        let f = this.f & 0xF0;
        if (r === 0) f |= 0x01;
        if (r & 0x8000) f |= 0x08;
        this.f = f;
        return 48;
      }
      case 0xD9: { // DIV HL,A
        let f = this.f & 0xF0;
        const dv = this.a;
        if (dv !== 0) {
          const q = Math.floor(this.hl / dv);
          if (q < 256) {
            this.hl = ((this.hl % dv) << 8) | q;
            if (q === 0) f |= 0x01;
            if (q & 0x80) f |= 0x08;
          } else f |= 0x0C;
        }
        this.f = f;
        return 52;
      }
      case 0xDA: case 0xDB: case 0xDE: case 0xDF: this.fetch8(); return 64;
      case 0xDC: return 64;
      case 0xDD: return 16;
    }
    if (op >= 0xE0) { // signed / overflow / sign / E-bit conditions
      d = sx8(this.fetch8());
      const f = this.f, Z = f & 1, V = (f >> 2) & 1, S = (f >> 3) & 1, E = this.e;
      let cond;
      switch (op & 0x0F) {
        case 0x0: cond = V !== S; break;              // L  (less)
        case 0x1: cond = V !== S || Z; break;         // LE
        case 0x2: cond = V === S && !Z; break;        // G
        case 0x3: cond = V === S; break;              // GE
        case 0x4: cond = !!V; break;                  // O
        case 0x5: cond = !V; break;                   // NO
        case 0x6: cond = !S; break;                   // NS (P)
        case 0x7: cond = !!S; break;                  // S  (M)
        case 0x8: cond = !(E & 1); break;
        case 0x9: cond = !(E & 2); break;
        case 0xA: cond = !(E & 4); break;
        case 0xB: cond = !(E & 8); break;
        case 0xC: cond = !!(E & 1); break;
        case 0xD: cond = !!(E & 2); break;
        case 0xE: cond = !!(E & 4); break;
        default: cond = !!(E & 8); break;
      }
      if (cond) { if (op < 0xF0) this.jmpRel(d); else this.callRel(d); }
      return 12;
    }
    return 4;
  }

  // ------------------------------------------------------------ 0xCF page
  execCF() {
    const op = this.fetch8();
    let t, d;
    if (op < 0x40) { // 16-bit ALU on BA (00-1F) or HL (20-3F)
      const src = this.get16(op & 3);
      const k = (op >> 2) & 7;
      const isHL = op >= 0x20;
      const dst = isHL ? this.hl : this.ba;
      if (k === 6) { this.sub16(dst, src); return 16; }
      const r = this.alu16(k & 3, dst, src);
      if (isHL) this.hl = r; else this.ba = r;
      return 16;
    }
    if (op < 0x60) { // ADD/SUB/CMP X,Y,SP with BA/HL
      const src = op & 1 ? this.hl : this.ba;
      const sel = (op >> 1) & 3; // 0 X, 1 Y, 2 SP, 3 invalid
      const kind = (op >> 3) & 3; // 0 ADD, 1 SUB, 2 ADD(dup), 3 SUB(dup)/CMP SP
      if (sel === 3) return 16;
      if (op === 0x5C || op === 0x5D) { this.sub16(this.sp, src); return 16; }
      const cur = sel === 0 ? this.x : sel === 1 ? this.y : this.sp;
      const r = kind & 1 ? this.sub16(cur, src) : this.add16(cur, src);
      if (sel === 0) this.x = r; else if (sel === 1) this.y = r; else this.sp = r;
      return 16;
    }
    switch (op) {
      case 0x60: this.ba = this.adc16(this.ba, this.fetch16()); return 16;
      case 0x61: this.hl = this.adc16(this.hl, this.fetch16()); return 16;
      case 0x62: this.ba = this.sbc16(this.ba, this.fetch16()); return 16;
      case 0x63: this.hl = this.sbc16(this.hl, this.fetch16()); return 16;
      case 0x68: this.sp = this.add16(this.sp, this.fetch16()); return 16;
      case 0x6A: this.sp = this.sub16(this.sp, this.fetch16()); return 16;
      case 0x6C: this.sub16(this.sp, this.fetch16()); return 16;
      case 0x6E: this.sp = this.fetch16(); return 16;
      case 0x64: case 0x65: case 0x66: case 0x67: case 0x69: case 0x6B: case 0x6D: case 0x6F: return 16;
      case 0x70: case 0x71: case 0x72: case 0x73: {
        d = this.fetch8();
        const p = (this.sp + sx8(d)) & 0xFFFF;
        this.set16(op & 3, this.rd(p) | (this.rd((p + 1) & 0xFFFF) << 8));
        return 24;
      }
      case 0x74: case 0x75: case 0x76: case 0x77: {
        d = this.fetch8();
        const p = (this.sp + sx8(d)) & 0xFFFF, v = this.get16(op & 3);
        this.wr(p, v); this.wr((p + 1) & 0xFFFF, v >> 8);
        return 24;
      }
      case 0x78: t = this.fetch16(); this.sp = this.rd(this.aABS(t)) | (this.rd(this.aABS((t + 1) & 0xFFFF)) << 8); return 24;
      case 0x7C: t = this.fetch16(); this.wr(this.aABS(t), this.sp); this.wr(this.aABS((t + 1) & 0xFFFF), this.sp >> 8); return 24;
      case 0xB0: this.push(this.a); return 12;
      case 0xB1: this.push(this.b); return 12;
      case 0xB2: this.push(this.l); return 12;
      case 0xB3: this.push(this.h); return 12;
      case 0xB4: this.a = this.pop(); return 12;
      case 0xB5: this.b = this.pop(); return 12;
      case 0xB6: this.l = this.pop(); return 12;
      case 0xB7: this.h = this.pop(); return 12;
      case 0xB8: case 0xB9: // PUSHA / PUSHAX
        this.push(this.b); this.push(this.a); this.push(this.h); this.push(this.l);
        this.push(this.x >> 8); this.push(this.x); this.push(this.y >> 8); this.push(this.y);
        this.push(this.n);
        if (op === 0xB8) return 48;
        this.push(this.i); this.push(this.xi); this.push(this.yi);
        return 60;
      case 0xBC: case 0xBD: // POPA / POPAX
        if (op === 0xBD) { this.yi = this.pop(); this.xi = this.pop(); this.i = this.pop(); }
        this.n = this.pop();
        t = this.pop(); this.y = t | (this.pop() << 8);
        t = this.pop(); this.x = t | (this.pop() << 8);
        t = this.pop(); this.hl = t | (this.pop() << 8);
        t = this.pop(); this.ba = t | (this.pop() << 8);
        return op === 0xBC ? 44 : 56;
    }
    if (op >= 0xC0 && op < 0xE0) {
      const r = op & 3;
      if (op < 0xC8) { // [HL]
        const a = this.hl;
        if (op < 0xC4) this.set16(r, this.rd((this.i << 16) | a) | (this.rd((this.i << 16) | ((a + 1) & 0xFFFF)) << 8));
        else { const v = this.get16(r); this.wr((this.i << 16) | a, v); this.wr((this.i << 16) | ((a + 1) & 0xFFFF), v >> 8); }
        return 20;
      }
      if (op < 0xD0) { this.b = this.v; return 12; }
      const bank = op < 0xD8 ? this.xi : this.yi;
      const a = op < 0xD8 ? this.x : this.y;
      if ((op & 7) < 4) this.set16(r, this.rd((bank << 16) | a) | (this.rd((bank << 16) | ((a + 1) & 0xFFFF)) << 8));
      else { const v = this.get16(r); this.wr((bank << 16) | a, v); this.wr((bank << 16) | ((a + 1) & 0xFFFF), v >> 8); }
      return 20;
    }
    if (op >= 0xE0 && op < 0xF0) { this.set16((op >> 2) & 3, this.get16(op & 3)); return 8; }
    switch (op) {
      case 0xF0: this.sp = this.ba; return 8;
      case 0xF1: this.sp = this.hl; return 8;
      case 0xF2: this.sp = this.x; return 8;
      case 0xF3: this.sp = this.y; return 8;
      case 0xF4: this.hl = this.sp; return 8;
      case 0xF5: this.hl = this.pc; return 8;
      case 0xF6: this.x = (this.x & 0xFF) | (this.v << 8); return 12;
      case 0xF7: this.y = (this.y & 0xFF) | (this.v << 8); return 12;
      case 0xF8: this.ba = this.sp; return 8;
      case 0xF9: this.ba = this.pc; return 8;
      case 0xFA: this.x = this.sp; return 8;
      case 0xFB: case 0xFC: return 12;
      case 0xFD: this.a = this.e; return 12;
      case 0xFE: this.y = this.sp; return 8;
      case 0xFF: return 64;
    }
    // 0x79-0x7B, 0x7D-0xAF, 0xBA, 0xBB, 0xBE, 0xBF: undocumented, consume a byte
    this.fetch8();
    return 16;
  }

  // ------------------------------------------------------------ state
  saveState() {
    return {
      ba: this.ba, hl: this.hl, i: this.i, n: this.n, x: this.x, xi: this.xi, y: this.y, yi: this.yi,
      sp: this.sp, pc: this.pc, v: this.v, u1: this.u1, u2: this.u2, shiftU: this.shiftU,
      f: this.f, e: this.e, ir: this.ir, status: this.status, irqVector: this.irqVector,
    };
  }
  loadState(s) { Object.assign(this, s); }
}
