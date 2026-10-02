#!/usr/bin/env python3
# MiniSync - Copyright (C) 2026 the Web Pokémon mini authors.
# Free software under the GNU General Public License, version 3 or later; see LICENSE. No warranty.
"""
MiniSync - PC companion for Web Pokémon mini (Linux, Python 3.8+, no dependencies).

* Finds your Pokémon mini ROMs (.min, or .zip files containing one) and BIOS in your ROM folders.
* Serves the Web Pokémon mini app + a small JSON API to your phone over Wi-Fi/Tailscale.
* Keeps each game's save (8 KB EEPROM) on the PC, shared with RetroArch / PokeMini if you use them,
  with a history of every version, and accepts changed saves back from the phone
  (with conflict detection and automatic backups).

Run:  python3 minisync.py --roms "/path/to/roms"   (then open the printed address on your phone)
Help: python3 minisync.py --help
"""
import argparse
import hashlib
import http.server
import json
import os
import queue
import re
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
import time
import urllib.parse
import zipfile
from pathlib import Path

VERSION = "1.0.0"
EEP_SIZE = 0x2000
BIOS_SIZE = 0x1000
HOME = Path.home()
XDG_DATA = Path(os.environ.get("XDG_DATA_HOME", HOME / ".local/share"))
DEFAULT_DATA = XDG_DATA / "minisync"
# where desktop emulators keep Pokémon mini saves (<rom name>.eep)
RETROARCH_SAVE_DIRS = [
    Path(os.environ.get("XDG_CONFIG_HOME", HOME / ".config")) / "retroarch/saves",
    HOME / ".var/app/org.libretro.RetroArch/config/retroarch/saves",  # Flatpak
    HOME / "snap/retroarch/current/.config/retroarch/saves",          # Snap
]
MAX_DEPTH = 3


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def sha1(b: bytes) -> str:
    return hashlib.sha1(b).hexdigest()


def slug(s: str) -> str:
    s = re.sub(r"[^A-Za-z0-9._-]+", "-", s).strip("-")
    return s[:80] or "game"


def is_rom(data: bytes) -> bool:
    return len(data) > 0x21C0 and data[0x2100:0x2102] == b"MN"


def rom_header(data: bytes):
    code = data[0x21AC:0x21B0].split(b"\0")[0].decode("ascii", "replace")
    title = data[0x21B0:0x21BC].split(b"\0")[0].decode("ascii", "replace").strip()
    return code, title


def read_rom_file(p: Path):
    """Return (rom bytes, name inside zip or None) for a .min or a .zip holding one, else (None, None)."""
    try:
        if p.suffix.lower() == ".zip":
            with zipfile.ZipFile(p) as z:
                for info in z.infolist():
                    if info.filename.lower().endswith(".min") and info.file_size > BIOS_SIZE:
                        data = z.read(info)
                        if is_rom(data):
                            return data, info.filename
            return None, None
        data = p.read_bytes()
        return (data, None) if is_rom(data) else (None, None)
    except (OSError, zipfile.BadZipFile, RuntimeError):
        return None, None


def read_bios_file(p: Path):
    try:
        if p.suffix.lower() == ".zip":
            with zipfile.ZipFile(p) as z:
                for info in z.infolist():
                    if info.file_size == BIOS_SIZE and info.filename.lower().endswith((".min", ".bin")):
                        return z.read(info)
            return None
        if p.stat().st_size == BIOS_SIZE:
            return p.read_bytes()
    except (OSError, zipfile.BadZipFile, RuntimeError):
        pass
    return None


def walk(folder: Path, depth=0):
    try:
        entries = sorted(folder.iterdir())
    except OSError:
        return
    for p in entries:
        if p.name.startswith("."):
            continue
        if p.is_dir():
            if depth < MAX_DEPTH:
                yield from walk(p, depth + 1)
        elif p.is_file():
            yield p


class Game:
    def __init__(self, gid, path: Path):
        self.id = gid
        self.path = path
        self.stem = path.stem
        self.code = self.title = ""
        self.rom_sha1 = ""
        self.size = 0
        self.mtime = 0.0
        self.save_path: Path = None
        self.save_sha1 = ""
        self.save_mtime = 0.0
        self.inner = None          # file name inside a .zip
        self.size_on_disk = 0

    def info(self):
        return {"id": self.id, "file": self.path.name, "title": self.title, "code": self.code, "romSha1": self.rom_sha1,
                "size": self.size,
                "save": {"sha1": self.save_sha1, "mtime": self.save_mtime, "file": str(self.save_path)} if self.save_sha1 else None}


class Library:
    def __init__(self, rom_folders, data_dir: Path, keep_history=40):
        self.rom_folders = rom_folders
        self.data_dir = data_dir
        self.save_dir = data_dir / "saves"
        self.history_dir = data_dir / "history"
        self.keep = keep_history
        self.games = {}            # id -> Game
        self.bios_path = None
        self.lock = threading.RLock()
        self.listeners = set()
        self.save_dir.mkdir(parents=True, exist_ok=True)
        self.history_dir.mkdir(parents=True, exist_ok=True)

    # ---------- discovery ----------
    def save_candidates(self, g: Game):
        names = [g.stem + ".eep"]
        if g.path.suffix.lower() == ".zip" and g.inner:
            inner = Path(g.inner).stem + ".eep"
            if inner not in names:
                names.append(inner)
        dirs = [g.path.parent]
        for d in RETROARCH_SAVE_DIRS:
            dirs += [d, d / "PokeMini"]
        out = []
        for d in dirs:
            for n in names:
                out.append(d / n)
        return out

    def find_save(self, g: Game) -> Path:
        for c in self.save_candidates(g):
            if c.is_file() and c.stat().st_size == EEP_SIZE:
                return c
        return self.save_dir / (g.stem + ".eep")

    def scan(self):
        changed = []
        seen = set()
        bios = None
        with self.lock:
            files = []
            for folder in self.rom_folders:
                if folder.is_dir():
                    files += [p for p in walk(folder) if p.suffix.lower() in (".min", ".zip", ".bin")]
            for p in files:
                try:
                    st = p.stat()
                except OSError:
                    continue
                if bios is None and (st.st_size == BIOS_SIZE or (p.suffix.lower() == ".zip" and "bios" in p.name.lower())):
                    if read_bios_file(p):
                        bios = p
                        continue
                if p.suffix.lower() == ".bin" or st.st_size <= BIOS_SIZE:
                    continue
                gid = slug(p.stem)
                base, n = gid, 2
                while gid in seen:
                    gid, n = f"{base}-{n}", n + 1
                g = self.games.get(gid)
                if g is None or g.path != p or g.mtime != st.st_mtime or g.size_on_disk != st.st_size:
                    data, inner = read_rom_file(p)
                    if data is None:
                        continue
                    g = Game(gid, p)
                    g.inner = inner
                    g.code, g.title = rom_header(data)
                    g.rom_sha1 = sha1(data)
                    g.size = len(data)
                    g.mtime, g.size_on_disk = st.st_mtime, st.st_size
                    self.games[gid] = g
                    changed.append(gid)
                seen.add(gid)
                # save file
                sp = self.find_save(g)
                if sp != g.save_path:
                    g.save_path, g.save_sha1, g.save_mtime = sp, "", 0.0
                try:
                    sst = sp.stat()
                    if sst.st_size == EEP_SIZE and sst.st_mtime != g.save_mtime:
                        data = sp.read_bytes()
                        h = sha1(data)
                        g.save_mtime = sst.st_mtime
                        if h != g.save_sha1:
                            first = g.save_sha1 == ""
                            g.save_sha1 = h
                            self.snapshot(g, data)
                            if not first:
                                log(f"save changed on PC: {sp}")
                            changed.append(gid)
                except OSError:
                    if g.save_sha1:
                        g.save_sha1, g.save_mtime = "", 0.0
                        changed.append(gid)
            for gid in list(self.games):
                if gid not in seen:
                    del self.games[gid]
                    changed.append(gid)
            if bios != self.bios_path:
                self.bios_path = bios
                changed.append("bios")
        return changed

    # ---------- history ----------
    def snapshot(self, g: Game, data: bytes, tag="pc"):
        d = self.history_dir / g.id
        d.mkdir(parents=True, exist_ok=True)
        existing = sorted(d.glob("*.eep"))
        if existing and sha1(existing[-1].read_bytes()) == sha1(data):
            return
        (d / (time.strftime("%Y%m%d-%H%M%S") + f"-{tag}.eep")).write_bytes(data)
        for old in existing[: max(0, len(existing) + 1 - self.keep)]:
            try:
                old.unlink()
            except OSError:
                pass

    def history(self, gid):
        d = self.history_dir / gid
        if not d.is_dir():
            return []
        return [{"name": f.name, "size": f.stat().st_size, "mtime": f.stat().st_mtime} for f in sorted(d.glob("*.eep"), reverse=True)]

    # ---------- phone -> PC ----------
    def write_save(self, gid, data: bytes, base_sha1: str, force=False):
        with self.lock:
            g = self.games.get(gid)
            if g is None:
                return 404, {"error": "unknown game"}
            current = b""
            try:
                if g.save_path.is_file():
                    current = g.save_path.read_bytes()
            except OSError:
                pass
            cur_hash = sha1(current) if current else ""
            if not force and cur_hash and base_sha1 != cur_hash:
                return 409, {"error": "save changed on the PC since the phone last synced", "sha1": cur_hash}
            if current:
                self.snapshot(g, current, tag="before-phone")
            g.save_path.parent.mkdir(parents=True, exist_ok=True)
            tmp = g.save_path.with_name("." + g.save_path.name + ".minisync.tmp")
            tmp.write_bytes(data)
            if current:
                try:
                    shutil.copymode(g.save_path, tmp)
                except OSError:
                    pass
            os.replace(tmp, g.save_path)
            st = g.save_path.stat()
            g.save_mtime, g.save_sha1 = st.st_mtime, sha1(data)
            self.snapshot(g, data, tag="phone")
            log(f"phone -> PC: wrote {g.save_path}")
            return 200, {"ok": True, "sha1": g.save_sha1}

    # ---------- change notifications (Server-Sent Events) ----------
    def notify(self, event, data):
        for q in list(self.listeners):
            try:
                q.put_nowait((event, data))
            except queue.Full:
                pass

    def watch_forever(self, interval=2.0):
        while True:
            try:
                changed = self.scan()
                if changed:
                    self.notify("games", {"changed": changed})
            except Exception as e:  # keep watching no matter what
                log("watch error:", e)
            time.sleep(interval)


def emulator_running():
    try:
        out = subprocess.run(["pgrep", "-i", "retroarch|pokemini"], capture_output=True, text=True, timeout=2)
        return any(l.strip() and int(l) != os.getpid() for l in out.stdout.split())
    except Exception:
        return False


def local_addresses():
    addrs = set()
    try:
        out = subprocess.run(["ip", "-o", "-4", "addr", "show"], capture_output=True, text=True, timeout=2).stdout
        for m in re.finditer(r"inet (\d+\.\d+\.\d+\.\d+)", out):
            if not m.group(1).startswith("127."):
                addrs.add(m.group(1))
    except Exception:
        pass
    if not addrs:
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("10.255.255.255", 1))
            addrs.add(s.getsockname()[0])
            s.close()
        except Exception:
            pass
    return sorted(addrs)


def make_handler(cfg, lib: Library):
    web_root = cfg.web_dir.resolve()
    mime = {".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
            ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json"}

    class Handler(http.server.BaseHTTPRequestHandler):
        server_version = "MiniSync/" + VERSION
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            if cfg.verbose:
                log(self.address_string(), fmt % args)

        def send(self, code, body=b"", ctype="application/json", extra=None):
            if isinstance(body, (dict, list)):
                body = json.dumps(body).encode()
            elif isinstance(body, str):
                body = body.encode()
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def authed(self, query):
            if not cfg.token:
                return True
            tok = self.headers.get("X-Token") or (query.get("token") or [""])[0]
            return tok == cfg.token

        def route(self):
            u = urllib.parse.urlsplit(self.path)
            return urllib.parse.unquote(u.path), urllib.parse.parse_qs(u.query)

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            path, q = self.route()
            if path.startswith("/api/"):
                if not self.authed(q):
                    return self.send(401, {"error": "token required"})
                return self.api_get(path, q)
            return self.static(path)

        def static(self, path):
            if path in ("", "/"):
                path = "/index.html"
            target = (web_root / path.lstrip("/")).resolve()
            if (web_root not in target.parents and target != web_root) or not target.is_file():
                return self.send(404, "not found", "text/plain")
            self.send(200, target.read_bytes(), mime.get(target.suffix, "application/octet-stream"))

        def api_get(self, path, q):
            parts = [p for p in path.split("/") if p][1:]  # drop "api"
            if parts == ["status"]:
                return self.send(200, {"version": VERSION, "romFolders": [str(f) for f in lib.rom_folders],
                                       "bios": bool(lib.bios_path), "emulatorRunning": emulator_running()})
            if parts == ["games"]:
                with lib.lock:
                    games = [g.info() for g in lib.games.values()]
                return self.send(200, {"host": socket.gethostname(), "games": sorted(games, key=lambda g: g["file"].lower()),
                                       "bios": bool(lib.bios_path), "emulatorRunning": emulator_running()})
            if len(parts) >= 3 and parts[0] == "games":
                g = lib.games.get(parts[1])
                if not g:
                    return self.send(404, {"error": "unknown game"})
                if parts[2] == "rom":
                    data, _ = read_rom_file(g.path)
                    return self.send(200, data, "application/octet-stream") if data else self.send(500, {"error": "cannot read ROM"})
                if parts[2] == "save":
                    try:
                        return self.send(200, g.save_path.read_bytes(), "application/octet-stream")
                    except OSError:
                        return self.send(404, {"error": "no save on the PC yet"})
                if parts[2] == "history":
                    if len(parts) == 3:
                        return self.send(200, lib.history(g.id))
                    f = (lib.history_dir / g.id / parts[3]).resolve()
                    if f.parent == (lib.history_dir / g.id).resolve() and f.is_file():
                        return self.send(200, f.read_bytes(), "application/octet-stream",
                                         {"Content-Disposition": f'attachment; filename="{g.stem}-{f.name}"'})
                    return self.send(404, {"error": "no such snapshot"})
            if parts == ["bios"]:
                data = read_bios_file(lib.bios_path) if lib.bios_path else None
                return self.send(200, data, "application/octet-stream") if data else self.send(404, {"error": "no BIOS found on the PC"})
            if parts == ["events"]:
                return self.events()
            return self.send(404, {"error": "unknown endpoint"})

        def events(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "keep-alive")
            self.end_headers()
            qq = queue.Queue(maxsize=50)
            lib.listeners.add(qq)
            try:
                self.wfile.write(b": hello\n\n")
                self.wfile.flush()
                while True:
                    try:
                        ev, data = qq.get(timeout=20)
                        self.wfile.write(f"event: {ev}\ndata: {json.dumps(data)}\n\n".encode())
                    except queue.Empty:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass
            finally:
                lib.listeners.discard(qq)
                self.close_connection = True

        def do_PUT(self):
            path, q = self.route()
            if not self.authed(q):
                return self.send(401, {"error": "token required"})
            parts = [p for p in path.split("/") if p][1:]
            if len(parts) == 3 and parts[0] == "games" and parts[2] == "save":
                n = int(self.headers.get("Content-Length") or 0)
                if n != EEP_SIZE:
                    return self.send(400, {"error": "expected an 8 KiB save (EEPROM image)"})
                data = self.rfile.read(n)
                code, body = lib.write_save(parts[1], data, self.headers.get("X-Base-Sha1", ""), force=q.get("force") == ["1"])
                if code == 200:
                    lib.notify("games", {"changed": [parts[1]]})
                    body["emulatorRunning"] = emulator_running()
                return self.send(code, body)
            return self.send(404, {"error": "unknown endpoint"})

    return Handler


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main():
    here = Path(__file__).resolve().parent
    project = here.parent
    ap = argparse.ArgumentParser(description="Serve Web Pokémon mini to your phone and sync game saves with this PC.")
    ap.add_argument("--port", type=int, default=8766)
    ap.add_argument("--host", default="0.0.0.0", help="address to listen on (default: all interfaces)")
    ap.add_argument("--roms", action="append", default=[], help="folder with ROMs (.min / .zip) and the BIOS; repeatable, searched 3 levels deep")
    ap.add_argument("--data-dir", default=str(DEFAULT_DATA), help="where saves, history and extra ROMs live")
    ap.add_argument("--web-dir", default=str(project / "web" if (project / "web").is_dir() else here / "web"))
    ap.add_argument("--token", default=os.environ.get("MINISYNC_TOKEN", ""), help="require this access token (recommended outside your home network)")
    ap.add_argument("--interval", type=float, default=2.0, help="seconds between folder scans")
    ap.add_argument("--verbose", action="store_true")
    cfg = ap.parse_args()
    cfg.web_dir = Path(cfg.web_dir)
    data_dir = Path(cfg.data_dir)
    (data_dir / "roms").mkdir(parents=True, exist_ok=True)

    folders = [Path(r).expanduser() for r in cfg.roms]
    if not folders and project.parent != HOME and project.parent.is_dir():
        # running from the project folder: also look next to it (e.g. "WEB POKEMINI/legally extracted roms")
        folders.append(project.parent)
    folders.append(data_dir / "roms")
    if not (cfg.web_dir / "index.html").is_file():
        sys.exit(f"web app not found in {cfg.web_dir} (use --web-dir)")

    lib = Library(folders, data_dir)
    lib.scan()
    threading.Thread(target=lib.watch_forever, args=(cfg.interval,), daemon=True).start()

    try:
        httpd = Server((cfg.host, cfg.port), make_handler(cfg, lib))
    except OSError as e:
        sys.exit(f"cannot listen on port {cfg.port}: {e} (is MiniSync already running? try --port)")
    print(f"\nMiniSync {VERSION}: ROM folders")
    for f in folders:
        print(f"   {'✓' if f.is_dir() else '✗'} {f}")
    print(f"\n{len(lib.games)} game(s) found.  BIOS: {lib.bios_path or 'not found (load it on the phone instead)'}")
    for g in sorted(lib.games.values(), key=lambda g: g.path.name.lower()):
        print(f"   {g.path.name}  →  save: {g.save_path}{'' if g.save_sha1 else ' (none yet)'}")
    print("\nOpen one of these on your phone (same Wi-Fi, or Tailscale):")
    tok = f"/?token={urllib.parse.quote(cfg.token)}" if cfg.token else ""
    for a in local_addresses():
        print(f"   http://{a}:{cfg.port}{tok}")
    print(f"   http://localhost:{cfg.port}{tok}  (this PC)")
    if not cfg.token:
        print("\nTip: add --token SOMESECRET if this PC is on a network you don't trust.")
    print("Press Ctrl+C to stop.\n", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("bye")


if __name__ == "__main__":
    main()
