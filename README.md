# Survey Anything

**Point it at any browser tab or camera, say what to watch for, and get a Telegram and email alert when
it happens. Nothing acts without your tap.**

A Chrome extension that watches a tab or a camera, runs a free detector on your own computer, asks an AI
model of your choice to confirm only the candidates, and alerts people on Telegram and email. With an
optional self-hosted backend it adds private live view and device actions that run only after a person
taps Approve.

- **Gate, then confirm.** A detector runs on every frame for free; a model is called only on candidates.
- **Any model,** including fully local ones (Ollama, LM Studio, vLLM, llama.cpp), with no code changes.
- **Provable human control.** A sign in front of the camera can make the system ask, not act. The
  adversarial test results are in `docs/BENCHMARKS.md`.
- **Anything is a sensor.** A vendor's camera portal, a Grafana board, a 3D printer feed, a shop queue:
  if it is in a tab, it can be watched. Rules are shareable JSON recipes.

## Try it in about five minutes

No server, no camera, no AI account needed. This sets up the extension-only mode (T0) with Telegram and
plays a synthetic fire in a local page.

You need Node.js 24 or later, Git, Chrome or Chromium 120 or later, and a Telegram account.

1. **Build the extension.**

   ```bash
   git clone https://github.com/PacifAIst/survany && cd survany
   corepack enable
   pnpm install
   pnpm build
   ```

   `pnpm install` downloads the fire/smoke model from this repository's GitHub release and refuses it
   unless its SHA-256 matches the pin; `pnpm build` fetches and checks the other bundled files the same way.
   (If `corepack enable` needs administrator rights on your system, use `npx pnpm@10.33.2` in place of `pnpm`.)

2. **Load it.** Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and choose
   `apps/extension/dist`. A consent page opens: read it, tick the boxes, press **I agree**.

3. **Make a Telegram bot.** In Telegram, message **@BotFather**, send `/newbot`, and copy the token. Send any
   message to your new bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and copy
   the number after `"chat":{"id":`.

4. **Configure.** Right-click the extension's icon → **Options**:
   - Under **Extension-only mode**, tick **Direct Telegram**, paste the token into **Bot token**, press
     **Store** (Chrome asks to allow `api.telegram.org`: allow it), and enter the number as **Chat ID for owner**.
   - Under **Alert channels**, untick **Email** and confirm **I understand, use one channel**.
   - Under **Vision and token savers**, untick **Confirm candidates with AI** for now (zero cost; alerts
     are labelled *unconfirmed*). To add a model later, see `docs/PROVIDERS.md`.
   - Keep the **Fire or smoke** watch rule ticked and press **Save**.

5. **Watch the demo.** Run `pnpm demo` and open `http://localhost:8099`. Click the extension's icon, choose
   **Watch this tab**, then press **Start incident in 10 s** on the page. Within about 20 seconds your bot
   sends the alert.

This path is tested end to end on every change (`apps/extension/e2e/quickstart.spec.ts`), with Chromium's
fake camera playing the same fire scene, because automation cannot click the toolbar button.

## What it costs

| Setup | Per confirmation | Measured |
|---|---|---|
| No AI model (detector only) | nothing | alerts are labelled *unconfirmed* |
| Local model: Ollama with `qwen2.5vl:7b` | nothing per call; about 6 s per call on a 6 GB laptop GPU | yes, `docs/BENCHMARKS.md` |
| Cloud models (Anthropic, OpenAI, OpenRouter, DeepSeek) | tokens per call × the provider's price | not yet: run `pnpm bench:providers` with your key |

A model is called once per event, not per frame, and cloud calls are capped (by default 6 a minute and 500
a day). When a cap is reached, the detector keeps running and alerts go out labelled unconfirmed.

## Tiers

| Tier | You run | You get |
|---|---|---|
| **T0** | The extension, a Telegram bot token and/or a Resend key | Detection, confirmation, Telegram and email alerts straight from the browser |
| **T1** | `docker compose up -d` (backend + Caddy) on a host with a domain | Acknowledge, escalation, contact routing, SMTP email, a durable outbox, clips, proxy mode for API keys, a dead-man alert if the browser dies |
| **T2** | `docker compose --profile ome up -d` with public ports | Private live view for the alerted contacts (OvenMediaEngine) |
| **T3** | `--profile gate` plus an MCP server such as ha-mcp | Device actions that run only after a person taps Approve |

Without a mail key, Telegram alone is a valid setup: you confirm once that alerts are not redundant, and
the extension does not nag you about it afterwards.

## Set up a model

Any provider is configured in Options and must pass a probe before it is saved: it is shown a random
code in an image and must read it back, so a model that cannot see is refused.

- **Local (Ollama):** `ollama pull qwen2.5vl:7b`, base URL `http://127.0.0.1:11434/v1`. Ollama blocks
  browser extensions until you allow them with `OLLAMA_ORIGINS`; Test Connection shows the exact command
  for your system.
- **vLLM, LM Studio, llama.cpp:** any OpenAI-compatible `…/v1` endpoint with a vision model; allow the
  extension's origin in the server's CORS settings. A local base URL without a path (LM Studio shows
  `http://127.0.0.1:1234`) is used under `/v1`, and the local card has one-click buttons for LM Studio and
  Ollama. Use the model id exactly as the server lists it; when the probe fails, Test Connection lists the
  ids the server serves. Tested with LM Studio and `qwen3-vl-4b-instruct`.
- **Cloud:** paste a key (it is stored when you leave the field), or keep keys on your backend with proxy
  mode.

Details, licenses of local models, failover and budget: `docs/PROVIDERS.md`.

## Live view (OvenMediaEngine)

Needs a host with a public IP and two DNS names. Open 80/443, 3478/tcp, 10000/tcp and 10000-10003/udp;
set `OME_HOST_IP` to the public address (OME advertises it as its ICE candidate); Caddy gets TLS
certificates from Let's Encrypt. Then check the deployment from another network:

```bash
pnpm doctor --public alerts.example.org --live live.example.org --ip 203.0.113.7
```

Step by step: `docs/DEPLOY_OME.md`.

## Device actions (MCP)

The chain is backend → confirm-gate-mcp → your MCP server (for Home Assistant, ha-mcp). Pair the backend as
the gate's device, write a policy that lists the tools and entities allowed, and turn on actions in
Options. A model only suggests; the backend renders the card; you tap Approve or Deny on Telegram. See
`docs/MCP_PAIRING.md`.

## The security model, in plain words

- **Models and pictures are not trusted.** Text in the image (a sign, a screen, a note) is treated as part
  of the scene, never as an instruction. A model's answer is checked against a strict format; if it is
  garbage, the next model is tried, and if all fail you still get an alert, labelled unconfirmed.
- **Nothing acts without you.** Device actions need your tap on Telegram, in a private chat, as an
  approver. No answer in time means no. Email can never approve. Locks, unlocking and alarm disarming are
  refused unless you list the exact device, and calling emergency services can never be enabled.
- **You decide what leaves your computer.** With cloud models off, frames go only to local or
  private-network hosts. Snapshots and clips leave only if you allow alert media; live video only if you
  allow live view.
- **Links are personal and short-lived.** Each contact gets their own single-use link, valid for at most
  10 minutes; email links also need the contact's PIN.
- **It cannot watch secretly.** The badge shows when it is watching, and a banner shows when it streams
  and to whom; no setting hides them.
- **Telegram and email are not end-to-end encrypted** for these messages. Turn alert media off for
  text-only alerts.

The full analysis, including what this design does not protect against: `docs/THREAT_MODEL.md`. Report
vulnerabilities privately: `SECURITY.md`.

## Recipes

A rule is a small JSON recipe: what triggers the on-device gate (a detector class, motion, a change in a
region, or a timer) and the question the model is asked. Built in: Fire or smoke, Robbery or break-in,
Anything unusual, Package left at the door, 3D print failure, Dashboard turns red, Queue too long, Water
leak, Door left open, Person in restricted zone. In Options → Watch rules, click a rule's name to see its
JSON, copy it in one click, or use it as a template; add your own by typing or pasting into the editor or by
importing a file (a field guide is under the editor). Added recipes cannot change who is alerted, what
leaves your computer, or which actions exist. When a rule watches only a region, the image the model sees
has that region outlined with a black-and-white dashed rectangle, and the question says so. New recipes are
welcome as pull requests (`.github/PULL_REQUEST_TEMPLATE/recipe.md`).

## Responsible use

Watch your own spaces and screens. Tell the people who live or work there, and do not point it at public
space. It does no face recognition, no emotion inference, no audio, no hidden mode, and never contacts
emergency services on its own. It is not a certified safety device: keep your smoke alarms. Read
`docs/RESPONSIBLE_USE.md` and `docs/PRIVACY_POLICY.md`.

## More

- How it fits together: `docs/ARCHITECTURE.md`. What is measured: `docs/BENCHMARKS.md`.
- Where the project stands: `docs/PROGRESS.md`. The specification: `docs/PLAN.md`.
- Contributing (a CLA is required before the first merge): `CONTRIBUTING.md`.

## License and source

Copyright (C) 2026 PacifAIst

Survey Anything is licensed under the **GNU Affero General Public License v3.0 only** (`LICENSE`, the verbatim
license text). Every source file carries the copyright line and `SPDX-License-Identifier: AGPL-3.0-only`. If you run
a modified backend or viewer for others, you must offer them its source; the viewer and backend link to
the corresponding source. Third-party components and their licenses: `THIRD_PARTY_LICENSES.md`.
