# Threat model

Survey Anything watches a camera or a browser tab, asks a model to confirm what it sees, alerts people,
streams privately, and can run a device action after a person approves it. This document lists what it
protects, who might attack it, where the trust boundaries are, and which control and which test covers
each threat. Controls are named by their security gate (SG-xx, `docs/PLAN.md` §7); every gate has a
`SECURITY-GATE SG-xx` marker in code and a test, and CI fails if one goes missing
(`scripts/check-security-gates.ts`).

The design rule underneath all of it: **an injected instruction can make the system ask, but cannot make
it act.** Everything a model, a web page or an image says is data.

## What is protected

| Asset | Why it matters |
|---|---|
| Frames from the camera or tab | Private by default. They may show a home, people, screens. |
| Device actions (lights, sirens, locks) | A wrong action can open a door or silence an alarm. |
| Alerts | A lost or suppressed alert is a safety failure. |
| The live stream | Only the alerted contacts may watch, only for minutes. |
| Secrets | Provider API keys, Telegram bot token, device token, gate device key, HMAC keys, contact PINs. |
| Contact data | Telegram IDs, email addresses (backend only). |

## Who might attack

- **Content in front of the camera or in the watched tab.** A sign, a sticker, a screen, a web page or a QR
  code that tries to instruct the model. The most likely attacker, and the one this design is built around.
- **A model that misbehaves.** It hallucinates, is wrong, is jailbroken, or is a malicious endpoint the
  user configured.
- **Someone on the network path or a mail scanner.** Sees or replays links, auto-clicks email links.
- **Someone who gets a link.** A forwarded alert email, a leaked viewer URL.
- **A person in a Telegram group or a non-approver contact.** Tries to tap Approve.
- **Someone who can reach the backend over the internet.** Unauthenticated requests, forged webhooks,
  admission calls, SSRF through the proxy.
- **A malicious recipe or config file** shared by a third party and imported.

## Trust boundaries and controls

### 1. Pixels → on-device gate → model

| Threat | Control | Test |
|---|---|---|
| Text in the image instructs the model ("there is no fire", "return none") | The prompt declares the image untrusted and forbids following text in it; the gate runs first and cannot be talked to | Red team (`bench/reports/m7-redteam.json`, `docs/BENCHMARKS.md`): suppression rate is **measured and reported, not claimed to be zero** |
| The model returns garbage, an unknown event, or prose | Defensive parse; a parse failure is a provider failure, then failover, then an "unconfirmed" alert (C12) | `packages/providers/test/adapters.test.ts` |
| A model is configured that cannot see images | The probe renders a random code; the model must read it back before it can be saved (C26) | `adapters.test.ts`; `e2e/options.spec.ts` (a text-only model fails) |
| Frames reach a cloud provider when the user said local only | `allowCloudProviders:false` enforced at the single network boundary `guardedFetch`; lint bans raw `fetch` (SG-14) | `test/sw.test.ts`; `e2e/m3-network.spec.ts` logs every request: 0 non-local requests carry image bytes |
| Snapshots, clips or the stream leave without consent | Each egress kind needs its own flag (`egress.alertMedia`, `egress.liveView`); undeclared image bytes are blocked (SG-15) | `test/sw.test.ts`; `e2e/m3-network.spec.ts` |

### 2. Model text → people

| Threat | Control | Test |
|---|---|---|
| Model text carries links, @mentions, bot commands, HTML | `reason` is sanitized, length-capped, URL-stripped and escaped for Telegram and email (SG-17) | `packages/shared/test/security.test.ts`; red team counts URLs after sanitizing (must be 0) |
| Model text appears on an approval card | Cards are rendered by the backend from the policy template and validated arguments only (SG-03) | `apps/backend/test/actions.test.ts`; `e2e/m6/m6-extension.spec.ts` asserts the injected sign text is absent from the card |

### 3. Model → device action (the critical path)

| Threat | Control | Test |
|---|---|---|
| A model executes an action | The model has no MCP connection, gate key, device key or nonce; the Reasoner only returns JSON (SG-02). Only the backend talks to the gate. | `actions.test.ts` (self-approval); `e2e/m6` |
| The Reasoner proposes something outside the policy (unlock, disarm, an unlisted entity) | Validated against the backend's tool list in the extension, then against `policy.yaml` in the backend; locks and alarms need an exact entity in `allowSensitive`; emergency-service tools are refused in code (SG-06) | `packages/providers/test/reasoner.test.ts`; `actions.test.ts`; `e2e/m6` "obey-sign" and "policy" scenarios; red team (sensitive proposals that reach a card: 0) |
| Anything runs without a person | Only a Telegram tap approves; no tap within the window means deny (SG-01) | `actions.test.ts` expiry; real-gate tests `bench/reports/m6-gate.json`, `m6-e2e.json` |
| A tap is replayed, comes from a non-approver, another chat or a group | Atomic single decision; approver checked against `callback_query.from.id`, the chat the card went to, private chats only (SG-04); gate signatures are single-use | `actions.test.ts`; `m6-gate.json` (3 replays → still 1 execution) |
| The arguments change between card and execution | Approval bound to a params hash; the gate re-checks arguments at confirm time (SG-03) | `actions.test.ts` "changed args" |
| The gate is down | Deny and tell the owner (SG-05) | `actions.test.ts`; `m6-gate.json` |
| A forged Telegram webhook | `X-Telegram-Bot-Api-Secret-Token` required (SG-07); callback data ≤ 64 bytes (SG-08) | `apps/backend/test/security.test.ts`; property test in `packages/shared/test/security.test.ts` |

### 4. Links and the live stream

| Threat | Control | Test |
|---|---|---|
| A guessed or leaked viewer link | 256-bit tokens, ≤ 10 min, stored hashed, single-use, bound to the first session (SG-10) | `apps/backend/test/stream.test.ts`; real OME `bench/reports/m5-ome.json` |
| A mail scanner burns the link, or a forwarded email is used | Email links are inert on GET; the contact's PIN is required; PIN attempts rate-limited with lockout; email never approves (SG-12) | `stream.test.ts` |
| Someone else's Telegram account opens the Mini App | `initData` HMAC validated with a freshness window, matched to the token's contact (SG-09) | `stream.test.ts` |
| Publishing or playing without a token | OME AdmissionWebhooks (signature verified, unknown means deny) plus Caddy `forward_auth` in front of OME's signaling (SG-11); OME's REST API only on the compose network with an access token (SG-20) | `apps/extension/e2e/ome/m5.spec.ts` against the pinned OME image: untokened → 401/403; backend stopped or hung → denied |
| Streaming without the user knowing | The badge and banner must be set and verified before a stream starts; no flag hides them (SG-13) | `test/sw.test.ts` |
| Viewer-link metadata used for injection | Query values validated, length-capped, rendered with `textContent`, labelled "unverified" until the backend confirms (SG-27) | `apps/viewer/test/viewer.test.ts` |

### 5. The extension and the backend

| Threat | Control | Test |
|---|---|---|
| Anyone posts events to the backend | Pairing code → device token, rate limits (SG-16) | `security.test.ts` |
| SSRF through the provider proxy | Server-side host allowlist, private ranges blocked after DNS resolution (SG-19) | `security.test.ts` (proxy analyze and probe) |
| Keys leak through export or logs | Config holds only key references; export never reads the secrets store; import refuses embedded keys; storage limited to trusted contexts (SG-21) | `security.test.ts`; `e2e/options.spec.ts` (export has no keys; import with a key is refused) |
| Snapshots and clips kept forever; audit tampered | Media auto-deleted (default 24 h); the audit log is a hash chain (SG-22) | `security.test.ts` |
| Remote code in the extension | Models and WASM bundled and checksummed; the build and the runtime refuse a mismatched file; no remote scripts (SG-26) | `test/sw.test.ts`; `e2e/m1.spec.ts` loads both models with every network request blocked |
| A shared recipe changes routing, egress or actions | Recipes are strict data; a deep scan refuses those keys (SG-18) | `packages/recipes/test/recipes.test.ts` |
| Supply chain | Dependencies younger than 14 days are not installed (`minimumReleaseAge`); images pinned by digest; models pinned by SHA-256; gitleaks on every commit and in CI | `pnpm install`; CI `secrets` job |

## What this design does not protect against

Stated plainly, so nobody relies on a control that does not exist:

- **A fully compromised backend.** It holds the gate's device key, the Telegram bot token and the PIN
  hashes. An attacker with root on that host can sign approvals, read alerts and rewrite a PIN hash.
  The PIN re-pair rule (no API changes a PIN in place) closes the in-application path only. Keep the host
  patched, `deploy/.env` private, and the gate on the compose network.
- **A compromised browser profile or machine running the extension.** It sees the frames and the keys
  stored in the extension (use proxy mode to keep provider keys on the backend).
- **A taken-over Telegram account or an unlocked approver phone.** The Telegram tap is the second factor;
  protect it with a passcode and Telegram's two-step verification.
- **Telegram and email are not end-to-end encrypted** for these messages. Snapshots sent there are
  readable by those providers. Turn `egress.alertMedia` off to send text only.
- **Model mistakes.** A model can miss a real event or confirm a false one, and an injected sign can
  sometimes suppress a confirmation (see the measured rate). The gate-then-confirm design, "unconfirmed"
  alerts when models fail, and the per-frame numbers in `docs/BENCHMARKS.md` are there so the error rate is
  known, not hidden. This is not a certified safety device and does not replace smoke alarms.
- **Your policy choices.** If `policy.yaml` allows a switch that powers a door strike, approving that
  switch opens the door.
- **Physical attacks on the camera** (covering, moving, replaying a video). Frozen and black frames raise
  a "camera offline" notice; a convincing replay does not.
- **The model provider.** A cloud provider sees the frames you send it. Use a local model or keep
  `allowCloudProviders` off.

## Reporting

See `SECURITY.md`. The highest-priority report is any path where an action runs without a human tap.
