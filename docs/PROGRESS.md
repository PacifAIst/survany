# Survey Anything: Progress

**Goal:** v1.0 as defined at the end of §8 of docs/PLAN.md
**Current milestone:** M5 / M6 (finishing), then M7
**Last updated:** 2026-11-09 10:25

## Milestones
| ID | Status (todo/doing/done) | Acceptance evidence | Notes |
|----|--------------------------|---------------------|-------|
| M0 | done | CI run 42582135895 on `main`: `pnpm install --frozen-lockfile`, `pnpm -r build`, `pnpm lint`, `pnpm typecheck`, `pnpm test` all passed (the extra `pnpm check` step failed only because the empty `apps/extension/src` was not in git; fixed). Locally: `pnpm vitest run` → 202 passed in 13 files; `pnpm check` → 27/27 gates with marker+test, 71 production packages license-clean, 2 alarm periods ≥ 0.5 min. | |
| M1 | done | `SOAK_MINUTES=30 playwright test e2e/soak.spec.ts` → **pass**: 360 ticks in 30 min, 100% within ±1 s of 5 s, max gap 5014 ms, 0 consecutive misses, every page hidden behind another tab (`bench/reports/m1-soak.json`). `playwright test -c e2e/playwright.config.ts` → 5/5: SG-24 consent gate; SW killed via CDP `Target.closeTarget` → new SW instance, loop kept ticking, armed state rehydrated; offscreen document closed → watchdog restored the camera ("camera restored after: offscreen document lost") within 65 s; tab capture cannot start without a gesture (C20). `pnpm check:alarms` → 0 violations. | Soak ran in headless Chromium 156 with a fake camera, not a real hidden tab (tab capture needs a human gesture). See Needs human. |
| M2 | doing | `vitest run --project extension test/yolox.test.ts` → decode + NMS match `models/reference/yolox_reference.py` (pure-Python port of Megvii demo_utils) on every detection within 2 px and 0.02; re-running the bundled model reproduces the fixture (max diff < 1e-3). e2e "M2 / SG-26": with **every http(s) request aborted** and WebGPU disabled, the worker logs `detector yolox-tiny-coco ready on wasm (416x416)`. Interim flame heuristic active for fire (`missingModels: [fire-smoke-yolox-tiny]`). | Remaining: fire/smoke training pipeline script and model card in `models/`. GPU run on Needs human. |
| M3 | doing | `vitest run --project providers` → 31 contract tests against a real mock HTTP server (request shape for all 5 adapters incl. anthropic-version 2026-10-21 with no sampling params, error mapping 429/5xx/401/402/403/timeout/parse, C25 retry, failover order). Text-only mock refused by the PNG read-back probe. Budget ledger survives a simulated SW restart and hard-stops (sw.test.ts). guardedFetch egress decisions unit-tested (SG-14/15). | Remaining: the §9 Playwright network-log assertion for `allowCloudProviders:false`. |
| M4 | done | `vitest run --project backend test/alerts.test.ts` → 15/15 against a fake Telegram Bot API and a real in-process SMTP server: the three configurations (both, Telegram-only, email-only) each yield exactly one message per channel per contact with all sends claimed within 100 ms; one channel down → the other delivers; lone channel down → durable retries; both down → retries, no duplicates, delivered once on recovery; Telegram 429 honours retry_after; 403 and SMTP 5xx permanent; ack stops escalation, escalation re-sends then goes to owner; dead-man after 3 missed heartbeats; SG-17 sanitized on both channels. Real Mailpit delivery exercised in the M5 Docker test. Compose (backend + Caddy) built and run in M5. | |
| M5 | doing | `playwright test -c e2e/ome/ome.config.ts` against `airensoft/ovenmediaengine:v0.21.0@sha256:172da912…` (deploy/test/compose.m5.yml) → 5/5 (`bench/reports/m5-ome.json`): WHIP publish through Caddy forward_auth (201, connected) then view in real Chrome via the emailed link + PIN (WebRTC, 640x480 playing); second session refused; untokened publish → OME 401 / forward_auth 403; REST 8081 closed on the host, 401 in-network without token, 200 with token; TcpRelay 3478 open; webhook **hung** → OME denies after 3.4 s; backend **stopped** → OME denies (401) and forward_auth fails closed (502); `lifetime` cut the publish 64 s into a 1-minute TTL. Backend unit suite (stream.test.ts) 18/18: SG-09/10/11/12, clip fallbacks, PIN lockout and re-pair. | Remaining: §9 UDP-blocked viewer ladder test, `scripts/doctor`, arm-time probe e2e. Human: public VPS, Mini App on real iOS/Android, CGNAT viewer. |
| M6 | doing | `vitest run --project backend test/actions.test.ts` → 11/11: adversarial suite shows **0 unapproved executions** across self-approval, replay (3 concurrent taps + 1), expiry, changed args, wrong Telegram user / non-approver / other chat / group chat, gate down, and injected text in `reason`; SG-06 exact-entity rule; card hash binding; ConfirmGateClient against a fake gate that verifies signatures exactly as confirm-gate-mcp's evidence.py. | Remaining: extension Reasoner → proposal wiring, `MCP_PAIRING.md`, integration against the real confirm-gate-mcp container. |
| M7 | todo | | |
| M8 | todo | | |

## Security gates
| SG | Code marker | Test | Status |
|----|-------------|------|--------|
| SG-01 | apps/backend/src/actions/approvals.ts | apps/backend/test/actions.test.ts | marker+test |
| SG-02 | apps/backend/src/actions/proposer.ts | apps/backend/test/actions.test.ts | marker+test |
| SG-03 | apps/backend/src/actions/render-card.ts | apps/backend/test/actions.test.ts | marker+test |
| SG-04 | apps/backend/src/routes/telegram-webhook.ts | apps/backend/test/actions.test.ts, alerts.test.ts | marker+test |
| SG-05 | apps/backend/src/actions/gate-client.ts | apps/backend/test/actions.test.ts | marker+test |
| SG-06 | apps/backend/src/actions/policy.ts | apps/backend/test/actions.test.ts | marker+test |
| SG-07 | apps/backend/src/routes/telegram-webhook.ts | apps/backend/test/security.test.ts, actions.test.ts | marker+test |
| SG-08 | packages/shared/src/callback.ts | packages/shared/test/security.test.ts | marker+test |
| SG-09 | apps/backend/src/routes/viewer.ts | apps/backend/test/stream.test.ts | marker+test |
| SG-10 | apps/backend/src/stream/tokens.ts | apps/backend/test/stream.test.ts | marker+test |
| SG-11 | apps/backend/src/stream/admission.ts, deploy/Caddyfile, deploy/ome/Server.xml | apps/backend/test/stream.test.ts, apps/extension/e2e/ome/m5.spec.ts (real OME) | marker+test |
| SG-12 | apps/backend/src/routes/viewer.ts, apps/backend/src/alerts/email.ts | apps/backend/test/stream.test.ts | marker+test |
| SG-13 | apps/extension/src/sw/badge.ts, scan-controller.ts | apps/extension/test/sw.test.ts, e2e/m1.spec.ts | marker+test |
| SG-14 | eslint.config.js, apps/extension/src/sw/guarded-fetch.ts | apps/extension/test/sw.test.ts | marker+test |
| SG-15 | apps/extension/src/sw/guarded-fetch.ts, egress-policy.ts | apps/extension/test/sw.test.ts | marker+test |
| SG-16 | apps/backend/src/routes/common.ts | apps/backend/test/security.test.ts | marker+test |
| SG-17 | packages/shared/src/sanitize.ts, apps/backend/src/security/sanitize.ts | packages/shared/test/security.test.ts, apps/backend/test/alerts.test.ts | marker+test |
| SG-18 | packages/recipes/src/schema.ts | packages/recipes/test/recipes.test.ts | marker+test |
| SG-19 | apps/backend/src/security/ssrf.ts | apps/backend/test/security.test.ts | marker+test |
| SG-20 | deploy/ome/Server.xml, deploy/docker-compose.yml | apps/extension/e2e/ome/m5.spec.ts (real OME) | marker+test |
| SG-21 | packages/shared/src/secrets.ts, apps/extension/src/sw/storage.ts | packages/shared/test/security.test.ts | marker+test |
| SG-22 | apps/backend/src/actions/audit.ts, apps/backend/src/watchdog.ts | apps/backend/test/security.test.ts | marker+test |
| SG-23 | apps/extension/src/offscreen/source-tab.ts, source-camera.ts | apps/extension/test/sw.test.ts | marker+test |
| SG-24 | apps/extension/src/onboarding/consent/consent.tsx, scan-controller.ts | apps/extension/e2e/m1.spec.ts | marker+test |
| SG-25 | apps/backend/src/server.ts | apps/backend/test/security.test.ts | marker+test |
| SG-26 | apps/extension/src/worker/detector.ts | apps/extension/test/sw.test.ts, e2e/m1.spec.ts | marker+test |
| SG-27 | packages/shared/src/viewer-meta.ts, apps/viewer/src/meta.ts, deploy/Caddyfile | packages/shared/test/security.test.ts, apps/viewer/test/viewer.test.ts | marker+test |

## Failure matrix
| Row (§10) | Test | Status |
|-----------|------|--------|
| OME stream does not start in 5 s | backend stream.test.ts "stream not live within 5 s" (clip to every recipient on every channel once uploaded); "a live stream within 5 s sends no clip" | done (unit); Docker e2e pending |
| Viewer cannot establish WebRTC | backend stream.test.ts "viewer ladder exhausted" (clip once per channel, idempotent); viewer.test.ts ladder (WebRTC → LL-HLS, 10 s watchdog each, no retry loop) | partial: §9 UDP-blocked network test pending |
| Every alert: parallel redundant send | backend alerts.test.ts, three configurations | done |
| Telegram error | alerts.test.ts (500 → email delivers; 429 retry_after; 403 permanent) | done |
| Email error | alerts.test.ts (451 retried; 550 permanent; Telegram unaffected) | done |
| All configured channels fail | alerts.test.ts "both channels down"; extension outbox unit test + red badge in watchdog | done |
| Zero channels configured | shared config.test.ts (min(1) at save); extension `arm()` refuses an invalid config with a hard error | done |
| Backend unreachable | extension dispatch.ts queues `backend-event` in the local outbox, notifies, falls back to T0 direct; outbox unit test | partial: e2e pending |
| Viewer backend unreachable | viewer renders query metadata with no backend call; "unavailable" path shows owner contact from viewer-config.json; shell-only service worker | partial: e2e pending |
| Provider timeout, 429, 5xx, parse error | providers adapters.test.ts "failover chain" | done |
| All providers fail | providers AllProvidersFailedError → scan-controller sends "unconfirmed"; backend alerts.test.ts renders UNCONFIRMED | done |
| Budget exhausted | extension sw.test.ts budget ledger; scan-controller notice once/day + unconfirmed under cooldown | done (unit) |
| MCP gate unreachable | backend actions.test.ts "SG-05 gate down" | done |
| Camera lost, track ended, frozen or black frames | worker source-health + SW notice ≤ 1/hour (notices.ts) | partial: e2e pending |
| Browser or host dies while armed | backend alerts.test.ts "dead-man alert" | done |
| Browser restart with a tab source | scan-controller `recoverSource` raises re-arm-needed; e2e shows tab capture needs a gesture | partial |
| Offscreen document crash | e2e m1.spec.ts "offscreen document killed" | done |
| WebGPU device lost | detector.ts falls back to WASM on device loss or WebGPU inference error; e2e runs WASM with WebGPU disabled | partial: device-loss injection pending |
| OME admission webhook failing | e2e ome/m5.spec.ts: hung → denied, stopped → denied, forward_auth fails closed | done |

## Needs human
- [ ] **Repo slug decision (D1).** The plan names `PacifAIst/survey-anything`; development happens in `PacifAIst/survany` as instructed. The `survey-anything` slug is free (checked 2026-11-09). If you rename, update `SOURCE_URL` in `packages/shared/src/defaults.ts`, the backend `SOURCE_URL` default, and `.github/workflows/cla.yml`.
- [ ] **CLA legal review (§13, D3).** Have counsel review `CLA.md` and confirm the steward entity name before the first external merge.
- [ ] **M1 soak on a real tab.** Load `apps/extension/dist` unpacked in Chrome, arm a tab from the toolbar, hide it behind another tab for 30 minutes, then in the extension's Options devtools console run `chrome.runtime.sendMessage({target:'sw',type:'debug-stats'})` and record `stats.fractionWithinOneSecond` (≥ 0.95) and `maxConsecutiveMissed` (≤ 1). Automation used a fake camera because tab capture requires a user gesture.
- [ ] **Fire/smoke weights (M2).** Run the D-Fire training pipeline on a GPU (to be added in `models/fire-smoke/`), export ONNX, add its SHA-256 to `models/checksums.json`. Until then the interim flame heuristic is active (logged as a known limitation).
- [ ] **Telegram bot.** Create a bot with @BotFather, set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_BOT_USERNAME` in `deploy/.env`.
- [ ] **Public deployment (M5).** VPS with DNS for `PUBLIC_HOST` and `LIVE_HOST`, open 80/443, 3478/tcp, 10000/tcp and 10000-10003/udp; `OME_HOST_IP` = public IP. Then the Mini App on real iOS and Android, and one viewer on mobile data (CGNAT); record the reported candidate type for D11.
- [ ] **Chrome Web Store account (M8).**

## Decisions and deviations from PLAN.md
| Date | Change | Why | Reversible? |
|------|--------|-----|-------------|
| 2026-11-09 | D1, D3 locked; alerts.channels made user-editable with min(1); review gaps 15–24 folded in. | Plan review before M0 | D1, D3: no |
| 2026-11-09 | v1.2: coturn removed (D11); viewer metadata carried in URL query string (SG-27); PIN re-pairing rationale corrected; OME `TcpRelay` + `doctor` and an arm-time WHIP probe replace coturn. | Topology review — TURN solves a problem the browser→SFU path does not have; `TcpRelay` covers UDP-blocked viewers. | D11: reversible (add coturn back if a real failure mode appears) |
| 2026-11-09 | Repository is `github.com/PacifAIst/survany`, not `survey-anything`. Product name stays "Survey Anything" (D1 untouched). | Owner instruction at kickoff. | Yes |
| 2026-11-09 | Config schema additions beyond §6.2: `provider*.timeoutMs`, `alerts.nonRedundantAck`, `backend.url`, `direct.telegram`, `direct.email` (T0 HTTP mail adapter = Resend). Event API additions: `ackTimeoutSec`, `streamTtlMinutes`. All default so the §6.2 sample validates verbatim (tested). | §6.2 requires a stored single-channel acknowledgement; T0 needs bot token and mail key refs; proxyMode needs a backend URL. | Yes |
| 2026-11-09 | Recipe gate parameters added (`requireClasses`, `minCount`, `requireMotion`, `region`, `pixelDelta`, `mode`, `targetColor`, `everyMinutes`). | §6.3 names gate types but not parameters. | Yes |
| 2026-11-09 | Failover advances on every provider error kind (adds network, bad-request, blocked to the §6.1 list). | Fail safe. | Yes |
| 2026-11-09 | Parsed confidence 2–100 read as percent; (1, 2) clamped to 1. | Some local models answer "85". | Yes |
| 2026-11-09 | `minimumReleaseAge: 20160` (14 days) in pnpm-workspace.yaml. | Supply-chain guard. | Yes |
| 2026-11-09 | **OvenPlayer pinned to 0.10.54, not 0.10.55** (S51 read 0.10.55, published 2026-11-03, inside the 14-day window). Verified in 0.10.54's dist: `transport` read from the URL with relay-only unless `transport=all`; `timeoutMaxRetry` only arms when > 0; `autoFallback` present. | Supply-chain guard. Bump after 2026-11-17. | Yes |
| 2026-11-09 | Viewer CSP lives only in the Caddy header (`LIVE_CONNECT_SRC` env), not a `<meta>` tag; `style-src` allows `'unsafe-inline'` on the viewer because OvenPlayer sets inline styles. Scripts stay `'self'` + telegram.org. | Found in the real-OME M5 test. | Yes |
| 2026-11-09 | Viewer waits out the remainder of the 5 s start budget measured from ingest admission (`liveForMs` in the grant), not only when `live` is false. | Real OME creates the playable output at the first keyframe (~1.3 s after admission); an instant viewer got 404 "Cannot create offer". | Yes |
| 2026-11-09 | ORT loads through its extern-WASM entry (`onnxruntime-web-use-extern-wasm`) with `numThreads = 1`; jsep `.wasm` and `.mjs` are checksummed in `models/checksums.json`. | Avoids Vite emitting a second, unchecked 28 MB WASM; offscreen documents are not cross-origin isolated. | Yes |
| 2026-11-09 | Backend data lives in named Docker volumes (`backend-data`, `caddy-data`, `gate-data`) and the image creates `/data` owned by `node`. | A root-owned bind mount made the backend fail to reopen its database after a restart (found in M5). | Yes |

## External facts checked
| Date | API or library | Version or doc URL | Result |
|------|----------------|--------------------|--------|
| 2026-11-09 | Anthropic Messages API version | S32 | `anthropic-version: 2026-10-21`; `temperature`, `top_p`, `top_k` → 400 even at defaults. Adapter sends none (tested). |
| 2026-11-09 | OME AdmissionWebhooks | S11 | Request/response format, HMAC-SHA1 base64url `X-OME-Signature`, lifetime in ms. **Correction from the real v0.21.0 image:** `request.protocol` arrives as `"WebRTC"` (docs show lowercase); the handler lower-cases direction, protocol and status (regression test added). |
| 2026-11-09 | OME v0.21.0 default Server.xml | image `origin_conf/Server.xml` | Element names used: `IceCandidate` with `/udp` and `/tcp`, `TcpRelay`, `TcpRelayForce`, `TcpRelayWorkerCount`, `AdmissionWebhooks/Enables`, `${env:NAME:default}`. Untokened WHIP → `401 AdmissionWebhooks error`. |
| 2026-11-09 | confirm-gate-mcp device API | S17 docs/API.md + source `src/confirm_gate/evidence.py`, `device.py`, `cli.py` | Signature = hex HMAC-SHA256 keyed with base64url-decoded device key over `METHOD\nPATH?query\nTIMESTAMP\nhex(sha256(body))`; headers `x-device-id`, `x-timestamp`, `x-signature`; one use per signature (so repeated GETs add a random query value); default port 8800; proposals are the upstream tool call through `/mcp` returning `status: pending_user_confirmation` + `pending_id`. |
| 2026-11-09 | YOLOX ONNX | S23 | Apache-2.0; `yolox_tiny.onnx` input `images [1,3,416,416]` (BGR, 0-255), output `[1,3549,85]` raw grid offsets with sigmoided obj/cls. Pinned to HF revision 9206d80c, sha256 427cc366…. |
| 2026-11-09 | D-Fire dataset | S24 LICENSE file | CC0 1.0 confirmed. |
| 2026-11-09 | OvenPlayer | S51 (npm 0.10.54 dist) | See deviation row. |
| 2026-11-09 | Container images | Docker Hub | Pinned digests: OME v0.21.0 `sha256:172da912…`, caddy 2.10.2-alpine `sha256:4c6e91c6…`, mailpit v1.27 `sha256:e22dce5b…`, node 24-alpine `sha256:a34ab6d7…`, python 3.13-slim `sha256:e48f59cd…`. |

## Session log (newest first)
### 2026-11-09 (later): M1–M6 implementation and verification
- Done: extension (offscreen capture, Worker scan loop, YOLOX via ORT with checksums, gates, state machine, budget, guardedFetch, outbox, T0 direct senders, popup, consent, camera grant, pairing, Options); backend (pairing, contacts, events, parallel dispatcher + durable outbox, Telegram webhook, ack + escalation, dead-man, OME admission + forward_auth, viewer Telegram/email flows, PIN with lockout, clips, proxy with SSRF guard, approvals with confirm-gate client, audit hash chain, retention); viewer (metadata render, PIN flow, OvenPlayer ladder, shell SW); deploy (compose with pinned digests, Caddyfile, OME Server.xml, gate container, env template).
- Bugs found by tests and fixed: lost-update race in SW storage (e2e); emergency-ban bypass via `call_police` underscore; confirm-gate replay rejection of identical GET signatures; OME protocol casing; viewer start-budget race; root-owned data volume; `URL.origin` "null" for chrome-extension URLs in the asset guard.
- Tests run: `pnpm vitest run` → 202 passed; extension e2e 5/5; M1 soak pass; M5 real-OME 5/5; `pnpm check` clean.
- Next: M6 extension wiring + MCP_PAIRING.md; M2 training pipeline + model card; M3 network-log e2e; `scripts/doctor`; M7 docs, bench, demo; M8 packaging.
- Blockers: none.

### 2026-11-09: kickoff, M0 scaffold, shared/recipes/providers
- Done: monorepo, CI, CLA, check scripts, shared/recipes/providers packages.
- Tests run: `pnpm vitest run` → 101 passed.
