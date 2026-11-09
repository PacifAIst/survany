# Chrome Web Store listing (draft, not submitted)

Draft answers for the Chrome Web Store dashboard, derived from `apps/extension/manifest.config.ts` and the
code. Everything here needs the owner's review before submission; items marked **Decide** are judgement
calls. Policy references: S41 (user data FAQ), S42 (2026 policy update), S43 (remote code).

## Store listing

- **Name:** Survey Anything
- **Short description (≤132 chars):** Watch any tab or camera for what you choose and get Telegram or email alerts. Actions need your tap.
- **Category:** Productivity. **Decide:** "Tools" is the alternative.
- **Language:** English.
- **Description (draft):**

  Survey Anything watches a browser tab or a camera you choose, looks for what you asked about (fire or
  smoke, a person in a restricted zone, a dashboard turning red, a 3D print failing, and more), and alerts
  your contacts on Telegram and email.

  A free detector runs on your computer on every frame. An AI model of your choice, including a fully
  local one, is asked only when the detector finds a candidate, and only within the budget you set.
  Nothing is captured until you accept the consent screen, the toolbar badge shows whenever it watches,
  and a banner shows whenever it streams and to whom. Optional: a self-hosted backend for private live
  view and device actions that run only after a person taps Approve.

  No face recognition, no emotion inference, no audio, no hidden mode, and it never contacts emergency
  services on its own. Open source (AGPL-3.0): https://github.com/PacifAIst/survany

- **Screenshots and promo images:** not made yet (launch assets, Needs human).

## Single purpose

> Watch a browser tab or camera that the user selects and notify the user's chosen contacts when a
> user-defined visual event is detected.

Every feature serves this purpose: capture and on-device detection (watch), AI confirmation (detect),
Telegram/email/backend (notify), live view and approved actions (respond to the notification).

## Permission justifications

| Permission | Justification for the dashboard |
|---|---|
| `offscreen` | The camera or tab stream, the frame-scanning worker and the clip recorder must live in an offscreen document: Manifest V3 service workers cannot hold a media stream. |
| `tabCapture` | To watch a tab, the user picks it from the toolbar ("Watch this tab"); the extension captures only that tab, only after that click. |
| `activeTab` | Grants access to the tab the user explicitly invokes the extension on, so "Watch this tab" works without broad host access. |
| `storage` | Settings, the user's API keys (local only), rule state and the alert outbox are stored locally so alerts survive service-worker restarts. |
| `alarms` | A watchdog (every 30 s or more) restarts the scan loop if the browser stopped it, and sends a heartbeat to the user's own backend. |
| `notifications` | Shows alerts, "camera offline" and "budget reached" notices, and the "Streaming to …" indicator. |
| Optional host access (`https://*/*`, `http://*/*`) | Requested at runtime, one origin at a time, only for addresses the user types: their AI model server (cloud or local), their backend, the Telegram Bot API, the mail API. Nothing is requested at install. |

No content scripts. No `<all_urls>` at install. CSP: `script-src 'self' 'wasm-unsafe-eval'` (needed for the bundled
onnxruntime WebAssembly).

## Remote code

**No.** All JavaScript, the WebAssembly runtime and both ONNX models are inside the package and checksummed
(`models/checksums.json`); the build and the runtime refuse a file whose SHA-256 does not match. AI model
providers return JSON text that is parsed as data, never executed.

## Privacy practices (data use disclosure)

The extension has no developer-operated server. Data leaves the computer only to services the **user**
configures, for the single purpose, after the in-extension consent screen.

| CWS data category | Handled? | What and where |
|---|---|---|
| Website content | **Yes** | Frames of the tab the user chooses to watch. Processed on the device; a candidate frame goes to the user's chosen AI provider (none if local), and a snapshot/clip goes to the user's Telegram/email/backend only if the user turns on "Alert media". **Decide:** frames from a **camera** are not website content; consider also ticking the closest category the form offers and describing it. |
| Personally identifiable information | **Yes** | Contact email addresses and Telegram chat IDs the user enters for alerts (stored locally, sent to the user's mail service/Telegram/backend). Camera frames may show people. |
| Authentication information | **Yes** | The user's own API keys and bot token, stored locally (`chrome.storage.local`), sent only to the service each key belongs to (or kept on the user's backend in proxy mode). |
| Personal communications | No | |
| Location | No | |
| Web history | No | |
| User activity | No | |
| Health information | No | |
| Financial and payment information | No | |

**Certifications (all true for this code):**
- Data is not sold to third parties.
- Data is not used or transferred for purposes unrelated to the single purpose.
- Data is not used or transferred to determine creditworthiness or for lending.

**Prominent disclosure and consent (S41/S42):** `apps/extension/src/onboarding/consent/` shows what is
captured, where it can go, and requires an affirmative action before any capture (SG-24, tested in
`e2e/m1.spec.ts`).

**Privacy policy URL:** https://github.com/PacifAIst/survany/blob/main/docs/PRIVACY_POLICY.md
(**Decide:** a stable `vX.Y.Z` tag URL is safer for review than `main`.)

## Reviewer notes (draft)

> To test without hardware: run `pnpm demo` from the repository (or open any page with a fire image), open
> the extension's Options, choose "Direct Telegram" with a test bot or untick AI confirmation, then use
> "Watch this tab". The extension never captures before the consent screen is accepted.
