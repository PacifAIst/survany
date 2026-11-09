# Model providers

Survey Anything calls a vision model only when the on-device gate has already found a candidate, and
only through one normalized adapter, so switching providers is a settings change. Any provider can be
the **Vision provider** (confirms what a frame shows) or sit in the **failover chain** behind it; a
text-only model can be the **Reasoner** (suggests device actions for approval).

## The rule every provider must pass

Before a model can be saved as the Vision provider, **Test Connection** runs a probe: it renders a random
six-character code into a 256 px image and the model must read it back. An HTTP 200 proves nothing; a
model that cannot see is refused. If the model answers but misreads, it gets one more image with a fresh
code. A model that cannot see has no realistic chance of guessing either code (about 86 million
combinations each). Measured pass rates are in `docs/BENCHMARKS.md`.

The same check runs again when you press Save, under the settings you are saving (for example,
`allowCloudProviders` off refuses a cloud host before any request is made).

## Cloud providers

| Provider | Base URL | Notes |
|---|---|---|
| Anthropic | `https://api.anthropic.com` | Sends `anthropic-version: 2026-10-21` and no sampling parameters (that version rejects them). From the browser it adds `anthropic-dangerous-direct-browser-access: true`; proxy mode avoids that. |
| OpenAI | `https://api.openai.com/v1` | No default model: pick one, the probe validates it. Uses `max_completion_tokens`, retrying once with `max_tokens` for compatible servers. |
| OpenRouter | `https://openrouter.ai/api/v1` | `:free` models are limited to 20 requests a minute and 50 a day below $10 of lifetime credits (1,000 a day above); the budget engine enforces this. |
| DeepSeek | `https://api.deepseek.com` | Default `deepseek-flash`, which accepts images. |

Keys are stored in this browser by default. With a backend, **proxy mode** keeps them on the server
(`PROXY_KEY_*` in `deploy/.env`) and the backend makes the call, with a host allowlist and private ranges
blocked. Proxy mode is recommended whenever you run a backend.

## Local models (no frames leave the machine)

Any OpenAI-compatible server works: Ollama, LM Studio, vLLM, llama.cpp's server. With
**Allow cloud AI providers** off, only loopback and private-network hosts can receive frames, and the
scan interval may go down to 500 ms.

### Ollama

```bash
ollama pull qwen2.5vl:7b
```

Base URL `http://127.0.0.1:11434/v1`, model `qwen2.5vl:7b`. Ollama refuses requests from browser
extensions unless they are allowed; Test Connection detects the 403 and shows the exact command for your
system, which is one of:

- macOS: `launchctl setenv OLLAMA_ORIGINS "chrome-extension://<extension id>"`, then quit and reopen Ollama.
- Windows (PowerShell): `setx OLLAMA_ORIGINS "chrome-extension://<extension id>"`, then quit Ollama from the tray and start it again.
- Linux (systemd): `sudo systemctl edit ollama.service`, add `Environment="OLLAMA_ORIGINS=chrome-extension://<extension id>"` under `[Service]`, then `sudo systemctl daemon-reload && sudo systemctl restart ollama`.
- Docker: `docker run -d --gpus all -p 127.0.0.1:11434:11434 -e OLLAMA_ORIGINS='chrome-extension://*' -v ollama:/root/.ollama ollama/ollama`.

The benchmark in `docs/BENCHMARKS.md` uses exactly this: Ollama 0.40.11 with `qwen2.5vl:7b` on a 6 GB laptop
GPU (the model does not fit entirely, so part of it runs on the CPU).

### LM Studio, vLLM, llama.cpp

Point the base URL at the server's OpenAI-compatible endpoint (`…/v1`) and pick a vision model. The
server must accept requests from the extension's origin (`chrome-extension://<extension id>`); if it does
not, Test Connection shows the error. Each of these servers has a CORS or allowed-origins setting.

### Licenses

The Options page shows a model's license before you use it. Qwen2.5-VL: 7B and 32B are Apache-2.0, 72B is
under the Qwen License, and the 3B model is under a research license. Read the model card of anything
else you load.

## Failover and budget

The chain is tried top to bottom (reorder it in Options). It moves to the next provider on a timeout, a
429, any 5xx, 401, 402 or 403, or an answer that does not parse. The provider that answered is logged. If
every provider fails, the alert still goes out, labelled unconfirmed.

Cloud calls are capped per minute, per day and in tokens per day. When a cap is hit, cloud calls stop for
the rest of the UTC day, the on-device gate keeps running, alerts go out labelled unconfirmed under
cooldown, and you get one notice. Local models are not counted.

## Thresholds

A model's confidence is self-reported and poorly calibrated. A confirmation counts when the model names
the rule's event with confidence of at least 0.5 (per-model overrides live in
`packages/shared/src/defaults.ts`). Set them from your own measurements: `pnpm bench:providers` runs the
same adapter, prompt and parser on a fixed image set (see `docs/BENCHMARKS.md`).
