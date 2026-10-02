# Web Pokémon mini + MiniSync

A Pokémon mini emulator that runs in a phone or desktop browser, written in plain JavaScript with no dependencies. It installs as an app, works offline, and has touch controls, sound, rumble (screen shake), the shake sensor and save states.

**No BIOS and no games are included.** You load your own dumps; they are stored in your browser and never uploaded anywhere.

There are two ways to use it:

* **As a website** (this repo publishes one with GitHub Pages; the address is in the repo's *About* box). Open it, tap **Choose BIOS file**, then **Import ROM or save…**. Everything stays on that device.
* **From your own Linux PC with MiniSync**, which serves the app to your phone over Wi-Fi/Tailscale, hands it the games in your ROM folder, and keeps saves in sync with the PC (and with RetroArch/PokeMini). The rest of this README covers that.

```
 ROM folder (.min / .zip) ──▶ MiniSync (on your PC) ──Wi-Fi/Tailscale──▶ phone browser
 game saves (.eep, 8 KB)  ◀──writes back (with backups)──────────────────  (Pokémon mini emulator)
```

* **web/**: the emulator and phone UI. It runs the real Pokémon mini BIOS on an S1C88 CPU emulator, with touch buttons, sound, rumble, the shake sensor, save states, and it installs as an app.
* **companion/minisync.py**: the PC side. It finds your ROMs and BIOS, serves the app to your phone, keeps every game's save on the PC with a history of every version, and accepts changed saves back.

It is a sibling of Web PocketStation, and uses port **8766** so both can run at once.

## Quick start

1. Run it once to try it:
   ```bash
   bash run.sh
   ```
   With no arguments it looks for ROMs in the folder that contains this project. Otherwise: `bash run.sh --roms "/path/to/roms"`.
   It prints addresses like `http://192.168.1.20:8766`. Open one on your phone, on the same Wi-Fi.
2. Tap a game. The BIOS is fetched from your PC automatically if it's in the ROM folder (a 4 KB `.min`/`.bin`, or a zip of it); otherwise tap **Choose BIOS file** on the phone.
3. **Add to Home Screen** from your browser menu makes it full-screen like an app.

### Install as a background service (starts when you log in)

```bash
bash install.sh                                   # ROM folder = the folder containing this project
bash install.sh "/path/to/roms" --token mysecret   # explicit folder; require a token (recommended with Tailscale/public Wi-Fi)
```

### Away from home

Install [Tailscale](https://tailscale.com) on the PC and the phone (free), then open `http://<pc-tailscale-ip>:8766`. Use `--token` so only you can get in. Open the link once as `http://…:8766/?token=mysecret` and the phone remembers it.

**Offline play:** browsers only allow a fully installed, offline-capable app over HTTPS. Tailscale can provide that: `tailscale serve --bg 8766` gives you an `https://<pc-name>.<tailnet>.ts.net` address (see `tailscale serve --help` if your version differs). Opened from that address, the app and every game you've played once keep working with no connection at all. Over plain `http://`, games and saves are still stored on the phone, but the page itself needs the PC to load.

## Where games and saves live

* **ROMs**: `.min` files, or `.zip` files containing one, anywhere in your ROM folders (searched 3 levels deep), plus `~/.local/share/minisync/roms/`. New files show up on the phone within a couple of seconds. You can also import ROMs straight on the phone (**Import ROM or save…**); those stay on the phone only.
* **Saves**: each game's save is the console's 8 KB EEPROM, the same `.eep` format PokeMini and RetroArch use. MiniSync uses, in this order:
  1. `<rom name>.eep` next to the ROM (standalone PokeMini),
  2. `<rom name>.eep` in RetroArch's saves folder (also the Flatpak/Snap locations and a `PokeMini` subfolder),
  3. otherwise `~/.local/share/minisync/saves/<rom name>.eep`.

  So progress made in RetroArch on the PC appears on the phone, and the other way round.
* **History**: every version of every save is kept in `~/.local/share/minisync/history/<game>/`.

## Using it

| | |
|---|---|
| Tap a game | Boots it. The clock is set from your phone automatically. |
| ← back | Saves a snapshot, so next time the game resumes exactly where you left it. A changed game save is sent to the PC straight away (switch this off in ⋯ Settings). |
| ⋯ in a game | Save states (3 slots per game), restart, shake, console colour and screen palette. |
| Rumble | The whole screen shakes and the little light under the screen glows (phones rarely let web pages vibrate; where they do, it vibrates too). Both can be switched off under *Screen & colours*. |
| » | Fast forward (3×, sound off). |
| shake | The shock sensor. Pokémon Pinball mini uses it to nudge the table. |
| power | The console's power button: off, and on again (the game restarts, like the real thing). |
| ⋯ on a game card | Start fresh, send/download/import a save, delete save states. |
| Sideways | Turn the phone for a wide layout: d-pad left, screen centre, buttons right. |
| Keyboard | Arrows, X = A, Z = B, C = C, S = shake, P = power. Bluetooth/USB gamepads work too. |

**Conflicts:** if a save changed on the PC *and* on the phone since the last sync, you're asked which one to keep. Either way the PC keeps a backup in the history folder.

**Tip:** close the game in RetroArch/PokeMini before the phone sends a save; a running emulator keeps the save in memory and can write over it.

## Tested

With the retail BIOS: Pokémon Party mini, Pokémon Pinball mini, Pokémon Puzzle Collection, Pokémon Zany Cards and Lunch Time all boot and play, with sound, rumble, saves, save states and phone→PC write-back with conflict detection.

The CPU and hardware emulation were checked instruction by instruction against PokeMini, the reference emulator this core is modelled on. Every one of those games produces an identical trace: 2–3 million instructions each with scripted input, then 5 minutes each with random input, compared at checkpoints. That holds after correcting two bugs in PokeMini that the comparison exposed, where this core deliberately differs:

* `ADC`/`SBC` carry out when the incoming carry is what tips the result over (PokeMini drops it, which breaks multi-byte subtraction; Pinball hit this within two minutes of random play).
* Writes to I/O registers `$53`–`$55` (PokeMini lets them fall through and overwrite the I/O port direction register).

Two more intentional differences: BCD-mode add/subtract carry between digits properly, and a blank save EEPROM is formatted before the first boot the same way the console formats it, so the clock is correct from the first run instead of only from the second.

## Developer notes

* `web/core/s1c88.js`: the S1C88 ("Minx") CPU: all three opcode pages, banked code/data addressing, the delayed `U` bank register, interrupts, HALT. No dependencies; runs in browsers and Node.
* `web/core/pokemini.js`: the hardware: memory map, interrupt controller, three timers, 256 Hz and seconds counters, PRC (tile map + 24 sprites), SED1565 LCD controller with 4-frame blending for flicker greys, I2C EEPROM, keypad, rumble, shock sensor, timer-3 PWM sound, plus `saveState()`/`loadState()`.
* `web/zip.js`: tiny zip reader for imports on the phone.
* `tests/`: Node scripts, run from this folder. They read ROMs and the BIOS (`.min` or zips) from `$POKEMINI_ROMS`, or `../legally extracted roms` / `../roms`.
  * `node tests/smoke.mjs [game] ["w3 s A w2 s"]`: boot games, press buttons, print the screen as text.
  * `node tests/state.mjs`: save-state round trip and EEPROM activity for every game.
  * `node tests/audio.mjs [outDir] [seconds]`: render each game's sound to a WAV file.
  * `node tests/trace.mjs <game> <cycles> <from>`: instruction trace, for comparing with another emulator.
  * `python3 tests/e2e.py [url] [shots dir]`: drives the real app in a phone-sized Chromium (needs Playwright) against a running MiniSync.

The core is plain JS with no DOM dependencies, so several consoles can run at once (one `PokeMini` object each).

## Next: C++ port for the M5Stack CoreS3 + Faces Gamepad3

The core was written to port directly, the way `pscore.cpp` followed `pocketstation.js`:

* State is flat numbers and fixed-size byte arrays (4 KB RAM, 256 I/O registers, 8 KB EEPROM, 2.3 KB LCD RAM): about 21 KB plus the ROM (512 KB each, which fits in PSRAM, or can be read from flash).
* The CPU is one `switch` per opcode page; timers use 32-bit fixed-point counters already.
* A 4 MHz S1C88 needs roughly 400,000 instructions per second; the ESP32-S3 at 240 MHz has plenty of headroom.
* The 96×64 screen scales ×3 to 288×192 on the CoreS3's 320×240 display. Gamepad3: d-pad, A, B, with C on SELECT and the menu on START.
* `tests/trace.mjs` gives the reference trace for a frame-by-frame host test of the C++ core, like `esp32/test/host.cpp` in the PocketStation project.
* MiniSync's API is the same shape as PocketSync's (`/api/games`, `/api/games/<id>/rom`, `/api/games/<id>/save` with `X-Base-Sha1`), so the device-side sync code carries over.

## Publishing your own copy

`bash publish.sh` creates a public GitHub repo from this folder, pushes the code to `main`, pushes the `web/` folder to a `gh-pages` branch and switches on GitHub Pages for it (it needs `git` and the GitHub CLI `gh`, logged in).

To publish a change later: `git add -A && git commit -m "what changed" && bash publish.sh`.

By hand: create an empty public repo, `git init -b main && git add -A && git commit -m "Initial public release" && git remote add origin <repo url> && git push -u origin main`, then `git push origin "$(git subtree split --prefix web main)":refs/heads/gh-pages --force`, and set *Settings → Pages → Deploy from a branch* to `gh-pages`, `/ (root)`.

`.gitignore` keeps BIOS files, ROMs and saves out of the repo. Do not add them: they are copyrighted, and a public repo would be distributing them.

## Licence and credits

Web Pokémon mini is free software under the **GNU General Public License, version 3 or later** (see `LICENSE`). It comes with no warranty.

* The emulation core was written for this project in JavaScript, but it is modelled closely on **PokeMini** by JustBurn and contributors (GPL-3.0-or-later, <https://github.com/libretro/PokeMini>): the hardware behaviour, instruction timings and several tables (I/O power-on values, LCD contrast levels) follow it. That is why this project carries the same licence.
* Hardware documentation: <https://www.pokemon-mini.net/documentation/>.

This is an unofficial fan project. It is not affiliated with, endorsed by or sponsored by Nintendo, The Pokémon Company, Creatures or GAME FREAK. "Pokémon" and "Pokémon mini" are trademarks of their respective owners and are used here only to say what the emulator is compatible with.
