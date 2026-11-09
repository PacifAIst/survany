# Human-approved actions (T3)

Chain: `backend → confirm-gate-mcp → your MCP server (e.g. ha-mcp)`. The model only proposes; the
backend validates the proposal against `policy.yaml`, asks the gate to hold it, renders the approval
card itself, and only a human tap in Telegram makes the backend submit signed evidence.

1. Set `GATE_AGENT_TOKEN` (any long random string) and `GATE_UPSTREAM_URL` in `deploy/.env`.
2. `docker compose --profile gate up -d gate`
3. The gate prints a 6-digit pairing code on start (`docker compose logs gate`). Pair the backend as
   the gate's device, within 10 minutes:
   `docker compose exec backend node dist/cli.js gate-pair <code>`, then `docker compose restart backend`.
4. Keep `pendingTtlSeconds` in `policy.yaml`, `mcp.approvalTimeoutSec` in the extension, and the gate's
   `pending_ttl` equal. confirm-gate-mcp's default `pending_ttl` is 120 s (a `Gate` class attribute);
   the backend enforces its own timeout and denies on expiry either way.
5. For ha-mcp, also enable `enable_tool_security_policies: true` so ha-mcp adds its own independent
   hold (S21).

What the policy can never do: enable emergency-service calls (refused in code), or allow
lock/unlock/disarm through a wildcard (each sensitive entity must be listed exactly in
`allowSensitive`). See `docs/MCP_PAIRING.md`.
