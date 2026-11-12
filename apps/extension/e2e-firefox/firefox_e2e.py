# Copyright (C) 2026 PacifAIst
# SPDX-License-Identifier: AGPL-3.0-only
"""Firefox end-to-end check of the Firefox build, in a real Firefox (140 or later).

Installs the add-on (a dist-firefox folder or the release zip) as a temporary add-on and walks the real
pages with Firefox's fake camera: consent, camera permission, Options (LM Studio button, Test connection,
the "Person left the camera view" rule, Telegram, Save), Watch camera from the popup, the pinned monitor
tab, a local AI check of the empty scene, the alert, Disarm, closing the monitor tab, and window/screen
sharing. Needs LM Studio serving a vision model at http://127.0.0.1:1234. Telegram gets a placeholder
token, so the send is refused; the test checks that the alert was produced and the send attempted.

    python -m pip install selenium==4.38.0
    python apps/extension/e2e-firefox/firefox_e2e.py --firefox <path to firefox.exe> --extension release/survey-anything-firefox-0.1.1.zip

Selenium downloads geckodriver itself. Measured 2026-11-12 on Firefox 160: 20/20 (docs/release/FIREFOX.md).
"""
import argparse
import json
import os
import time

from selenium import webdriver
from selenium.common.exceptions import TimeoutException
from selenium.webdriver.common.by import By
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.support.ui import WebDriverWait

ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
ap.add_argument('--firefox', required=True, help='path to firefox.exe (or firefox)')
ap.add_argument('--extension', required=True, help='dist-firefox folder or the release zip')
ap.add_argument('--screenshots', default=None, help='folder for screenshots (optional)')
ap.add_argument('--headed', action='store_true', help='show the browser window')
args = ap.parse_args()
EXT = args.extension
SHOTS = args.screenshots
UUID = '5e5e5e5e-0000-4000-8000-000000000001'
BASE = f'moz-extension://{UUID}/'
results = []
NL = chr(10)


def check(name, ok, detail=''):
    results.append((name, ok, detail))
    print(('PASS ' if ok else 'FAIL ') + name + (f' :: {detail}' if detail else ''), flush=True)


opts = Options()
opts.binary_location = args.firefox
if not args.headed:
    opts.add_argument('-headless')
opts.set_preference('media.navigator.streams.fake', True)
opts.set_preference('media.navigator.permission.disabled', True)
opts.set_preference('extensions.webextensions.uuids', json.dumps({'survany@pacifaist': UUID}))
# Release build: optional host permissions are asked at runtime; this grants them as a click on "Allow" would.
opts.set_preference('extensions.webextOptionalPermissionPrompts', False)
# Extension pages are privileged contexts for WebDriver; geckodriver must be told to allow them.
driver = webdriver.Firefox(options=opts, service=Service(service_args=['--allow-system-access']))
driver.set_window_size(1100, 1400)
wait = WebDriverWait(driver, 30)


def js(code):
    """Runs async code in the current extension page with its chrome.* API; returns the value."""
    r = driver.execute_async_script(
        'const done = arguments[arguments.length - 1];'
        'const w = window.wrappedJSObject || window; const chrome = w.chrome;'
        f'(async () => {{ {code} }})().then(v => done({{ok: true, v: JSON.stringify(v === undefined ? null : v)}}), e => done({{ok: false, e: String(e)}}));'
    )
    if not r['ok']:
        raise RuntimeError(r['e'])
    return json.loads(r['v'])


def sw(msg):
    return js(f"const r = await chrome.runtime.sendMessage(Object.assign({{target: 'sw'}}, {json.dumps(msg)})); return r;")


def goto(path):
    """Same-origin navigation from inside an extension page (WebDriver may not navigate to moz-extension: itself)."""
    driver.execute_script('window.location.assign(arguments[0])', BASE + path)
    WebDriverWait(driver, 30).until(lambda d: d.current_url.startswith(BASE + path) and d.execute_script('return document.readyState') == 'complete')
    time.sleep(0.5)


def open_tab(path):
    """Opens an extension page in a new tab through the extension itself and switches to it."""
    before = set(driver.window_handles)
    js(f"await chrome.tabs.create({{url: chrome.runtime.getURL('{path}')}})")
    WebDriverWait(driver, 20).until(lambda d: len(set(d.window_handles) - before) >= 1)
    driver.switch_to.window(list(set(driver.window_handles) - before)[0])
    WebDriverWait(driver, 30).until(lambda d: d.execute_script('return document.readyState') == 'complete')
    time.sleep(0.5)


def safe_click(el):
    driver.execute_script("arguments[0].scrollIntoView({block: 'center'})", el)
    time.sleep(0.1)
    el.click()


def testid_text(tid):
    els = driver.find_elements(By.CSS_SELECTOR, f'[data-testid="{tid}"]')
    return els[0].text if els and els[0].text else ''


def click_text(tag, text, timeout=30):
    el = WebDriverWait(driver, timeout).until(lambda d: next((e for e in d.find_elements(By.TAG_NAME, tag) if e.text.strip().startswith(text) and e.is_displayed()), None))
    safe_click(el)
    return el


try:
    first = set(driver.window_handles)
    driver.install_addon(EXT, temporary=True)
    WebDriverWait(driver, 20).until(lambda d: len(set(d.window_handles) - first) >= 1)
    check('add-on installs in Firefox and opens its consent page', True)

    # 1. Consent page (opened by onInstalled) and camera permission page, through their own UI.
    driver.switch_to.window(list(set(driver.window_handles) - first)[0])
    WebDriverWait(driver, 30).until(lambda d: d.current_url.startswith(BASE))
    wait.until(lambda d: d.find_elements(By.CSS_SELECTOR, 'input[type=checkbox]'))
    for cb in driver.find_elements(By.CSS_SELECTOR, 'input[type=checkbox]'):
        if not cb.is_selected():
            safe_click(cb)
    click_text('button', 'I agree')
    time.sleep(1)
    check('consent accepted', js("return (await chrome.storage.local.get('consentAt')).consentAt") is not None)
    goto('src/onboarding/grant-camera/index.html')
    click_text('button', 'Allow camera')
    WebDriverWait(driver, 20).until(lambda d: js("return (await chrome.storage.local.get('cameraGranted')).cameraGranted") is True)
    check('camera permission granted (fake camera)', True)

    # 2. Options: LM Studio, test, rule, Telegram, save.
    goto('src/options/index.html')
    wait.until(lambda d: 'Survey Anything settings' in d.page_source)
    click_text('button', 'LM Studio (127.0.0.1:1234)')
    det = WebDriverWait(driver, 30).until(lambda d: testid_text('detect-local') or False)
    check('LM Studio button finds the vision model', 'Model set to qwen3-vl-4b-instruct' in det, det[:120])
    safe_click(driver.find_element(By.CSS_SELECTOR, 'button[aria-label="Test connection: local"]'))
    probe = WebDriverWait(driver, 90).until(lambda d: (lambda e: e[0].text if e and ('Vision OK' in e[0].text or 'Failed' in e[0].text) else False)(d.find_elements(By.CSS_SELECTOR, '[data-testid=probe-local]')))
    check('Test connection: vision probe passes in Firefox', 'Vision OK' in probe, probe[:140])
    for title, want in [('Fire or smoke', False), ('Robbery or break-in', False), ('Anything unusual', False), ('Person left the camera view', True)]:
        cb = driver.find_element(By.CSS_SELECTOR, f'input[type=checkbox][aria-label="{title}"]')
        if cb.is_selected() != want:
            safe_click(cb)
    # One channel: Telegram. Unticking Email asks for the one-time acknowledgement.
    email = next(e for e in driver.find_elements(By.XPATH, "//label[normalize-space()='Email']/input"))
    safe_click(email)
    click_text('button', 'I understand, use one channel')
    tg = driver.find_element(By.XPATH, "//label[contains(normalize-space(),'Direct Telegram')]/input")
    if not tg.is_selected():
        safe_click(tg)
    token = WebDriverWait(driver, 10).until(lambda d: d.find_element(By.CSS_SELECTOR, 'input[aria-label^="Bot token"]'))
    token.send_keys('PLACEHOLDER_NOT_A_TOKEN')
    click_text('button', 'Store')
    chat = driver.find_element(By.XPATH, "//label[contains(normalize-space(),'Chat ID for owner')]/input")
    chat.send_keys('123456789')
    if SHOTS:
        driver.save_screenshot(os.path.join(SHOTS, 'ff-options.png'))
    click_text('button', 'Save')
    saved = WebDriverWait(driver, 90).until(lambda d: (lambda e: e[0].text if e else False)(d.find_elements(By.CSS_SELECTOR, '[data-testid=saved]')) or (lambda e: 'ERR:' + e[0].text if e else False)(d.find_elements(By.CSS_SELECTOR, '[data-testid=errors]')))
    check('Save works (probe again, permissions asked in one go)', saved.startswith('Saved at'), saved[:200])
    secrets = js("return Object.keys((await chrome.storage.local.get('secrets')).secrets || {})")
    check('bot token stored', 'key_telegram_bot' in secrets, str(secrets))

    # 3. Watch camera from the popup (opened as a page).
    options_handle = driver.current_window_handle
    open_tab('src/popup/index.html')
    labels = [b.text for b in WebDriverWait(driver, 20).until(lambda d: d.find_elements(By.TAG_NAME, 'button'))]
    check('popup offers "Watch a window or screen", not tab capture', 'Watch a window or screen' in labels and 'Watch this tab' not in labels, str(labels))
    popup_handle = driver.current_window_handle
    before = set(driver.window_handles)
    click_text('button', 'Watch camera')
    WebDriverWait(driver, 30).until(lambda d: len(set(d.window_handles) - before) >= 1)
    monitor = list(set(driver.window_handles) - before)[0]
    t0 = time.time()
    driver.switch_to.window(monitor)
    WebDriverWait(driver, 30).until(lambda d: 'Watching' in d.title)
    state = driver.find_element(By.ID, 'state').text
    check('monitor tab opens, pinned, and says it is watching', 'Watching: Camera' in state, f'title={driver.title!r} state={state!r}')
    pinned = js("const t = await chrome.tabs.getCurrent(); return t ? t.pinned : null")
    check('monitor tab is pinned', pinned is True, str(pinned))
    if SHOTS:
        driver.save_screenshot(os.path.join(SHOTS, 'ff-monitor-tab.png'))

    # 4. The camera shows nobody: the rule fires, the local model is asked, an alert is produced.
    driver.switch_to.window(options_handle)
    log = ''
    answered_at = None
    for _ in range(60):
        log = NL.join(sw({'type': 'debug-stats'})['value']['log'][-20:])
        if 'confirm person-left:' in log:
            answered_at = round(time.time() - t0)
            break
        time.sleep(2)
    event = None
    for _ in range(20):  # the alert event is recorded right after the answer
        event = js("const r = ((await chrome.storage.local.get('rules')).rules || {})['person-left']; return r ? r.lastEventId : null")
        if event:
            break
        time.sleep(1)
    time.sleep(3)
    badge = js("return await chrome.action.getBadgeText({})")
    time.sleep(6)
    status = sw({'type': 'get-status'})['value']
    dbg = sw({'type': 'debug-stats'})['value']
    log = NL.join(dbg['log'][-14:])
    check('scanning runs in Firefox (detector on, steady 5 s ticks)', dbg['stats']['detector'] in ('wasm', 'webgpu') and dbg['stats']['ticks'] >= 3 and dbg['stats']['maxConsecutiveMissed'] <= 1, json.dumps(dbg['stats'])[:300])
    check('local AI asked about the empty scene', status['budget']['localDayCalls'] >= 1, f"localDayCalls={status['budget']['localDayCalls']}")
    check(f'model answered: nobody visible ({answered_at} s after watching started)', 'confirm person-left: local answered none' in log, log[-500:])
    check('alert event produced', bool(event), f'event={event}')
    check('Telegram send attempted and refused for the placeholder token (logged, red badge)', 'telegram alert not sent' in log and badge == '!', f'badge={badge!r}')
    print('LOG TAIL' + NL + log, flush=True)

    # 5. Disarm closes the monitor tab.
    sw({'type': 'disarm'})
    WebDriverWait(driver, 20).until(lambda d: monitor not in d.window_handles)
    check('Disarm closes the monitor tab', True)

    # 6. Closing the monitor tab stops watching, with a notice.
    driver.switch_to.window(popup_handle)
    driver.refresh()
    before = set(driver.window_handles)
    click_text('button', 'Watch camera')
    WebDriverWait(driver, 30).until(lambda d: len(set(d.window_handles) - before) >= 1)
    monitor = list(set(driver.window_handles) - before)[0]
    driver.switch_to.window(monitor)
    WebDriverWait(driver, 30).until(lambda d: 'Watching' in d.title)
    driver.close()
    driver.switch_to.window(options_handle)
    armed = True
    for _ in range(15):
        st = sw({'type': 'get-status'})['value']
        armed = st['armed']
        if not armed:
            break
        time.sleep(1)
    notices = sw({'type': 'get-status'})['value']['notices']
    check('closing the monitor tab stops watching', armed is False)
    check('...and says why', any('tab was closed' in n for n in notices), str(notices[-2:]))

    # 7. Window or screen: the button appears; a click opens Firefox's sharing (auto-allowed in this test profile).
    driver.switch_to.window(popup_handle)
    driver.refresh()
    before = set(driver.window_handles)
    click_text('button', 'Watch a window or screen')
    WebDriverWait(driver, 30).until(lambda d: len(set(d.window_handles) - before) >= 1)
    monitor = list(set(driver.window_handles) - before)[0]
    driver.switch_to.window(monitor)
    pick = WebDriverWait(driver, 20).until(lambda d: (lambda b: b if b.is_displayed() else False)(d.find_element(By.ID, 'pick')))
    check('monitor tab shows "Choose a window or screen to watch"', pick.text.startswith('Choose a window or screen'))
    if SHOTS:
        driver.save_screenshot(os.path.join(SHOTS, 'ff-monitor-pick.png'))
    safe_click(pick)
    try:
        WebDriverWait(driver, 20).until(lambda d: 'Watching' in d.title)
        check('window or screen sharing starts after the click', True, driver.find_element(By.ID, 'state').text)
    except TimeoutException:
        driver.switch_to.window(options_handle)
        check('window or screen sharing starts after the click', False, '\n'.join(sw({'type': 'debug-stats'})['value']['log'][-6:]))
    driver.switch_to.window(options_handle)
    sw({'type': 'disarm'})
finally:
    failed = [r for r in results if not r[1]]
    print(f'SUMMARY {len(results) - len(failed)}/{len(results)} passed', flush=True)
    driver.quit()
