# Firefox build and addons.mozilla.org (AMO)

The Firefox add-on is built from the same code as the Chrome extension, with `vite build --mode firefox`.
It does the same job (rules, local or cloud AI, Telegram and email alerts, backend pairing, budget), with
the differences below.

## What differs from Chrome

| | Chrome | Firefox |
|---|---|---|
| Background | service worker | event page (background script) |
| Capture (camera, detector, clips, live view) | invisible offscreen document | a pinned **Survey Anything** tab that says "Watching: …". Closing it stops watching, with a notice. Firefox starts a camera only for the tab in front, so **Watch camera** shows that tab for a moment, then returns to your tab; watching continues in the background. |
| Watch a browser tab | **Watch this tab** | Not possible: Firefox has no tab capture. Instead, **Watch a window or screen**: the pinned tab shows a button, and Firefox's own sharing picker opens on the click (Firefox allows the picker only from a click). |
| Watch the camera | **Watch camera** | the same |
| Frames | MediaStreamTrackProcessor | a muted video element (Firefox has no MediaStreamTrackProcessor or ImageCapture) |
| Detector | WebGPU, else WebAssembly | WebAssembly (WebGPU where Firefox offers it to workers) |
| Minimum version | Chrome 120 | Firefox 140 (desktop) |

Firefox-only code sits behind a build-time constant (`__FIREFOX__`), so each package contains only its own
browser's code paths.

## Build and package

```bash
pnpm install
pnpm --filter @survey-anything/extension build:firefox   # -> apps/extension/dist-firefox/
pnpm pack:firefox    # -> release/survey-anything-firefox-<version>.zip (+ .sha256), reproducible
pnpm pack:source     # -> release/survey-anything-source-<version>.zip, the committed tree, for AMO's source review
```

Run `pnpm pack:source` after committing: it packs `HEAD`, not uncommitted changes.

Checked on 2026-11-12: the source zip, unpacked into an empty folder, then `pnpm install --frozen-lockfile`
(which downloads and verifies the fire/smoke model) and `build:firefox`, gives the same package byte for
byte: all 35 files identical and the same zip SHA-256 as the uploaded one. That is what AMO's reviewers
compare.

## Test

**Automated, in a real Firefox** (needs Firefox 140 or later, and LM Studio serving a vision model at
`http://127.0.0.1:1234`):

```bash
python -m pip install selenium==4.38.0
python apps/extension/e2e-firefox/firefox_e2e.py --firefox "<path to firefox.exe>" --extension release/survey-anything-firefox-0.1.1.zip
```

It installs the zip as a temporary add-on and walks the real pages with Firefox's fake camera:

- consent and camera permission;
- Options: **LM Studio**, **Test connection**, the "Person left the camera view" rule, Telegram, **Save**;
- **Watch camera**, then the pinned monitor tab;
- a local AI check of the empty scene, and the alert;
- **Disarm**, closing the monitor tab, and window or screen sharing.

Result on 2026-11-12, Firefox 160.0 with LM Studio `qwen3-vl-4b-instruct`: **20/20**. The model answered
"nobody visible" 13 s after watching started, and the alert was produced and sent to Telegram (refused
only because the test uses a placeholder token).

**By hand:** open `about:debugging#/runtime/this-firefox`, press **Load Temporary Add-on…** and pick
`apps/extension/dist-firefox/manifest.json`. A temporary add-on stays until Firefox restarts. Then follow
`docs/GUIDE_LEAVE_ALERT.md`; in Firefox the popup says **Watch a window or screen** instead of **Watch this tab**.

**Mozilla's linter** (the same checks AMO runs on upload): `npx addons-linter@10.15.0 release/survey-anything-firefox-0.1.1.zip`
gives 0 errors and the 4 warnings explained in the reviewer notes below.

## Submitting to addons.mozilla.org

The owner submits; nothing here is submitted automatically.

1. Sign in at <https://addons.mozilla.org/developers/> with a Mozilla account and accept the developer agreement.
2. **Submit a New Add-on** → **On this site** (listed on AMO).
3. Upload `release/survey-anything-firefox-<version>.zip`. Compatibility: **Firefox** (desktop) only. Do not tick
   Android: it has not been tested there, and the data declaration needs Firefox for Android 142.
4. **Source code:** answer **Yes**, because Vite bundles and minifies the code. Upload
   `release/survey-anything-source-<version>.zip`.
5. **Listing:**
   - Name: `Survey Anything`.
   - Summary: `Point a camera, a window or the screen at anything, say what to watch for, and get a Telegram or email alert. A free on-device detector checks every few seconds; an AI model you choose confirms.`
   - Description: adapt the README introduction and the site (https://survany.pages.dev).
   - Category: **Alerts & Updates**.
   - Homepage: `https://survany.pages.dev`. Support site: `https://github.com/PacifAIst/survany/issues`.
   - License: GNU Affero General Public License v3.0. If AMO does not list it, choose a custom license and point to `LICENSE`.
   - Privacy policy: paste the text of `docs/PRIVACY_POLICY.md`.
6. **Data collection:** the manifest declares `websiteContent` and `personallyIdentifyingInfo` as required, so
   Firefox shows them in the install prompt. The reason: snapshots of what is watched go to the user's AI
   model and, with Alert media on, to their Telegram bot or email; the alert carries their chat ID or email
   address. Nothing goes to the developer: no account, no telemetry. **Review this choice before
   submitting**; it is in `apps/extension/manifest.config.ts` (`FIREFOX_DATA_COLLECTION`).
7. Paste the **notes for reviewers** below.

The add-on ID is `survany@pacifaist` (`FIREFOX_ADDON_ID`). It must never change after the first upload,
or Firefox treats the next upload as a different add-on.

### Notes for reviewers (paste into "Notes to Reviewer")

```
Survey Anything watches a camera, a window or the screen that the user chooses, runs an object detector
(YOLOX, ONNX) locally in a Web Worker, asks an AI model the user configures to confirm candidates, and sends
alerts by Telegram or email. Source: https://github.com/PacifAIst/survany (AGPL-3.0).

Build from the source zip (Node.js 24, pnpm 10.33.2 via corepack):
  corepack enable
  pnpm install --frozen-lockfile      (postinstall downloads the fire/smoke model from the project's GitHub
                                       release and verifies its SHA-256 before writing it)
  pnpm --filter @survey-anything/extension build:firefox
  -> apps/extension/dist-firefox/ is the uploaded package (pnpm pack:firefox zips it reproducibly).

No remote code: every script, the ONNX models and the onnxruntime-web WASM files are inside the package,
and each model and WASM file is checked against a pinned SHA-256 before use (models/checksums.json).
Network requests go only to hosts the user grants (optional host permissions): their AI provider, which
can be on 127.0.0.1 such as LM Studio or Ollama, api.telegram.org and api.resend.com. There is no
analytics or telemetry.

Linter warnings, all in unmodified third-party code:
- DANGEROUS_EVAL in ort/ort-wasm-simd-threaded.jsep.mjs: onnxruntime-web's Emscripten loader. The
  extension CSP has no 'unsafe-eval', so that path cannot run; inference works without it.
- UNSAFE_VAR_ASSIGNMENT "import" in the scan worker: onnxruntime-web loads its WASM glue with
  import(url), where the URL is the extension's own ort/ folder.
- UNSAFE_VAR_ASSIGNMENT innerHTML in hooks.module: Preact's dangerouslySetInnerHTML support. The
  extension never uses it.
- KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION: the add-on is offered for desktop only.

How to try it without any account:
1. Install; the consent page opens. Tick the boxes, press "I agree", then "Allow camera access".
2. Options: under "Vision and token savers" untick "Confirm candidates with AI" (no AI model needed).
   Under "Extension-only mode", tick "Direct Telegram" and enter any token and the chat ID 1. Under
   "Alert channels", untick Email and press "I understand, use one channel". Under "Watch rules", tick
   only "Person left the camera view". Press Save.
3. Click the toolbar icon, then "Watch camera". A pinned "Survey Anything" tab opens and says
   "Watching: Camera".
4. Step out of the camera's view: within about 15 s a desktop notification "Person left the camera view"
   appears. The Telegram send fails with the dummy token, which is expected.
5. Close the pinned tab to stop, or use "Disarm" in the popup.
```

## Uploading a fixed version

AMO never accepts the same version number twice, even for a version that is still in review or disabled.
After any change, raise `version` in `apps/extension/package.json` and upload the new zip and source zip as
a new version (Developer Hub → the add-on → **Upload New Version**). 0.1.1 fixes the camera in Firefox
(found in the owner's first Firefox test): Firefox starts a camera only for the tab in front, so the pinned
tab is brought forward for the start; and the camera can now be chosen (popup → **Camera…**), because
Firefox's default on a PC with NVIDIA Broadcast was that virtual camera.

## After approval

Mozilla signs the add-on and the listing goes live. For an update:

1. Raise `version` in `apps/extension/package.json`.
2. Rebuild, then run `pnpm pack:firefox`.
3. Commit, then run `pnpm pack:source`.
4. Upload both files as a new version.
