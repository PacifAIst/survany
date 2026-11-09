# Architecture

Survey Anything is a Chrome extension (Manifest V3) plus an optional backend you run yourself. The
extension does all the watching. The backend adds what a browser cannot do alone: email over SMTP,
acknowledgements and escalation, contact routing, a dead-man alert, private live view, and human-approved
device actions. `docs/PLAN.md` is the full specification; this page is the map.

## The pipeline

```text
camera or tab ──> offscreen document ──> Worker scan loop ──> service worker ──> alert channels
                  (MediaStream,          (motion filter,      (N-of-M, rising     (Telegram, email,
                   clip recorders,        detector gate,       edge, cooldown,     browser notification)
                   WHIP publisher)        region diff)         model confirm,          │
                                                               budget, egress)         └─> backend (T1+)
```

1. **Scan.** A timer in a dedicated Worker grabs a frame every `scanIntervalMs` (default 5 s). The
   rule's gate runs on the device: a bundled ONNX detector (YOLOX-tiny for people and objects, a
   fire/smoke model trained in this repository), a motion filter, a region diff, or a timer. Below the
   threshold the frame is dropped. Nothing leaves the machine at this stage.
2. **Confirm.** A candidate must hit in N of the last M frames (default 2 of 3), be a rising edge, and be
   out of cooldown. Then the service worker sends one downscaled frame to the configured vision model,
   through the failover chain, under the budget. The answer is parsed defensively; a model that fails or
   talks nonsense leads to an alert labelled "unconfirmed", never to silence.
3. **Alert.** Every configured channel starts at the same moment: Telegram and/or email, plus a browser
   notification. Without a backend (T0) the extension sends directly; with one (T1+) it posts the event
   and the backend fans out with a durable outbox.
4. **Live view (T2).** The extension publishes over WHIP to OvenMediaEngine. Each alerted contact gets
   their own single-use, 10-minute link. A visible "streaming" indicator is always on.
5. **Action (T3).** For a model-confirmed event the Reasoner may suggest one device action. The backend
   checks it against the policy, asks confirm-gate-mcp to hold it, and sends an approval card to
   Telegram. Only a person's tap releases it.

## Runtime contexts

| Context | Owns | Why it is separate |
|---|---|---|
| Service worker (`apps/extension/src/sw/`) | Orchestration, provider calls, budget, storage, badge, the network boundary (`guardedFetch`) | Can be killed any time, so it keeps no state in memory; everything is in `chrome.storage` |
| Offscreen document (`src/offscreen/`) | The MediaStream, frame grabbing, clip recorders, WHIP publisher | The only place a MediaStream can live in MV3 |
| Dedicated Worker (`src/worker/`) | The scan timer, motion filter, ONNX inference (WebGPU, then WASM) | Worker timers keep running when the page is hidden (verified by a 30-minute soak) |
| Options, popup, onboarding (`src/options/`, `src/popup/`, `src/onboarding/`) | Settings, Test Connection, consent, camera grant, the Stop button | Only visible pages can request permissions |
| Backend (`apps/backend/`, Fastify + SQLite) | Telegram bot, SMTP, outbox, tokens, OME admission, approvals, audit, watchdog, optional key proxy | Holds the bot token, gate credentials and HMAC keys, never the browser |
| Viewer (`apps/viewer/`) | The Telegram Mini App and email viewer page | Static, served by Caddy, so it still loads when the backend is down |
| OvenMediaEngine | WebRTC ingest and playback, LL-HLS fallback, TCP relay | AGPL-3.0 media server; its REST API is never public |
| Caddy | TLS, `forward_auth` in front of OME signaling | Does not carry media |
| confirm-gate-mcp | Holds proposed actions until signed evidence of a tap arrives | The model never connects to it |

## Repository layout

| Path | What |
|---|---|
| `apps/extension` | The extension (Vite multi-entry build, Preact UI) |
| `apps/backend` | The backend (Fastify, node:sqlite, nodemailer) |
| `apps/viewer` | Mini App and email viewer (OvenPlayer, hls.js) |
| `packages/shared` | Config schema (zod), API schemas, callback codec, sanitizer, defaults |
| `packages/providers` | Model adapters (Anthropic, OpenAI, OpenRouter, DeepSeek, any OpenAI-compatible local server), probe, failover, Reasoner |
| `packages/recipes` | Recipe schema and the built-in watch rules |
| `models/` | Model checksums, the fire/smoke training pipeline and model card |
| `deploy/` | Docker Compose (backend, Caddy, OME, gate), Caddyfile, OME `Server.xml`, gate policy |
| `bench/` | Benchmark harness, red-team set, evidence files; `pnpm bench` writes `docs/BENCHMARKS.md` |
| `demo/` | A local page that plays a synthetic incident |
| `scripts/` | Security-gate, license and alarm checks, secret generation, model fetch |

## Deployment tiers

| Tier | Needs | Adds |
|---|---|---|
| T0 | Chrome, a Telegram bot token and/or a Resend key | Detection, confirmation, direct Telegram and email alerts |
| T1 | `docker compose up` (backend + Caddy) on a host with a domain | Acknowledge, routing, SMTP email, outbox, clips, proxy mode, dead-man alert |
| T2 | T1 plus public UDP/TCP ports | Private live view (OvenMediaEngine) |
| T3 | T2 plus confirm-gate-mcp and an MCP server | Human-approved device actions |

## Where to read more

- Security: `docs/THREAT_MODEL.md`, `SECURITY.md`.
- Models and providers: `docs/PROVIDERS.md`, `models/fire-smoke/MODEL_CARD.md`.
- Live view: `docs/DEPLOY_OME.md`. Actions: `docs/MCP_PAIRING.md`.
- Measured behaviour: `docs/BENCHMARKS.md`. Status of every milestone: `docs/PROGRESS.md`.
