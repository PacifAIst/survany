# Hosting the viewer on Cloudflare Pages: not as it stands

Checked on 2026-11-09 against the code. **Do not point Pages at the viewer yet**; it would deploy but not work.

## Why

1. **The viewer calls the backend on its own origin.** `apps/viewer/src/api.ts` posts to relative paths
   (`/api/viewer/telegram`, `/api/viewer/email`, `/api/viewer/report`, `/api/pin/setup`, `/api/ack/email`).
   Caddy routes those to the backend because the viewer and the API share `PUBLIC_HOST`. Served from a
   `*.pages.dev` (or any other) origin, every live-view grant, PIN check, acknowledgement and failure report
   would hit Pages and fail.
2. **Viewer links point at the backend host.** The backend builds links as `PUBLIC_BASE_URL/v/?t=…`, so alerts
   would keep sending people to Caddy anyway.
3. **Security headers come from Caddy.** The viewer's CSP (with the deployment's `LIVE_CONNECT_SRC`),
   `Referrer-Policy: no-referrer`, `Permissions-Policy` and `Cache-Control: no-store` are set in
   `deploy/Caddyfile`. Pages can serve headers from a `_headers` file, but `LIVE_CONNECT_SRC` differs per
   deployment.
4. **Tokens in the query string.** Viewer links carry a token in `?t=`. Caddy's logs are off or query-stripped
   on these routes (SG-27). A hosted CDN logs request URLs on its side.
5. The build uses `base: '/v/'`, so it expects to be served under `/v/`.

## What it would take

- A configurable API origin for the viewer (for example `apiBase` in `viewer-config.json`) and CORS on those
  five backend routes for the Pages origin.
- A separate `VIEWER_BASE_URL` in the backend for the links it sends.
- A generated `public/_headers` with the CSP for the deployment.
- A decision on point 4 (tokens reaching Cloudflare's logs).

The gain would be that the viewer page loads even when the whole server is down. Today it already loads
when only the backend is down, because Caddy serves it from disk (§10).

## Dashboard settings, once the changes above exist

| Setting | Value |
|---|---|
| Framework preset | None |
| Root directory | `/` (repository root) |
| Build command | `corepack enable && pnpm install --frozen-lockfile && pnpm --filter @survey-anything/viewer build` |
| Build output directory | `apps/viewer/dist` |
| Environment variables | `NODE_VERSION=24`, `SA_SKIP_MODEL_FETCH=1` (the root postinstall otherwise downloads the 20 MB extension model, which the viewer does not use) |
