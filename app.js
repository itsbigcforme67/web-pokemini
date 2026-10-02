// Web Pokémon mini - Copyright (C) 2026 the Web Pokémon mini authors.
// Free software under the GNU General Public License, version 3 or later; see LICENSE. No warranty.
// Web Pokémon mini - phone UI: library (synced from the PC companion), player, local storage.
import { PokeMini, STATE_VERSION, BTN, romInfo, LCD_W, LCD_H } from './core/pokemini.js';
import { isZip, unzip } from './zip.js';

const $ = (s) => document.querySelector(s);
const EEP_SIZE = 0x2000;
const CLOCK_AT = 0x1FF6; // last 10 EEPROM bytes hold the clock timestamp, not game data

// ------------------------------------------------------------------ storage (IndexedDB)
const db = (() => {
  let p;
  const open = () => p || (p = new Promise((res, rej) => {
    const r = indexedDB.open('web-pokemini', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));
  const tx = async (mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction('kv', mode);
      const req = fn(t.objectStore('kv'));
      t.oncomplete = () => res(req && req.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    get: (k) => tx('readonly', (s) => s.get(k)),
    set: (k, v) => tx('readwrite', (s) => s.put(v, k)),
    del: (k) => tx('readwrite', (s) => s.delete(k)),
    keys: () => tx('readonly', (s) => s.getAllKeys()),
  };
})();

const prefs = {
  get(k, d) { try { const v = localStorage.getItem('wpm.' + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('wpm.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ------------------------------------------------------------------ server API (MiniSync on the PC)
const api = {
  online: false,
  standalone: false, // served as a plain website (no MiniSync behind it): everything lives on this device
  token() {
    const q = new URLSearchParams(location.search).get('token');
    if (q) prefs.set('token', q);
    return prefs.get('token', '');
  },
  headers(extra = {}) { const t = this.token(); return t ? { ...extra, 'X-Token': t } : extra; },
  async json(path, opts = {}) {
    const r = await fetch(path, { ...opts, headers: this.headers(opts.headers) });
    if (!r.ok) { const e = new Error(`${r.status}`); e.status = r.status; e.body = await r.text().catch(() => ''); throw e; }
    return r.json();
  },
  async bytes(path) {
    const r = await fetch(path, { headers: this.headers() });
    if (!r.ok) { const e = new Error(`${r.status}`); e.status = r.status; throw e; }
    return new Uint8Array(await r.arrayBuffer());
  },
};

async function sha1(bytes) {
  const h = await crypto.subtle.digest('SHA-1', bytes);
  return Array.from(new Uint8Array(h), (b) => b.toString(16).padStart(2, '0')).join('');
}
// two saves hold the same game data (the clock timestamp is ignored)
function sameSave(a, b) {
  if (!a || !b) return false;
  for (let i = 0; i < CLOCK_AT; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ------------------------------------------------------------------ UI helpers
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast.timer); toast.timer = setTimeout(() => t.classList.add('hidden'), ms);
}
function sheet(title, bodyHTML, actions, onOpen) {
  return new Promise((resolve) => {
    $('#sheet-title').textContent = title;
    $('#sheet-body').innerHTML = bodyHTML || '';
    const box = $('#sheet-actions');
    box.innerHTML = '';
    const s = $('#sheet');
    const close = (v) => { s.classList.add('hidden'); s.onclick = null; resolve(v); };
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = 'btn ' + (a.cls || '');
      b.textContent = a.label;
      b.onclick = () => close(a.value);
      box.appendChild(b);
    }
    s.onclick = (e) => { if (e.target === s) close(null); };
    s.classList.remove('hidden');
    if (onOpen) onOpen($('#sheet-body'), close);
  });
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function showView(id) {
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === id));
  document.documentElement.classList.toggle('in-player', id === 'player');
}
function download(name, bytes) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function ago(t) {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
}

// ------------------------------------------------------------------ LCD rendering
const PALETTES = {
  classic: { name: 'Classic', bg: [180, 190, 162], ink: [28, 36, 23] },
  grey: { name: 'Grey', bg: [196, 199, 192], ink: [30, 32, 36] },
  sharp: { name: 'High contrast', bg: [226, 232, 214], ink: [12, 16, 10] },
  night: { name: 'Night', bg: [24, 30, 26], ink: [170, 230, 160] },
};
let lut = new Uint32Array(256);
function buildLut() {
  const p = PALETTES[prefs.get('palette', 'classic')] || PALETTES.classic;
  for (let v = 0; v < 256; v++) {
    const t = v / 255;
    const c = p.bg.map((b, i) => Math.round(b + (p.ink[i] - b) * t));
    lut[v] = (255 << 24) | (c[2] << 16) | (c[1] << 8) | c[0];
  }
  document.documentElement.style.setProperty('--lcd-bg', `rgb(${p.bg.join(',')})`);
  gridCanvas = null;
}
let gridCanvas = null;
function grid(W, H) { // faint gaps between LCD pixels
  if (gridCanvas && gridCanvas.width === W) return gridCanvas;
  const p = PALETTES[prefs.get('palette', 'classic')] || PALETTES.classic;
  gridCanvas = document.createElement('canvas');
  gridCanvas.width = W; gridCanvas.height = H;
  const g = gridCanvas.getContext('2d');
  g.fillStyle = `rgba(${p.bg.join(',')},0.16)`;
  const cx = W / LCD_W, cy = H / LCD_H;
  for (let x = 1; x < LCD_W; x++) g.fillRect(Math.round(x * cx) - 1, 0, 1, H);
  for (let y = 1; y < LCD_H; y++) g.fillRect(0, Math.round(y * cy) - 1, W, 1);
  return gridCanvas;
}
const small = document.createElement('canvas');
small.width = LCD_W; small.height = LCD_H;
const sctx = small.getContext('2d');
const simg = sctx.createImageData(LCD_W, LCD_H);
const spx = new Uint32Array(simg.data.buffer);
function paint(target, frame, withGrid = true) {
  for (let i = 0; i < frame.length; i++) spx[i] = lut[frame[i]];
  sctx.putImageData(simg, 0, 0);
  const ctx = target.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, target.width, target.height);
  if (withGrid) ctx.drawImage(grid(target.width, target.height), 0, 0);
}
// Library / save-slot pictures get their own 96x64 canvas and pixel buffer (nothing shared with the
// live game screen), and are scaled up by CSS.
function thumbCanvas(frame) {
  const c = document.createElement('canvas');
  c.width = LCD_W; c.height = LCD_H;
  if (frame && frame.length === LCD_W * LCD_H) {
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(LCD_W, LCD_H);
    const px = new Uint32Array(img.data.buffer);
    for (let i = 0; i < px.length; i++) px[i] = lut[frame[i]];
    ctx.putImageData(img, 0, 0);
  }
  return c;
}

// ------------------------------------------------------------------ library state
// game:<id>   { id, title, code, file, source: 'pc'|'local', romSha1, size, added, lastPlayed }
// rom:<sha1>  Uint8Array
// save:<id>   { data, base, baseSha1, dirty, conflict, version }
// state:<id>:<slot>  { state, thumb, saved, saveVersion }   slot = auto | 1 | 2 | 3
// thumb:<id>  Uint8Array (96x64 darkness)

async function allGames() {
  const out = [];
  for (const k of await db.keys()) if (String(k).startsWith('game:')) out.push(await db.get(k));
  return out.filter(Boolean);
}
const getSave = (id) => db.get('save:' + id);
const putSave = (id, s) => db.set('save:' + id, s);

async function refreshFromPC() {
  let list;
  try {
    list = await api.json('/api/games');
    api.online = true; api.standalone = false;
    prefs.set('standalone', false);
    document.documentElement.classList.remove('standalone');
  } catch (e) {
    api.online = false;
    // a plain web host answers 404 for the companion's API; remember that for when we're offline later
    if (e.status === 404) prefs.set('standalone', true);
    api.standalone = e.status === 404 || (!e.status && prefs.get('standalone', false));
    document.documentElement.classList.toggle('standalone', api.standalone);
    $('#sync-status').textContent = api.standalone ? 'Your games and saves stay on this device'
      : e.status === 401 ? 'PC needs an access token (⋯ → Connection)' : 'Offline: showing games saved on this phone';
    return;
  }
  const seen = new Set();
  let pulled = 0;
  for (const g of list.games) {
    seen.add(g.id);
    const prev = await db.get('game:' + g.id);
    await db.set('game:' + g.id, { ...(prev || {}), id: g.id, title: g.title, code: g.code, file: g.file, source: 'pc', romSha1: g.romSha1, size: g.size, added: (prev && prev.added) || Date.now(), saveFile: g.save && g.save.file });
    const pcSha = g.save ? g.save.sha1 : '';
    let s = await getSave(g.id);
    if (s && s.baseSha1 === pcSha) { if (s.conflict) { s.conflict = null; await putSave(g.id, s); } continue; }
    if (s && s.dirty) {
      if (pcSha && s.conflict !== pcSha) { s.conflict = pcSha; await putSave(g.id, s); }
      continue;
    }
    if (!pcSha) continue;
    const data = await api.bytes(`/api/games/${encodeURIComponent(g.id)}/save`).catch(() => null);
    if (!data || data.length !== EEP_SIZE) continue;
    if (s && sameSave(s.data, data)) { s.baseSha1 = pcSha; s.base = data; await putSave(g.id, s); continue; }
    s = { data, base: data.slice(), baseSha1: pcSha, dirty: false, conflict: null, version: ((s && s.version) || 0) + 1 };
    await putSave(g.id, s);
    pulled++;
  }
  // games removed from the PC: forget them unless this phone has unsent progress
  for (const g of await allGames()) {
    if (g.source !== 'pc' || seen.has(g.id)) continue;
    const s = await getSave(g.id);
    if (!(s && s.dirty)) await db.del('game:' + g.id);
  }
  const n = list.games.length;
  $('#sync-status').textContent = `Synced with ${list.host || 'your PC'}: ${n} game${n === 1 ? '' : 's'}` + (pulled ? `, ${pulled} save${pulled === 1 ? '' : 's'} updated` : '');
}

// Redraws can be requested from several places at once (leaving a game, a save arriving on the PC,
// a menu action). Each run builds its cards off-screen and only the newest one is shown.
let renderSeq = 0;
async function renderLibrary() {
  const seq = ++renderSeq;
  const games = await allGames();
  games.sort((a, b) => (b.lastPlayed || 0) - (a.lastPlayed || 0) || a.title.localeCompare(b.title));
  const cards = [];
  for (const g of games) {
    const [s, resume, frame] = await Promise.all([getSave(g.id), db.get(`state:${g.id}:auto`), db.get('thumb:' + g.id)]);
    if (seq !== renderSeq) return; // a newer redraw has started
    const b = document.createElement('div');
    b.className = 'game';
    b.dataset.id = g.id;
    b.setAttribute('role', 'button');
    b.tabIndex = 0;
    const th = document.createElement('div');
    th.className = 'thumb';
    if (frame) th.appendChild(thumbCanvas(frame)); else th.innerHTML = `<span class="blank">${esc(g.code || 'MINI')}</span>`;
    b.appendChild(th);
    const tags = [];
    tags.push(`<span class="tag">${g.source === 'pc' ? 'PC' : 'phone'}</span>`);
    if (resume) tags.push('<span class="tag">resume</span>');
    if (s && s.conflict) tags.push('<span class="tag bad">conflict</span>');
    else if (s && s.dirty && g.source === 'pc') tags.push('<span class="tag warn">unsent save</span>');
    b.insertAdjacentHTML('beforeend', `<div class="name">${esc(prettyTitle(g))}</div><div class="meta">${tags.join('')}</div><button class="more" aria-label="More">⋯</button>`);
    b.onclick = (e) => { if (e.target.closest('.more')) gameMenu(g.id); else play(g.id); };
    b.onkeydown = (e) => { if (e.key === 'Enter') play(g.id); };
    cards.push(b);
  }
  if (seq !== renderSeq) return;
  $('#game-grid').replaceChildren(...cards);
  $('#no-games').classList.toggle('hidden', games.length > 0);
}
function prettyTitle(g) {
  // prefer the file name ("Pokemon Pinball Mini (USA, Europe)") over the 12-char header title
  if (g.file) return g.file.replace(/\.(min|zip)$/i, '').replace(/\s*\((USA|Europe|Japan|World|USA, Europe|En,[^)]*|Rev [^)]*)\)/gi, '').trim() || g.title;
  return g.title || g.code || 'Unknown game';
}

async function gameMenu(id) {
  const g = await db.get('game:' + id);
  const s = await getSave(id);
  const acts = [{ label: 'Play', value: 'play', cls: 'primary' }];
  if (await db.get(`state:${id}:auto`)) acts.push({ label: 'Start fresh (keeps your save)', value: 'fresh' });
  if (s && s.conflict) acts.push({ label: 'Resolve save conflict…', value: 'conflict' });
  else if (s && s.dirty && g.source === 'pc') acts.push({ label: 'Send save to PC', value: 'sync' });
  if (s) acts.push({ label: 'Download save (.eep)', value: 'dl' });
  acts.push({ label: 'Import save file (.eep / .srm)…', value: 'import' });
  acts.push({ label: 'Delete save states', value: 'states' });
  acts.push({ label: g.source === 'pc' ? 'Reset save to PC copy' : 'Remove from this phone', value: 'remove', cls: 'danger' });
  acts.push({ label: 'Close', value: null });
  const info = [g.file && `File: <code>${esc(g.file)}</code>`, g.saveFile && `PC save: <code>${esc(g.saveFile)}</code>`].filter(Boolean).join('<br>');
  const v = await sheet(prettyTitle(g), info ? `<p>${info}</p>` : '', acts);
  if (v === 'play') play(id);
  if (v === 'fresh') { await db.del(`state:${id}:auto`); play(id); }
  if (v === 'conflict') resolveConflict(id);
  if (v === 'sync') { await syncSave(id); renderLibrary(); }
  if (v === 'dl') download(prettyTitle(g) + '.eep', s.data);
  if (v === 'import') pickFile((f) => importSaveFor(id, f));
  if (v === 'states') { for (const k of await db.keys()) if (String(k).startsWith(`state:${id}:`)) await db.del(k); toast('Save states deleted'); renderLibrary(); }
  if (v === 'remove') removeGame(g);
}

async function removeGame(g) {
  const isPC = g.source === 'pc';
  const ok = await sheet(isPC ? 'Reset save to PC copy?' : 'Remove game?',
    isPC ? '<p>Discards this phone\'s save and save states for this game and reloads the save from your PC.</p>' : '<p>Removes the game, its save and save states from this phone.</p>',
    [{ label: isPC ? 'Reset' : 'Remove', value: true, cls: 'danger' }, { label: 'Cancel', value: false }]);
  if (!ok) return;
  for (const k of await db.keys()) if (String(k).startsWith(`state:${g.id}:`)) await db.del(k);
  await db.del('save:' + g.id);
  if (!isPC) { await db.del('game:' + g.id); await db.del('thumb:' + g.id); }
  if (isPC) await refreshFromPC();
  renderLibrary();
}

async function syncSave(id, force = false, quiet = false) {
  const s = await getSave(id);
  const g = await db.get('game:' + id);
  if (!s || !g || g.source !== 'pc') return false;
  try {
    const r = await fetch(`/api/games/${encodeURIComponent(id)}/save${force ? '?force=1' : ''}`, {
      method: 'PUT', body: s.data,
      headers: api.headers({ 'Content-Type': 'application/octet-stream', 'X-Base-Sha1': s.baseSha1 || '' }),
    });
    if (r.status === 409) {
      s.conflict = (await r.json()).sha1; await putSave(id, s);
      if (!quiet) await resolveConflict(id);
      else toast('Save changed on the PC too: open the game\'s ⋯ menu to choose');
      return false;
    }
    if (!r.ok) throw new Error(await r.text());
    const j = await r.json();
    Object.assign(s, { baseSha1: j.sha1, base: s.data.slice(), dirty: false, conflict: null });
    await putSave(id, s);
    toast(j.emulatorRunning ? 'Save sent to your PC. An emulator is running there: close the game in it, or it may overwrite this save' : 'Save sent to your PC (the old one was backed up)', j.emulatorRunning ? 5000 : 2600);
    updateUnsynced();
    return true;
  } catch (e) {
    if (!quiet) toast('Could not reach your PC: ' + e.message);
    return false;
  }
}

async function resolveConflict(id) {
  const choice = await sheet('Save changed in two places',
    '<p>This game\'s save changed on your PC <em>and</em> on this phone since they last synced.</p><p>Keep the phone version (it replaces the PC save; the PC keeps a backup) or take the PC version (this phone\'s progress for this game is discarded, and its save states too).</p>',
    [{ label: 'Keep phone version → send to PC', value: 'phone', cls: 'primary' }, { label: 'Use PC version', value: 'pc', cls: 'danger' }, { label: 'Decide later', value: null }]);
  if (choice === 'phone') await syncSave(id, true);
  if (choice === 'pc') {
    const s = await getSave(id);
    s.dirty = false; s.conflict = null; s.baseSha1 = '#';
    await putSave(id, s);
    await db.del(`state:${id}:auto`);
    await refreshFromPC();
  }
  renderLibrary();
}

// ------------------------------------------------------------------ importing
function pickFile(fn, multiple = false) {
  const i = document.createElement('input');
  i.type = 'file'; i.multiple = multiple;
  i.onchange = () => { if (i.files.length) fn(multiple ? [...i.files] : i.files[0]); };
  i.click();
}
async function expandFiles(files) {
  const out = [];
  for (const f of files) {
    const buf = new Uint8Array(await f.arrayBuffer());
    if (isZip(buf)) {
      try { for (const e of await unzip(buf)) out.push({ name: e.name.split('/').pop(), data: e.data }); } catch (err) { toast(`${f.name}: ${err.message}`); }
    } else out.push({ name: f.name, data: buf });
  }
  return out;
}
async function importFiles(files) {
  let roms = 0, bios = 0, saves = 0;
  const games = await allGames();
  for (const { name, data } of await expandFiles(files)) {
    const stem = name.replace(/\.[^.]+$/, '');
    if (data.length === 0x1000) { await setBios(data, true); bios++; continue; }
    if (data.length === EEP_SIZE) {
      const g = games.find((x) => x.file && x.file.replace(/\.[^.]+$/, '').toLowerCase() === stem.toLowerCase());
      if (g) { await storeImportedSave(g.id, data); saves++; } else toast(`${name}: open the game's ⋯ menu → Import save, to choose which game it belongs to`, 4500);
      continue;
    }
    const info = romInfo(data);
    if (!info.valid) { toast(`${name} doesn't look like a Pokémon mini ROM`); continue; }
    const romSha1 = await sha1(data);
    const id = 'local-' + romSha1.slice(0, 12);
    await db.set('rom:' + romSha1, data);
    await db.set('game:' + id, { id, title: info.title, code: info.code, file: name, source: 'local', romSha1, size: data.length, added: Date.now() });
    roms++;
  }
  const parts = [roms && `${roms} game${roms === 1 ? '' : 's'}`, bios && 'BIOS', saves && `${saves} save${saves === 1 ? '' : 's'}`].filter(Boolean);
  if (parts.length) toast('Imported ' + parts.join(', '));
  renderLibrary();
}
async function importSaveFor(id, file) {
  const [f] = await expandFiles([file]);
  if (!f || f.data.length !== EEP_SIZE) { toast('A Pokémon mini save is exactly 8 KB (.eep, or RetroArch .srm)'); return; }
  await storeImportedSave(id, f.data);
  toast('Save imported');
  renderLibrary();
}
async function storeImportedSave(id, data) {
  const s = (await getSave(id)) || { base: null, baseSha1: '', version: 0 };
  Object.assign(s, { data: data.slice(), dirty: !sameSave(data, s.base), conflict: null, version: (s.version || 0) + 1 });
  await putSave(id, s);
  await db.del(`state:${id}:auto`);
}

// ------------------------------------------------------------------ BIOS
async function getBios() {
  let b = await db.get('bios');
  if (b) return b;
  try {
    b = await api.bytes('/api/bios');
    if (b.length === 0x1000) { await db.set('bios', b); return b; }
  } catch { /* none on PC */ }
  return null;
}
async function setBios(b, quiet) {
  if (b.length !== 0x1000) { toast('That isn\'t a Pokémon mini BIOS (expected exactly 4 KB)'); return; }
  await db.set('bios', b);
  if (!quiet) toast('BIOS loaded');
  checkBios();
}
async function setBiosFromFile(file) {
  const files = await expandFiles([file]);
  const b = files.find((f) => f.data.length === 0x1000);
  if (!b) { toast('That isn\'t a Pokémon mini BIOS (expected exactly 4 KB)'); return; }
  await setBios(b.data);
}
async function checkBios() { $('#bios-banner').classList.toggle('hidden', !!(await getBios())); }

// ------------------------------------------------------------------ player
const player = {
  pm: null, id: null, game: null, save: null, running: false, raf: 0, last: 0, speed: 1,
  frame: new Uint8Array(LCD_W * LCD_H), audio: null, muted: prefs.get('muted', false),
  saveTimer: 0, eepTimer: 0, lastVibe: 0, rumbling: false,
};

async function getRom(g) {
  let rom = await db.get('rom:' + g.romSha1);
  if (rom) return rom;
  if (g.source !== 'pc') return null;
  toast('Downloading game from your PC…', 1500);
  rom = await api.bytes(`/api/games/${encodeURIComponent(g.id)}/rom`);
  await db.set('rom:' + g.romSha1, rom);
  return rom;
}

async function play(id, { slot = null } = {}) {
  const bios = await getBios();
  if (!bios) { toast('Load your Pokémon mini BIOS first'); $('#bios-input').click(); return; }
  const g = await db.get('game:' + id);
  if (!g) return;
  let rom;
  try { rom = await getRom(g); } catch (e) { toast('Could not download the game: ' + e.message); return; }
  if (!rom) { toast('Game data missing; import the ROM again'); return; }
  let s = await getSave(id);
  if (!s) s = { data: new Uint8Array(EEP_SIZE).fill(0xFF), base: null, baseSha1: '', dirty: false, conflict: null, version: 1 };
  const pm = new PokeMini({ bios, rom, eeprom: s.data, sampleRate: 48000 });
  let resumed = false;
  const st = await db.get(`state:${id}:${slot || 'auto'}`);
  if (st && st.state && st.state.v === STATE_VERSION && (slot || st.saveVersion === s.version)) {
    try { pm.loadState(st.state, new Date()); resumed = true; } catch (e) { console.warn('state load failed', e); pm.powerOn(); }
  }
  if (!resumed) { pm.eeprom.set(s.data); pm.powerOn(new Date()); }
  pm.onEepromWrite = eepromWritten;
  Object.assign(player, { pm, id, game: g, save: s });
  g.lastPlayed = Date.now();
  await db.set('game:' + id, g);
  $('#game-title').textContent = prettyTitle(g);
  $('#game-sub').textContent = resumed ? (slot ? `Loaded slot ${slot}` : 'Resumed') : (g.code ? `${g.code} · ${g.source === 'pc' ? 'from PC' : 'on this phone'}` : '');
  showView('player');
  setupAudio();
  updateUnsynced();
  start();
  if (navigator.wakeLock) navigator.wakeLock.request('screen').then((l) => { player.wake = l; }).catch(() => {});
}

function start() {
  if (player.running || !player.pm) return;
  player.running = true;
  player.last = performance.now();
  const loop = (now) => {
    if (!player.running) return;
    const dt = Math.min(0.1, Math.max(0, (now - player.last) / 1000));
    player.last = now;
    pollGamepad();
    try { player.pm.runFor(dt * player.speed); } catch (e) { console.error(e); stop(); toast('Emulator error: ' + e.message); return; }
    draw();
    player.raf = requestAnimationFrame(loop);
  };
  player.raf = requestAnimationFrame(loop);
  clearInterval(player.saveTimer);
  player.saveTimer = setInterval(() => persist(), 20000);
}
function stop() {
  player.running = false;
  $('#player').classList.remove('rumble'); player.rumbling = false; // never keep shaking while paused
  cancelAnimationFrame(player.raf);
  clearInterval(player.saveTimer);
}

const lcd = $('#lcd');
function draw() {
  const pm = player.pm;
  paint(lcd, pm.getFrame(player.frame));
  // rumble: the motor is pulsed in short bursts, so use the latch and hold each burst briefly
  const now = performance.now();
  if (pm.rumble || pm.rumbleLatch) { pm.rumbleLatch = false; player.rumbleUntil = now + 110; }
  const r = now < (player.rumbleUntil || 0);
  if (r !== player.rumbling) {
    player.rumbling = r;
    $('#player').classList.toggle('rumble', r && prefs.get('shake', true));
    $('#rumble-dot').classList.toggle('on', r);
    if (!r && navigator.vibrate) navigator.vibrate(0);
  }
  if (r && navigator.vibrate && prefs.get('vibrate', true)) {
    if (now - player.lastVibe > 90) { navigator.vibrate(120); player.lastVibe = now; }
  }
}

// game wrote its save EEPROM: keep the phone copy current (debounced)
function eepromWritten() {
  clearTimeout(player.eepTimer);
  player.eepTimer = setTimeout(() => storeEeprom(), 700);
}
async function storeEeprom() {
  const { pm, save, id, game } = player;
  if (!pm || !save) return;
  if (sameSave(pm.eeprom, save.data)) return;
  save.data = pm.eeprom.slice();
  save.dirty = game.source === 'pc' ? !sameSave(save.data, save.base) : false;
  await putSave(id, save);
  updateUnsynced();
}

async function persist() {
  const { pm, id, save } = player;
  if (!pm) return;
  try {
    await storeEeprom();
    const shot = pm.getFrame();
    await db.set(`state:${id}:auto`, { state: pm.saveState(), thumb: shot, saved: Date.now(), saveVersion: save.version });
    await db.set('thumb:' + id, shot);
  } catch (e) { console.warn('persist failed', e); }
}

function updateUnsynced() {
  const s = player.save, g = player.game;
  $('#unsynced').classList.toggle('hidden', !(s && g && s.dirty && g.source === 'pc' && api.online));
}

async function leavePlayer() {
  stop();
  await persist();
  if (player.wake) { player.wake.release().catch(() => {}); player.wake = null; }
  if (player.audio) player.audio.ctx.suspend().catch(() => {});
  if (navigator.vibrate) navigator.vibrate(0);
  $('#player').classList.remove('rumble'); $('#rumble-dot').classList.remove('on'); player.rumbling = false; player.rumbleUntil = 0;
  const { id, save, game } = player;
  player.pm = null;
  showView('library');
  // hand finished progress back to the PC straight away
  if (api.online && game && game.source === 'pc' && save && save.dirty && !save.conflict && prefs.get('autoSync', true)) await syncSave(id, false, true);
  renderLibrary();
}

// ---- audio
function setupAudio() {
  if (!player.audio) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = new AC();
    const ring = new Float32Array(16384);
    const a = { ctx, ring, r: 0, w: 0 };
    const node = ctx.createScriptProcessor(1024, 0, 1);
    node.onaudioprocess = (e) => {
      const out = e.outputBuffer.getChannelData(0);
      const avail = (a.w - a.r + ring.length) % ring.length;
      for (let i = 0; i < out.length; i++) {
        if (i < avail) { out[i] = ring[a.r]; a.r = (a.r + 1) % ring.length; } else out[i] = 0;
      }
      const left = (a.w - a.r + ring.length) % ring.length;
      if (left > 6000) a.r = (a.w - 2048 + ring.length) % ring.length; // keep latency bounded
    };
    const gain = ctx.createGain(); gain.gain.value = 0.3;
    node.connect(gain); gain.connect(ctx.destination);
    a.node = node; a.gain = gain;
    player.audio = a;
  }
  const a = player.audio;
  player.pm.sampleRate = a.ctx.sampleRate;
  player.pm.audioOut = player.muted ? null : (buf) => {
    if (player.speed !== 1) return;
    for (let i = 0; i < buf.length; i++) { a.ring[a.w] = buf[i]; a.w = (a.w + 1) % a.ring.length; }
  };
  if (!player.muted) a.ctx.resume().catch(() => {});
  $('#btn-sound').textContent = player.muted ? '🔇' : '🔈';
}

// ---- input
let held = 0, padMask = 0;
const pointerBtn = new Map();
function applyButtons() {
  let m = held | padMask;
  for (const b of pointerBtn.values()) m |= b;
  if (player.pm) player.pm.setButtons(m);
  document.querySelectorAll('[data-btn]').forEach((el) => el.classList.toggle('pressed', (m & +el.dataset.btn) !== 0));
}
function btnAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const b = el && el.closest && el.closest('[data-btn]');
  return b ? +b.dataset.btn : 0;
}
function setupInput() {
  const dev = $('#device');
  const onDown = (e) => {
    if (e.target.closest('#btn-shake')) return;
    const b = btnAt(e.clientX, e.clientY);
    if (!b) return;
    e.preventDefault();
    dev.setPointerCapture?.(e.pointerId);
    pointerBtn.set(e.pointerId, b);
    if (navigator.vibrate && prefs.get('vibrate', true)) navigator.vibrate(8);
    if (player.audio && player.audio.ctx.state !== 'running' && !player.muted) player.audio.ctx.resume();
    applyButtons();
  };
  const onMove = (e) => {
    if (!pointerBtn.has(e.pointerId)) return;
    const b = btnAt(e.clientX, e.clientY);
    // sliding a thumb across the d-pad or from B to A switches buttons (never drops to nothing mid-slide)
    if (b && b !== pointerBtn.get(e.pointerId)) { pointerBtn.set(e.pointerId, b); if (navigator.vibrate && prefs.get('vibrate', true)) navigator.vibrate(5); applyButtons(); }
  };
  const onUp = (e) => { if (pointerBtn.delete(e.pointerId)) applyButtons(); };
  dev.addEventListener('pointerdown', onDown);
  dev.addEventListener('pointermove', onMove);
  dev.addEventListener('pointerup', onUp);
  dev.addEventListener('pointercancel', onUp);
  dev.addEventListener('contextmenu', (e) => e.preventDefault());
  $('#btn-shake').addEventListener('pointerdown', (e) => { e.preventDefault(); shake(); });
  const keys = { ArrowUp: BTN.UP, ArrowDown: BTN.DOWN, ArrowLeft: BTN.LEFT, ArrowRight: BTN.RIGHT, x: BTN.A, X: BTN.A, Enter: BTN.A, ' ': BTN.A, z: BTN.B, Z: BTN.B, c: BTN.C, C: BTN.C, Shift: BTN.C, p: BTN.POWER, P: BTN.POWER };
  addEventListener('keydown', (e) => {
    if (!player.pm || !$('#player').classList.contains('active') || !$('#sheet').classList.contains('hidden')) return;
    if (e.key === 's' || e.key === 'S') { shake(); return; }
    const b = keys[e.key];
    if (b) { held |= b; applyButtons(); e.preventDefault(); }
  });
  addEventListener('keyup', (e) => { const b = keys[e.key]; if (b) { held &= ~b; applyButtons(); } });
  addEventListener('blur', () => { held = 0; pointerBtn.clear(); applyButtons(); });
}
function shake() {
  if (!player.pm) return;
  player.pm.shake();
  if (prefs.get('shake', true)) {
    $('#player').animate([{ transform: 'translate(0,0)' }, { transform: 'translate(-12px,3px) rotate(-.8deg)' }, { transform: 'translate(11px,-3px) rotate(.7deg)' },
      { transform: 'translate(-6px,2px) rotate(-.3deg)' }, { transform: 'translate(0,0)' }], { duration: 200 });
  }
  if (navigator.vibrate) navigator.vibrate(30);
}
// game controllers (Bluetooth/USB) via the Gamepad API
function pollGamepad() {
  if (!navigator.getGamepads) return;
  let m = 0;
  for (const gp of navigator.getGamepads()) {
    if (!gp) continue;
    const p = (i) => gp.buttons[i] && gp.buttons[i].pressed;
    if (p(0)) m |= BTN.A;
    if (p(1)) m |= BTN.B;
    if (p(2) || p(3)) m |= BTN.C;
    if (p(12) || gp.axes[1] < -0.5) m |= BTN.UP;
    if (p(13) || gp.axes[1] > 0.5) m |= BTN.DOWN;
    if (p(14) || gp.axes[0] < -0.5) m |= BTN.LEFT;
    if (p(15) || gp.axes[0] > 0.5) m |= BTN.RIGHT;
    if (p(4) || p(5)) { if (!pollGamepad.shook) shake(); pollGamepad.shook = true; } else pollGamepad.shook = false;
    if (p(9) && !pollGamepad.menu) { pollGamepad.menu = true; playerMenu(); } else if (!p(9)) pollGamepad.menu = false;
  }
  if (m !== padMask) { padMask = m; applyButtons(); }
}

// ------------------------------------------------------------------ menus
async function slotsSheet() {
  const { id } = player;
  const slots = [];
  for (const n of [1, 2, 3]) slots.push(await db.get(`state:${id}:${n}`));
  const html = `<p>Save states capture the whole console. Loading one also restores the game save from that moment.</p><div class="slots">${
    slots.map((s, i) => `<div class="slot" data-n="${i + 1}"><div class="pic"></div><div>Slot ${i + 1}<br><span class="muted">${s ? ago(s.saved) : 'empty'}</span></div>
      <div class="row"><button class="btn" data-act="save">Save</button><button class="btn" data-act="load" ${s ? '' : 'disabled'}>Load</button></div></div>`).join('')}</div>`;
  stop();
  await sheet('Save states', html, [{ label: 'Close', value: null }], (body, close) => {
    body.querySelectorAll('.slot').forEach((el) => {
      const n = +el.dataset.n, s = slots[n - 1];
      el.querySelector('.pic').appendChild(s ? thumbCanvas(s.thumb) : Object.assign(document.createElement('div'), { className: 'empty-slot', textContent: '—' }));
      el.querySelectorAll('button').forEach((b) => b.onclick = async () => {
        if (b.dataset.act === 'save') {
          await db.set(`state:${id}:${n}`, { state: player.pm.saveState(), thumb: player.pm.getFrame(), saved: Date.now(), saveVersion: player.save.version });
          toast(`Saved to slot ${n}`);
        } else {
          try { player.pm.loadState(s.state); toast(`Loaded slot ${n}`); eepromWritten(); } catch (e) { toast('Could not load: ' + e.message); }
        }
        close(null);
      });
    });
  });
  if ($('#player').classList.contains('active')) start();
}

async function playerMenu() {
  if (!player.pm || !$('#sheet').classList.contains('hidden')) return;
  const { game, save } = player;
  const acts = [
    { label: 'Save states…', value: 'slots', cls: 'primary' },
    { label: 'Restart game', value: 'restart' },
    { label: 'Shake the console', value: 'shake' },
    { label: 'Screen & colours…', value: 'look' },
  ];
  if (game.source === 'pc' && save.dirty && api.online) acts.splice(1, 0, { label: 'Send save to PC', value: 'sync' });
  acts.push({ label: 'Close', value: null });
  stop();
  const v = await sheet('Options', '<p>The game only runs while this screen is open; leaving it saves a snapshot so you can carry on later. Keyboard: arrows, X = A, Z = B, C = C, S = shake.</p>', acts);
  if (v === 'slots') { await slotsSheet(); return; }
  if (v === 'restart') { await db.del(`state:${player.id}:auto`); await storeEeprom(); player.pm.eeprom.set(player.save.data); player.pm.powerOn(new Date()); }
  if (v === 'shake') shake();
  if (v === 'sync') { await persist(); await syncSave(player.id); }
  if (v === 'look') { await lookSheet(); }
  start();
}

async function lookSheet() {
  const shells = [['blue', '#5aa6e0'], ['green', '#8cc251'], ['purple', '#a68ad6'], ['white', '#e8e8e2'], ['smoke', '#59606e']];
  const cur = prefs.get('shell', 'blue'), pal = prefs.get('palette', 'classic');
  const html = `<p>Console colour</p><div class="swatches">${shells.map(([k, c]) => `<button class="swatch ${k === cur ? 'sel' : ''}" data-shell="${k}" style="background:${c}" aria-label="${k}"></button>`).join('')}</div>
    <p>Screen</p><div class="swatches">${Object.entries(PALETTES).map(([k, p]) => `<button class="swatch ${k === pal ? 'sel' : ''}" data-pal="${k}" style="background:rgb(${p.bg});box-shadow:inset -12px -12px 0 rgb(${p.ink})" aria-label="${p.name}"></button>`).join('')}</div>
    <label class="field"><span><input type="checkbox" id="shk" ${prefs.get('shake', true) ? 'checked' : ''}> Shake the screen when the game rumbles</span></label>
    <label class="field"><span><input type="checkbox" id="vib" ${prefs.get('vibrate', true) ? 'checked' : ''}> Vibrate the phone too, where the browser allows it</span></label>`;
  await sheet('Screen & colours', html, [{ label: 'Done', value: null }], (body) => {
    body.querySelectorAll('[data-shell]').forEach((b) => b.onclick = () => { prefs.set('shell', b.dataset.shell); applyShell(); body.querySelectorAll('[data-shell]').forEach((x) => x.classList.toggle('sel', x === b)); });
    body.querySelectorAll('[data-pal]').forEach((b) => b.onclick = () => { prefs.set('palette', b.dataset.pal); buildLut(); if (player.pm) draw(); body.querySelectorAll('[data-pal]').forEach((x) => x.classList.toggle('sel', x === b)); });
    body.querySelector('#vib').onchange = (e) => prefs.set('vibrate', e.target.checked);
    body.querySelector('#shk').onchange = (e) => prefs.set('shake', e.target.checked);
  });
  renderLibrary();
}
function applyShell() { document.documentElement.dataset.shell = prefs.get('shell', 'blue'); }

// Where this copy came from, for the links in Settings.
function siteLinks() {
  const m = location.hostname.match(/^([a-z0-9-]+)\.github\.io$/i);
  const repo = location.pathname.split('/').filter(Boolean)[0];
  return { source: m && repo ? `https://github.com/${m[1]}/${repo}` : '', home: prefs.get('home', '') };
}
// Arrived from a console-picker page on the same site? Remember it so Settings can link back.
(function rememberHome() {
  try {
    const r = document.referrer && new URL(document.referrer);
    const here = new URL('.', location.href).pathname;
    if (r && r.origin === location.origin && !r.pathname.startsWith(here)) prefs.set('home', r.origin + r.pathname);
  } catch { /* no referrer */ }
})();

async function settingsMenu() {
  const { source, home } = siteLinks();
  const about = `<p class="about">An emulator for the Pokémon mini that runs in your browser. It includes no BIOS and no games: load your own dumps, and they never leave this device.${
    source ? ` Free software (GPL-3.0): <a href="${esc(source)}" target="_blank" rel="noopener">source code</a>.` : ''}</p>`;
  const body = api.standalone
    ? `<p>This copy runs entirely on this device: the BIOS, games, saves and save states are kept in this browser's storage. Clearing the browser's site data erases them, so download saves you care about (⋯ on a game).</p>
       <p>Want saves synced with a PC, and games served from it? Run the MiniSync companion from the source code.</p>${about}`
    : `<p>${api.online ? 'Connected to MiniSync on your PC.' : 'Not connected to your PC. Open this page from the address MiniSync prints (e.g. <code>http://192.168.1.20:8766</code>).'}</p>
    <label class="field">Access token (only if you set one on the PC)<input id="tok" value="${esc(prefs.get('token', ''))}" autocomplete="off"></label>
    <label class="field"><span><input type="checkbox" id="autosync" ${prefs.get('autoSync', true) ? 'checked' : ''}> Send saves to the PC automatically when leaving a game</span></label>${about}`;
  const acts = [];
  if (!api.standalone) acts.push({ label: 'Save & refresh', value: 'tok', cls: 'primary' });
  acts.push({ label: 'Screen & colours…', value: 'look' }, { label: 'Replace BIOS file', value: 'bios' });
  if (home) acts.push({ label: '‹ All consoles', value: 'home' });
  acts.push({ label: 'Erase everything on this device', value: 'wipe', cls: 'danger' }, { label: 'Close', value: null });
  const v = await sheet('Settings', body, acts, (el) => { const c = el.querySelector('#autosync'); if (c) c.onchange = (e) => prefs.set('autoSync', e.target.checked); });
  if (v === 'tok') { prefs.set('token', (document.getElementById('tok')?.value || '').trim()); await boot(); }
  if (v === 'look') lookSheet();
  if (v === 'bios') $('#bios-input').click();
  if (v === 'home') location.href = home;
  if (v === 'wipe') {
    const ok = await sheet('Erase all local data?', `<p>Removes the BIOS, games, saves and save states stored on this device.${api.standalone ? '' : ' Files on your PC are not touched.'}</p>`, [{ label: 'Erase', value: true, cls: 'danger' }, { label: 'Cancel', value: false }]);
    if (ok) { for (const k of await db.keys()) await db.del(k); location.reload(); }
  }
}

// ------------------------------------------------------------------ live updates from the PC
function listenForChanges() {
  if (!window.EventSource || !api.online) return;
  const t = api.token();
  const es = new EventSource('/api/events' + (t ? '?token=' + encodeURIComponent(t) : ''));
  es.addEventListener('games', async () => {
    if ($('#library').classList.contains('active')) { await refreshFromPC(); renderLibrary(); }
  });
}

// ------------------------------------------------------------------ boot
async function boot() {
  await checkBios();
  await refreshFromPC();
  await renderLibrary();
}

applyShell();
buildLut();
$('#bios-input').addEventListener('change', (e) => { if (e.target.files[0]) setBiosFromFile(e.target.files[0]); e.target.value = ''; });
$('#import-input').addEventListener('change', (e) => { importFiles([...e.target.files]); e.target.value = ''; });
$('#btn-back').onclick = leavePlayer;
$('#btn-menu').onclick = settingsMenu;
$('#btn-pmenu').onclick = playerMenu;
$('#btn-sync-now').onclick = async () => { await persist(); syncSave(player.id); };
$('#btn-sound').onclick = () => { player.muted = !player.muted; prefs.set('muted', player.muted); if (player.pm) setupAudio(); };
$('#btn-ff').onclick = () => { player.speed = player.speed === 1 ? 3 : 1; $('#btn-ff').classList.toggle('on', player.speed !== 1); };
document.addEventListener('visibilitychange', () => {
  if (!player.pm) return;
  if (document.hidden) { stop(); persist(); }
  else if ($('#player').classList.contains('active') && $('#sheet').classList.contains('hidden')) start();
});
addEventListener('pagehide', () => { if (player.pm) persist(); });
setupInput();
boot().then(listenForChanges);
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
window.__wpm = { player, db, renderLibrary };
