# Privacy policy

Survey Anything is software you run. There is no Survey Anything service: the project receives no data
from you, has no account system, and collects no telemetry. This policy says what the software itself
does with data, so you can decide what to allow. It applies to the browser extension, and to the backend,
viewer and media server when you deploy them.

## What the extension processes

| Data | Where it goes | When |
|---|---|---|
| Frames from the camera or tab you choose | Processed on your computer by the on-device gate. | Every scan, only while you have armed it. |
| The frame that triggered a candidate (downscaled) | To the AI model you configured. A local model keeps it on your machine or network; a cloud model sends it to that provider. With **Allow cloud AI providers** off, the extension refuses to send frames to any host that is not loopback or a private network address. | Only when the gate found a candidate and the model call is within your budget. |
| A snapshot and a 10-second clip | To Telegram and/or email, and to your backend, **only when Alert media is on**. | With an alert. |
| A live stream | To your own OvenMediaEngine server, **only when Live view is on**, viewable by the alerted contacts. | After an alert, for at most 10 minutes per link. |
| The model's description of the event | To your alert channels, after links, mentions and markup are removed. | With an alert. |
| Settings, API keys, the backend device token | Stored in the extension's local storage on your computer, never in exported settings. With proxy mode, provider keys stay on your backend instead. | When you save them. |

The extension asks for access to a website only when you configure it (a model server, your backend,
Telegram, the mail API), from a click on its own pages. It has no content scripts and reads no web page
you have not chosen to watch. It plays no audio and records no audio.

Before the first capture, the extension shows what it does and requires you to agree. While it watches,
its badge shows it; while it streams, a banner and a notification say to whom.

## What the backend stores (if you run one)

- Contacts: a contact name, Telegram user ID and chat ID, email address, a scrypt hash of their PIN, and
  their roles.
- Events: rule, time, severity, confidence, the sanitized description, and, if alert media is on, the
  snapshot and clip. **Snapshots and clips are deleted automatically after 24 hours** by default
  (`MEDIA_RETENTION_HOURS`; 0 deletes them as soon as their links expire).
- Delivery records, acknowledgements, approvals, and an append-only audit log (a hash chain) of approvals
  and security events.
- Stream and viewer tokens are stored only as hashes and expire within 10 minutes.

The backend sends data only to the services you configure: Telegram, your SMTP server, your
OvenMediaEngine, confirm-gate-mcp, and, in proxy mode, your AI provider.

## Third parties you choose

- **AI providers** (Anthropic, OpenAI, OpenRouter, DeepSeek or others) receive candidate frames when you
  use them. Their own policies apply.
- **Telegram and your email provider** receive alerts. **Telegram and email are not end-to-end encrypted
  for these messages**: those providers can read them, including snapshots when alert media is on.
- **Resend** (extension-only email) receives alert emails when you configure it.

## Your choices

- Use a local model and turn **Allow cloud AI providers** off to keep frames on your network.
- Turn **Alert media** off to send text-only alerts.
- Turn **Live view** off to never stream.
- Disarm, or remove the extension, to stop all processing. Removing it deletes its local storage.
- On the backend, delete events and contacts by deleting `/data` (the Docker volume).

## Children

Survey Anything is not directed at children and has no accounts.

## Changes

Changes to this policy are made in this file, in the public repository, with the date below.

Last updated: 2026-11-09.
