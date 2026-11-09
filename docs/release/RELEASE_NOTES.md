# Survey Anything 1.0.0 (draft release notes)

Point it at any browser tab or camera, say what to watch for, and get a Telegram and email alert when it
happens. Nothing acts without your tap.

## What is in it

- **Chrome extension** (Manifest V3): watches a tab or camera; a free on-device detector runs on every frame
  (YOLOX-tiny for people and objects, and a fire/smoke model trained for this project), and a vision model
  of your choice confirms only the candidates. Ten built-in watch rules; import your own as JSON recipes.
- **Any model:** Anthropic, OpenAI, OpenRouter, DeepSeek, or any OpenAI-compatible local server (Ollama,
  LM Studio, vLLM, llama.cpp). Every model must read a code back from a test image before it is accepted.
- **Alerts** on Telegram and email at the same time, with an outbox that retries, from the browser alone
  or through the optional backend.
- **Backend** (Docker Compose): acknowledgements and escalation, contact routing, SMTP email, recorded
  clips, a dead-man alert if the browser dies, and proxy mode so API keys stay on your server.
- **Private live view** (OvenMediaEngine): single-use, 10-minute links per contact; WebRTC with TCP and
  LL-HLS fallbacks, and a recorded clip when nothing gets through.
- **Human-approved device actions** through confirm-gate-mcp (e.g. Home Assistant via ha-mcp): a model may
  suggest, a person taps Approve on Telegram, nothing runs otherwise.

## Measured (docs/BENCHMARKS.md)

- Fire/smoke detector on the official D-Fire test split: mAP@0.5 0.753 (fire 0.703, smoke 0.803).
- Behind the detector, the vision model confirmed with 100% precision and no false alarms on 60 "none"
  images, for both models measured (local qwen2.5vl:7b and OpenRouter qwen2.5-vl-72b); recall 52–65% and
  78% respectively, lowest on smoke without visible flame.
- Signs painted into the scene telling the model to stand down or to unlock a door: 0 actions without a
  tap; the 7B model's answer changed on 9 of 24 attacked scenes, the 72B model's on none.
- Live view against a firewalled viewer: UDP, ICE-TCP, TCP relay and LL-HLS each tested; with everything
  blocked, the clip went out once per channel.

## Known limitations

- Smoke without visible flame is the weak spot of the fire detector (about 70% recall per frame at the
  default threshold); see the trade-off table.
- Only one cloud provider has been measured; false alarms per day on video clips are not measured yet.
- Not a certified safety device. Keep your smoke alarms.

## Verify this release

```bash
sha256sum -c survey-anything-extension-1.0.0.zip.sha256
```

The zip is reproducible: building the tagged commit from a clean clone with `pnpm install --frozen-lockfile
&& pnpm build && pnpm pack:extension` produces the same SHA-256. The SBOM is `sbom.cdx.json` (CycloneDX 1.5).

Licensed AGPL-3.0-only. Source: https://github.com/PacifAIst/survany
