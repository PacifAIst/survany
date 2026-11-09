# Copyright (C) 2026 PacifAIst
# SPDX-License-Identifier: AGPL-3.0-only
"""
Test double for the MCP server that executes actions (stands in for ha-mcp in the M6 test).
Speaks MCP over stdio (newline-delimited JSON-RPC); confirm-gate-mcp spawns it with --upstream-cmd.
Every executed call is appended to $EXECUTIONS_PATH so the test can prove what ran and when.
No readOnlyHint is set, so confirm-gate treats the tool as a write and holds every call for a human.
"""

import json
import os
import sys
import time

EXECUTIONS = os.environ.get("EXECUTIONS_PATH", "/data/executions.jsonl")
TOOL = {
    "name": "ha_call_service",
    "description": "Call a Home Assistant service on one entity (test double).",
    "inputSchema": {
        "type": "object",
        "properties": {"service": {"type": "string"}, "entity_id": {"type": "string"}},
        "required": ["service", "entity_id"],
        "additionalProperties": False,
    },
}


def reply(msg_id, result=None, error=None):
    out = {"jsonrpc": "2.0", "id": msg_id}
    if error is not None:
        out["error"] = error
    else:
        out["result"] = result
    sys.stdout.write(json.dumps(out) + "\n")
    sys.stdout.flush()


for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    msg = json.loads(line)
    method = msg.get("method")
    msg_id = msg.get("id")
    if msg_id is None:
        continue  # notifications (e.g. notifications/initialized) need no answer
    params = msg.get("params") or {}
    if method == "initialize":
        reply(msg_id, {
            "protocolVersion": params.get("protocolVersion", "2025-06-18"),
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": {"name": "fake-home-assistant", "version": "1.0.0"},
        })
    elif method == "ping":
        reply(msg_id, {})
    elif method == "tools/list":
        reply(msg_id, {"tools": [TOOL]})
    elif method == "tools/call":
        name = params.get("name")
        args = params.get("arguments") or {}
        if name != TOOL["name"]:
            reply(msg_id, {"content": [{"type": "text", "text": f"unknown tool {name}"}], "isError": True})
            continue
        with open(EXECUTIONS, "a", encoding="utf-8") as fh:
            fh.write(json.dumps({"at": time.time(), "tool": name, "arguments": args}) + "\n")
        reply(msg_id, {"content": [{"type": "text", "text": f"ok: {args.get('service')} on {args.get('entity_id')}"}], "isError": False})
    else:
        reply(msg_id, error={"code": -32601, "message": f"method not found: {method}"})
