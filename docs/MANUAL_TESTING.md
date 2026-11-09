# Manual testing checklist (0.1.0 preview)

For a person testing the real thing before 1.0.0: a real webcam, a real OpenRouter model, a real Telegram
bot, and, in part B, a real server for live view and an approved action. Tick each box; when something
fails, note the step number and collect what part C asks for.

- **Part A** (about 30 minutes, no server): the extension alone, OpenRouter, Telegram, your webcam.
- **Part B** (about 1–2 hours, needs a VPS): backend, live view on your phone, and an approved device action.
- **Part C**: what to send back.

You need: Chrome or Chromium 120+, Node.js 24+, Git, a Telegram account, a webcam, a **new** OpenRouter API
key (the old one was revoked), and for part B a Linux VPS with Docker, a public IP and two DNS names.

---

## Part A: extension, OpenRouter, Telegram, webcam

### A1. Build and load

- [ ] `git clone https://github.com/PacifAIst/survany && cd survany && corepack enable && pnpm install && pnpm build`
  (`pnpm install` prints `downloaded models/fire-smoke/fire_smoke_yolox_tiny.onnx (sha256 808ce9b61dcc…)`).
- [ ] Open `chrome://extensions`, turn on **Developer mode**, **Load unpacked**, pick `apps/extension/dist`.
  The card shows **Survey Anything 0.1.0** with no errors.
- [ ] A consent page opens by itself. Read it, tick every box, press **I agree**. Expect "Thank you".
- [ ] Press **Allow camera access**, then **Allow camera**, and accept Chrome's prompt. Expect "Camera access granted".

### A2. OpenRouter as the vision model

Open the settings: right-click the extension icon → **Options**.

- [ ] Under **AI providers**, set **Vision provider** to `openrouter`. The card shows base URL
  `https://openrouter.ai/api/v1` and model `qwen/qwen2.5-vl-72b-instruct` (the model benchmarked in
  `docs/BENCHMARKS.md`).
- [ ] In that card, paste your key into **API key** and press **Store**. Chrome asks to allow
  `openrouter.ai`: allow it. Expect "(key_openrouter: set)".
- [ ] Press **Test connection**. Expect "Vision OK: read the code back in N ms" (about 1–3 s). A failure
  shows what the model read; note it.
- [ ] Under **Failover chain**, the list probably still says `local`: press **Remove local from chain**,
  then **Add openrouter to chain**. The list shows only `openrouter`.

### A3. Telegram, straight from the browser

- [ ] In Telegram, message **@BotFather**, `/newbot`, copy the token. Send any message to your new bot. Open
  `https://api.telegram.org/bot<TOKEN>/getUpdates` and copy the number after `"chat":{"id":`.
- [ ] Options → **Extension-only mode (T0)**: tick **Direct Telegram**, paste the token into **Bot token**,
  **Store** (allow `api.telegram.org`), and enter the number in **Chat ID for owner**.
- [ ] **Alert channels**: untick **Email**. A box "Alerts will not be redundant" appears: press
  **I understand, use one channel**. (It should never ask again, even if you tick and untick Email again.)

### A4. A rule your webcam can trigger

The built-in **Person in restricted zone** rule asks the model about "the marked restricted area", but the
image the model receives has no marking on it, so the model may answer "no". This is a **known issue** (to
be fixed after testing). For this test, import a simple rule instead:

- [ ] Save this as `person-visible.watch.json`:

  ```json
  {
    "id": "person-visible",
    "title": "Person in view",
    "gate": { "type": "detector", "model": "yolox-tiny-coco", "classes": ["person"], "minConfidence": 0.6 },
    "confirm": { "prompt": "Is at least one person clearly visible in this image?", "framesPerCheck": 1 },
    "severity": "info"
  }
  ```

- [ ] Options → **Watch rules** → **Import a recipe** → choose the file. "Person in view" appears in the list.
- [ ] Tick **Person in view**, untick **Fire or smoke** and **Anything unusual**.
- [ ] Optional, to see the full path at once: under **Privacy and egress**, leave **Alert media** ticked so the
  Telegram alert includes a snapshot.
- [ ] Press **Save**. Saving runs the probe again. Expect "Saved at …"; any error lists the exact field.

### A5. Point it at your webcam

Do at least one of these. The camera path is the simplest.

- [ ] **The computer's camera:** step out of view. Click the extension icon → **Watch camera**. The badge
  turns on and the popup shows "● Watching Camera" and "Last scan: N s ago" counting up.
- [ ] **A tab that shows a webcam** (your IP camera's web page, a baby monitor's page, or any page playing
  your webcam): open that tab, keep it in front, click the extension icon → **Watch this tab**. Then switch
  to another tab: watching must continue while the tab is hidden.

### A6. Verify the alert

- [ ] Walk into view and stay 10–15 s. Expected: a Telegram message within about **15 s** (2 scans of 5 s
  each, then about 1–3 s for OpenRouter), title "Person in view", confirmed by `openrouter`, with a confidence
  and a short reason (and the snapshot, if Alert media is on). A browser notification appears at the same time.
- [ ] Stay in view for a minute: **no** second alert (one alert per event; cooldown 60 s).
- [ ] Leave, wait 30 s, come back: a new alert.
- [ ] Popup: "AI calls today: N / 500" counts one call per alert, not per frame.
- [ ] Cover the camera with your hand for a minute: expect a "camera offline"-style notice at most once
  an hour, and no alert for the darkness.
- [ ] **Disarm**. The badge clears and no further alerts arrive.

### A7. Things that must not happen (report any)

- [ ] Nothing was captured before you pressed **I agree**.
- [ ] No alert while the scene was empty.
- [ ] Removing the Wi-Fi briefly during an alert: the alert is queued and arrives when the network returns.

---

## Part B: backend, live view, approved actions (VPS)

### B1. Deploy

- [ ] Follow `docs/DEPLOY_OME.md` steps 1–3 on the VPS (`.env`, ports 80/443, 3478/tcp, 10000/tcp,
  10000-10003/udp; `docker compose up -d`, then `docker compose --profile ome up -d`).
- [ ] From your laptop on another network (a phone hotspot is ideal):
  `pnpm doctor --public <PUBLIC_HOST> --live <LIVE_HOST> --ip <OME_HOST_IP>`. Every line must start with `ok`.
- [ ] On the VPS: `docker compose exec backend node dist/cli.js doctor`. Every line must start with `ok`.

### B2. Pair the extension and yourself

- [ ] On the VPS: `docker compose exec backend node dist/cli.js pair-device` and copy the 8-character code.
- [ ] Extension popup → **Pair backend…** → **Backend URL** `https://<PUBLIC_HOST>`, **Pairing code**, **Pair**.
  Expect "Paired as …, Telegram: yes, email: yes/no, live view: yes".
- [ ] Options → **Contacts and routing**: for `owner`, type your email in the email box, press **Invite**.
  It shows a Telegram link and a PIN-setup link.
- [ ] Open the Telegram link on your phone and press **Start**. Open the PIN link and choose a 6–8 digit PIN.
- [ ] Press **Send test alert**: one message on Telegram and one email.
- [ ] Options → **Extension-only mode**: untick **Direct Telegram** (alerts now go through the backend). Turn
  **Email** back on under **Alert channels**. **Save**.

### B3. Alert through the backend, acknowledge, live view

Under **Privacy and egress**, tick **Live view: private stream to alerted contacts**, and **Save**.

- [ ] Arm the webcam again. Within a few seconds a popup notice may say UDP is unavailable from your
  network; that is a warning, not an error. Note whether it appears.
- [ ] Walk into view. Expected, on Telegram and email at the same time: the alert, with **▶️ View Live** and
  **✅ Acknowledge** buttons on Telegram and a view link and acknowledge link in the email. The extension's
  badge and banner say "Streaming to owner".
- [ ] On the phone, tap **▶️ View Live**: the Mini App opens and the live picture plays within about 10 s.
  Note whether this was on Wi-Fi or mobile data.
- [ ] On the laptop, open the email's view link: it asks for your PIN; enter it; the live picture plays.
  The same link opened in a second browser is refused ("another session").
- [ ] A wrong PIN 5 times: the contact is locked for 15 minutes, and after 3 wrong PINs the owner gets a
  warning.
- [ ] Tap **✅ Acknowledge**: no reminder arrives after the acknowledge timeout (default 300 s). In a second
  test, do not acknowledge: a reminder arrives after 300 s.
- [ ] The stream stops by itself within 10 minutes, or when you press **Stop** in the popup.
- [ ] Phone on **mobile data** (Wi-Fi off), open a new alert's **View Live**: it plays. On the VPS, record
  which path it used:

  ```bash
  docker compose exec backend node -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync('/data/survey-anything.db');console.log(db.prepare('SELECT datetime(at/1000,\"unixepoch\") t, side, candidate_type FROM probe_reports ORDER BY at DESC LIMIT 5').all())"
  ```

### B4. Approved device action (MCP)

Easiest without Home Assistant: run the gate against the test double that only logs what it would do.
With Home Assistant, follow `docs/MCP_PAIRING.md` section 3 (ha-mcp) instead.

- [ ] In `deploy/gate/policy.yaml`, replace the wildcards with one real (or test) entity, e.g.
  `allow: ["light.porch"]`, and keep `pendingTtlSeconds: 120`.
- [ ] Test double only: create `deploy/docker-compose.override.yml`:

  ```yaml
  services:
    gate:
      command: ["sh", "-c", "confirm-gate serve --host 0.0.0.0 --port 8800 --db /data/gate.db --token \"$$GATE_AGENT_TOKEN\" --upstream-cmd 'python /test/fake_ha.py'"]
      environment:
        EXECUTIONS_PATH: /data/executions.jsonl
      volumes:
        - ./test/fake_ha.py:/test/fake_ha.py:ro
  ```

- [ ] `docker compose --profile ome --profile gate up -d`, then `docker compose logs gate` for the 6-digit code,
  `docker compose exec backend node dist/cli.js gate-pair <code>`, `docker compose restart backend`.
- [ ] Options → **Reasoner**: tick **Enabled**, **Provider** `openrouter`, **Reasoner model**
  `qwen/qwen2.5-vl-72b-instruct` (any text model works). The page should say "Backend offers: ha_call_service;
  approval window 120 s".
- [ ] Options → **Human-approved actions (MCP)**: tick **Enabled**, set **Approval timeout** to `120` (it must
  match the backend; the page warns if not). Make sure `owner` has the **approver** role. **Save**.
- [ ] Walk into view. After the alert, a second Telegram message "🔐 Approval needed" shows the action, the
  rule, the parameters and a params hash, with **✅ Approve** and **❌ Deny**. The card must not contain any
  text from the model's description.
- [ ] Nothing has run yet. Test double: `docker compose exec gate cat /data/executions.jsonl` is empty or
  unchanged.
- [ ] Tap **✅ Approve**: the card changes to "Approved by owner. Executed." and one line appears in
  `executions.jsonl` (or the light changes in Home Assistant). Tapping again does nothing.
- [ ] Next alert: tap **❌ Deny**: "Denied", nothing runs.
- [ ] Next alert: do nothing for 2 minutes: "No answer in time: denied. Nothing ran."
- [ ] Forward the approval card to someone else or into a group and have them tap: refused, nothing runs.
- [ ] If the Reasoner suggests nothing on a given alert, that is allowed (it may answer "none"); note it.

### B5. Clean up

- [ ] Remove `deploy/docker-compose.override.yml` when you switch to a real Home Assistant.
- [ ] Revoke the test OpenRouter key if it was only for testing.

---

## Part C: what to send back for a failure

For each failure: the step number (e.g. "A6, second box"), what you expected, what happened, the time, and:

- **Extension log:** open the Options page, right-click → **Inspect** → **Console**, run
  `await chrome.runtime.sendMessage({ target: 'sw', type: 'debug-stats' })` and copy the `log` lines (no keys
  or tokens are logged).
- **Popup:** a screenshot, including "Recent notices" if present.
- **Backend (part B):** `docker compose logs --since 30m backend` (and `gate` or `ome` if involved).
- **Telegram:** a screenshot of the message or card.

Please do not paste API keys, bot tokens or `deploy/.env` contents into the report.
