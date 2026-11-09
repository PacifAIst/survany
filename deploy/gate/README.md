# Human-approved actions (T3)

Chain: `backend → confirm-gate-mcp → your MCP server (e.g. ha-mcp)`. The model only proposes; the
backend validates the proposal against `policy.yaml`, asks the gate to hold it, renders the approval
card itself, and only a human tap in Telegram makes the backend submit signed evidence.

1. Set `GATE_AGENT_TOKEN` (any long random string) and `GATE_UPSTREAM_URL` in `deploy/.env`.
2. `docker compose --profile gate up -d gate`
3. The gate prints a 6-digit pairing code on start (`docker compose logs gate`). Pair the backend as
   the gate's device, within 10 minutes:
   `docker compose exec backend node dist/cli.js gate-pair <code>`, then `docker compose restart backend`.
4. Keep `pendingTtlSeconds` in `policy.yaml` (default 120) equal to `mcp.approvalTimeoutSec` in the
   extension, and no higher than the gate's `pending_ttl`: confirm-gate-mcp 0.8.0 fixes it at 120 s (a
   `Gate` class attribute with no CLI flag). The backend denies on its own timeout either way.
   Verified end to end against the real 0.8.0 container: `pnpm vitest run -c apps/backend/vitest.docker.config.ts`
   (`bench/reports/m6-gate.json`).
5. For ha-mcp, also enable `enable_tool_security_policies: true` so ha-mcp adds its own independent
   hold (S21).

What the policy can never do: enable emergency-service calls (refused in code), or allow
lock/unlock/disarm through a wildcard (each sensitive entity must be listed exactly in
`allowSensitive`). See `docs/MCP_PAIRING.md`.
