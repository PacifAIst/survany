# Deploying the backend and private live view

This is tiers T1 (backend) and T2 (live view with OvenMediaEngine). You need a Linux host with Docker, a
public IP address, and two DNS names pointing at it: one for the backend and viewer (`PUBLIC_HOST`), one
for live video signaling (`LIVE_HOST`).

## 1. Configure

```bash
git clone https://github.com/PacifAIst/survany && cd survany
cp deploy/.env.example deploy/.env
```

Fill the first block of `deploy/.env`: `PUBLIC_HOST`, `LIVE_HOST`, `PUBLIC_BASE_URL`, `ACME_EMAIL`, the
Telegram bot token and username (create the bot with @BotFather), and `SMTP_URL` / `MAIL_FROM` if you want
email. For live view also set `OME_ENABLED=true`, `OME_HOST_IP` (the host's public IP),
`OME_PUBLIC_HOST`, `OME_SIGNALING_BASE`, `OME_LLHLS_BASE` and `LIVE_CONNECT_SRC` (the examples show the
pattern). Then generate every random secret:

```bash
corepack enable && pnpm install && pnpm gen-secrets
```

`gen-secrets` fills empty secrets in `deploy/.env` and never overwrites a value that is already there.

## 2. Open the ports

| Port | Protocol | What | Through Caddy? |
|---|---|---|---|
| 80, 443 | TCP | HTTPS for the backend, viewer, OME signaling and LL-HLS (Let's Encrypt via Caddy) | yes |
| 3478 | TCP | OME's built-in TCP relay for viewers whose network blocks UDP | no, published directly |
| 10000 | TCP | ICE-TCP media | no |
| 10000-10003 | UDP | WebRTC media | no |

OME's REST API (8081) and its signaling port (3333) are **not** published: the API is reachable only
inside the compose network with its access token, and signaling only through Caddy, which checks the
stream token before OME sees the request.

## 3. Start

```bash
cd deploy
docker compose up -d                          # T1: backend + Caddy
docker compose --profile ome up -d            # T2: + OvenMediaEngine
```

Images are pinned by digest in `docker-compose.yml`. The backend image is built from this repository.

## 4. Check it from outside

From another network (a laptop on a phone hotspot is ideal):

```bash
pnpm doctor --public alerts.example.org --live live.example.org --ip 203.0.113.7
```

It checks that the backend answers over TLS, that OME signaling answers over TLS, that 3478/tcp and
10000/tcp accept connections, and that a WHIP publish **without** a token is refused (401 or 403). Any
`FAIL` line means live view is not ready; a publish that is not refused means the deployment is unsafe,
so stop OME until it is fixed. UDP cannot be tested without a real WebRTC session: when you arm with live
view on, the extension makes a short test publish of a black frame and warns if UDP is unavailable from
your network.

## 5. Pair the extension and the contacts

```bash
docker compose exec backend node dist/cli.js pair-device
```

Enter the printed 8-character code in the extension (Options → Backend → Pair a backend). Then, in
Options → Contacts, **Invite** each contact: they get a Telegram link to start the bot in a private chat
and a link to choose their PIN (6–8 digits; the email viewer asks for it). **Send test alert** checks each
channel per contact.

## How live view is protected

- Every viewer link is single-use, lasts at most 10 minutes, is bound to the first browser session that
  opens it, and is stored only as a hash. Each contact gets their own link per channel.
- The Telegram button opens a Mini App; the backend validates Telegram's signed `initData` and matches the
  user to the contact. The email link does nothing on GET (mail scanners cannot burn it); the contact's
  PIN is required, with rate limits and lockout.
- OME asks the backend's admission webhook before every publish and play; the backend denies anything it
  does not know, and OME denies when the webhook fails or hangs. Caddy's `forward_auth` refuses requests
  without a valid token before they reach OME, and fails closed when the backend is down. Both are tested
  against the pinned OME image (`bench/reports/m5-ome.json`).
- A stream ends when its lifetime runs out (also tested).
- The extension shows "Streaming to …" for as long as a stream is open, and the Stop button ends it.

## Viewers behind strict networks

Viewers try WebRTC over UDP first, then ICE-TCP on 10000, then OME's TCP relay on 3478, then LL-HLS over
443. If all fail, they see the event details from the link and "live view unavailable — contact the
owner", and the backend sends that contact the 10-second clip instead. A TURN server is **not** part of the
default stack: viewers connect to OME's public address, so carrier-grade NAT alone does not need one. If
your network topology does, add coturn or a hosted TURN service through OME's `<IceServers>` in
`deploy/ome/Server.xml`.

## When things fail

- **The stream does not start within 5 seconds:** the 10-second clip goes to every configured channel.
- **The backend is down:** the extension queues alerts and retries, shows a notification, and uses
  direct Telegram/email if configured. Viewer pages still show the event details from the link.
- **The browser or computer dies while armed:** after 3 missed heartbeats the backend alerts the owner.

## Licenses

OvenMediaEngine is AGPL-3.0-only, as is this repository. The viewer and backend link to the
corresponding source. Caddy (Apache-2.0) only terminates TLS for HTTP and signaling; media never passes
through it. See `THIRD_PARTY_LICENSES.md`.
