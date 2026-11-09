# confirm-gate-mcp (MIT, PyPI 0.8.0) holds proposed actions until the backend, as its paired device,
# submits signed evidence of a human tap (PLAN C8, §6.5). The LLM never connects here.
FROM python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90
# mcp is pinned to a release older than 14 days (confirm-gate-mcp allows mcp>=2.1,<3).
RUN pip install --no-cache-dir "confirm-gate-mcp==0.8.0" "mcp==2.3.0"
# The data directory belongs to the unprivileged user; named volumes inherit this ownership.
RUN mkdir -p /data && chown nobody:nogroup /data
USER nobody
WORKDIR /data
EXPOSE 8800
# --upstream points at the MCP server that executes actions (e.g. ha-mcp). The gate's pending window
# (Gate.pending_ttl) is 120 s; keep pendingTtlSeconds in policy.yaml at or below it (see README.md).
CMD ["sh", "-c", "confirm-gate serve --host 0.0.0.0 --port 8800 --db /data/gate.db --token \"$GATE_AGENT_TOKEN\" --upstream \"$GATE_UPSTREAM_URL\" --high-risk 'lock*,unlock*,*disarm*'"]
