# End-to-end test in a phone-sized Chromium against a running MiniSync (default http://localhost:8766).
#   python3 tests/e2e.py [base-url] [screenshot-dir]
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright
BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:8766'
OUT = (sys.argv[2] if len(sys.argv) > 2 else 'shots').rstrip('/') + '/'
import os; os.makedirs(OUT, exist_ok=True)

def api(path):
    return json.load(urllib.request.urlopen(BASE + path))

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(**p.devices['Pixel 7'])
    pg = ctx.new_page()
    logs = []
    pg.on('console', lambda m: logs.append(f'{m.type}: {m.text}'))
    pg.on('pageerror', lambda e: logs.append(f'PAGEERROR: {e}'))
    pg.goto(BASE + '/')
    pg.wait_for_selector('.game', timeout=10000)
    time.sleep(0.5)
    assert pg.locator('#bios-banner').is_hidden(), 'BIOS should come from the PC'
    names = pg.locator('.game .name').all_inner_texts()
    print('games:', names)
    pg.screenshot(path=OUT + '1-library.png', full_page=True)

    def tap(sel, hold=0.12):
        box = pg.locator(sel).bounding_box()
        x, y = box['x'] + box['width'] / 2, box['y'] + box['height'] / 2
        pg.mouse.move(x, y); pg.mouse.down(); time.sleep(hold); pg.mouse.up(); time.sleep(0.35)

    # --- Pinball
    pg.locator('.game', has_text='Pinball').locator('.thumb').click()
    pg.wait_for_selector('#player.active')
    time.sleep(4.5)
    pg.screenshot(path=OUT + '2-pinball-title.png')
    tap('.pbtn.a'); time.sleep(1.5); tap('.pbtn.a'); time.sleep(2)
    pg.screenshot(path=OUT + '3-pinball-play.png')
    st = pg.evaluate('() => { const pm = window.__wpm.player.pm; return { t: pm.time.toFixed(1), frames: pm.frames, pc: pm.cpu.pc.toString(16) } }')
    print('pinball emu state:', st)
    # raw emulation speed, with the CPU throttled 4x to approximate a mid-range phone
    cdp = ctx.new_cdp_session(pg)
    cdp.send('Emulation.setCPUThrottlingRate', {'rate': 4})
    speed = pg.evaluate('() => { const pm = window.__wpm.player.pm; const out = pm.audioOut; const t0 = performance.now(); pm.runFor(5); pm.audioOut = out; return 5000 / (performance.now() - t0); }')
    cdp.send('Emulation.setCPUThrottlingRate', {'rate': 1})
    print(f'emulation speed with 4x CPU throttle: {speed:.1f}x realtime (with sound)')
    # save states sheet
    pg.click('#btn-pmenu'); pg.click('text=Save states…')
    pg.locator('.slot[data-n="1"] [data-act="save"]').click(); time.sleep(0.5)
    pg.click('#btn-pmenu'); pg.click('text=Save states…')
    pg.screenshot(path=OUT + '4-slots.png')
    pg.locator('.slot[data-n="1"] [data-act="load"]').click(); time.sleep(0.5)
    # landscape
    pg.set_viewport_size({'width': 915, 'height': 412}); time.sleep(0.8)
    pg.screenshot(path=OUT + '5-landscape.png')
    pg.set_viewport_size({'width': 412, 'height': 915}); time.sleep(0.4)
    pg.click('#btn-back'); pg.wait_for_selector('#library.active'); time.sleep(1)

    # --- Party Mini: plays long enough to write its save, which goes to the PC on leaving
    pg.locator('.game', has_text='Party').locator('.thumb').click()
    pg.wait_for_selector('#player.active')
    time.sleep(4)
    for _ in range(3): tap('.pbtn.a'); time.sleep(1)
    pg.screenshot(path=OUT + '6-party.png')
    dirty = pg.evaluate('() => window.__wpm.player.save && window.__wpm.player.save.dirty')
    print('party save dirty on phone:', dirty)
    pg.click('#btn-back'); pg.wait_for_selector('#library.active'); time.sleep(2)
    g = [x for x in api('/api/games')['games'] if 'Party' in x['file']][0]
    print('PC save after leaving Party Mini:', g['save'])
    pg.screenshot(path=OUT + '7-library-after.png', full_page=True)
    print('\n'.join(l for l in logs if 'error' in l.lower() or 'PAGEERROR' in l) or 'no console errors')
    b.close()
