# confirm-gate-mcp (MIT, PyPI 0.8.0) holds proposed actions until the backend, as its paired device,
# submits signed evidence of a human tap (PLAN C8, §6.5). The LLM never connects here.
FROM python:3.13-slim@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90
RUN pip install --no-cache-dir "confirm-gate-mcp==0.8.0"
USER nobody
WORKDIR /data
EXPOSE 8800
# --upstream points at the MCP server that executes actions (e.g. ha-mcp). The pending window
# (Gate.pending_ttl, default 120 s) must equal mcp.approvalTimeoutSec; see README.md here.
CMD ["sh", "-c", "confirm-gate serve --host 0.0.0.0 --port 8800 --db /data/gate.db --token \"$GATE_AGENT_TOKEN\" --upstream \"$GATE_UPSTREAM_URL\" --high-risk 'lock*,unlock*,*disarm*'"]
