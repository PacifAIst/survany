# Human-approved device actions (T3)

Survey Anything can propose a device action when it sees something (turn on the porch light when someone
is at the back door, sound a siren on smoke). **It never runs one on its own.** Every action waits for a
person to tap **Approve** on a Telegram card, and anything that is not tapped in time is denied.

This page covers pairing the gate, writing the policy, connecting Home Assistant through ha-mcp, and what
the system can never be made to do.

## How a proposal travels

```text
extension                         backend                       confirm-gate-mcp            ha-mcp
---------                         -------                       ----------------            ------
confirmed alert sent
Reasoner (text only, no frame) -> POST /api/actions/propose
  suggests {tool, args}           policy.yaml check
  checked against the tool list   asks the gate to hold it   ->  holds the call (pending)
                                  renders the card itself
                                  Telegram card to approvers
                                  [Approve] [Deny]
                     human taps Approve in a private chat
                                  checks the tapper is an
                                  approver, in that chat
                                  signs evidence (HMAC)       ->  checks signature, nonce,
                                                                  arguments; executes         -> runs the tool
                                  card edited: "Executed"
```

- The Reasoner is a model (any provider, text-only is fine) that receives the confirmed detection and the
  list of tools the policy allows. It never receives an image, holds no MCP connection, no gate key, no
  device key and no nonce. Its answer is untrusted data: the extension accepts exactly one offered tool
  with exactly its declared, well-typed arguments, and the backend checks it again against the policy.
- The card text comes from the policy's `card` template and the validated arguments, never from model
  text. The approval is bound to a hash of the tool and arguments, and the gate re-checks the arguments
  when it executes.
- Only a Telegram tap approves. Email never carries an approval, group chats are refused, and a tap
  counts only from a contact with the `approver` role, in the private chat the card was sent to.

## What you need

- A backend (T1) with Telegram configured and the owner paired on Telegram.
- An MCP server that executes actions. The examples use ha-mcp for Home Assistant; any MCP server that
  speaks Streamable HTTP works.
- In the extension: an `approver` contact, Telegram among the alert channels, and a Reasoner provider.

## 1. Start the gate and pair the backend with it

The gate is [confirm-gate-mcp](https://github.com/Prashant-thakur77/confirm-gate-mcp) 0.8.0 (MIT), built
from `deploy/gate/Dockerfile` with pinned versions.

1. In `deploy/.env` set:
   - `GATE_AGENT_TOKEN`: a long random string. `pnpm gen-secrets` fills it (and every other empty
     secret) in `deploy/.env`. Only the backend and the gate use it.
   - `GATE_UPSTREAM_URL`: the MCP server the gate forwards approved calls to (see step 3).
2. Start it: `docker compose --profile gate up -d gate`
3. The gate prints a one-time 6-digit pairing code when it starts: `docker compose logs gate`.
4. Within 10 minutes, pair the backend as the gate's device, then restart the backend:

   ```bash
   docker compose exec backend node dist/cli.js gate-pair <code>
   docker compose restart backend
   ```

   The backend prints `Paired with the gate as d_…`. It now holds the gate's device key and signs every
   approval with it. Nothing else does.
5. In the extension's Options page: tick **Human-approved actions → Enabled**, pick a **Reasoner**
   provider and model, and make sure the owner (or another contact) has the **approver** role. Saving is
   refused if Telegram is not an alert channel or nobody is an approver.

## 2. Write the policy

`deploy/gate/policy.yaml` decides which tools exist and with which arguments. The backend refuses any
proposal that does not match it, and the Reasoner is only ever shown what it allows.

```yaml
version: 1
pendingTtlSeconds: 120          # approval window; no tap within it means deny
tools:
  - name: ha_call_service
    card: "{service} on {entity_id}"   # the approver sees this, filled with the validated arguments
    entityArg: entity_id
    args:
      service:
        type: string
        enum: [light.turn_on, light.turn_off, siren.turn_on, siren.turn_off]
      entity_id:
        type: string
        pattern: '^[a-z_]+\.[a-z0-9_]+$'
    entities:
      allow: ["light.*", "siren.*"]  # wildcards are fine for ordinary entities
      deny: ["switch.main_power"]
      allowSensitive: []             # locks and alarms, listed one by one (see below)
```

- `args` are closed: an argument that is not declared is refused, and every value is type-checked and
  matched against `enum`, `pattern` or `min`/`max`.
- **Keep `pendingTtlSeconds` equal to `mcp.approvalTimeoutSec` in the extension, and at most 120.**
  confirm-gate-mcp 0.8.0 forgets a held call after a fixed 120 s; a longer card would let a tap arrive
  after the gate has dropped the call. The backend denies on its own timer either way.
- Tools whose names match the gate's `--high-risk` list (`lock*,unlock*,*disarm*` in the shipped image)
  need a second, separate Approve within 60 s. The card keeps its buttons and says so.
- After editing the policy, restart the backend. The extension reads the tool list from
  `GET /api/actions/tools` on every proposal, so it follows the new policy at once.

## 3. Connect Home Assistant through ha-mcp

The recommended chain is **backend → confirm-gate-mcp → ha-mcp**. Point `GATE_UPSTREAM_URL` at ha-mcp's
HTTP address. The ha-mcp add-on prints it in its log, in the form `http://<home-assistant-host>:9583/private_<secret>`;
the secret path is the credential, so keep it out of anything you share.

Then, in the ha-mcp add-on:

- Set **`enable_tool_security_policies: true`**. ha-mcp then holds high-stakes calls (locks, alarms,
  automation writes) until someone clicks Approve in ha-mcp's own **Tool Security Policies** tab. That
  is a second hold, independent of the Telegram tap, and both must pass.
- Leave **`enable_security_policy_tool: false`** (the default). When it is on, connected agents can read
  and rewrite ha-mcp's security policies.

Why not let ha-mcp's own approval be the only check? Its approval happens in its settings UI or through
Home Assistant events plus a PIN, with no external signature, and its own FAQ notes that an agent with
enough access could obtain that PIN. Any connected MCP client is a trusted principal to it, and a later
bypass report was closed without a fix (ha-mcp issue 1990). The gate in front of it is what makes the
human tap the only way to execute. Sources: PLAN §2 C8, S18–S21.

## 4. Check it

- `curl -H "authorization: Bearer <device token>" https://<backend>/api/actions/tools` lists the tools
  the Reasoner will be offered (`enabled: false` means the backend is not paired with a gate).
- The end-to-end test runs the whole chain against the real gate container, with the extension in a
  browser, a fake Home Assistant that logs what it executes, and a fake Telegram:

  ```bash
  pnpm --filter @survey-anything/extension build:e2e
  pnpm --filter @survey-anything/extension exec playwright test -c e2e/m6/m6.config.ts
  ```

  Evidence lands in `bench/reports/m6-e2e.json`. The backend-only adversarial suite against the same
  gate is `pnpm vitest run -c apps/backend/vitest.docker.config.ts` (`bench/reports/m6-gate.json`).

## What the system can never be made to do

These hold whatever the policy file, the Reasoner, an image in front of the camera or an imported recipe
says:

| Never | Enforced by |
|---|---|
| Execute anything without a human tap. No tap in time means deny. | backend approvals (SG-01) |
| Let the model approve, or give it an MCP connection, gate key, device key or nonce. | backend proposer, extension `sw/actions.ts` (SG-02) |
| Show the approver text written by a model. The card comes from the policy template and validated arguments. | backend card renderer (SG-03) |
| Accept a tap from someone who is not an approver, from another chat, or from a group chat. | Telegram webhook (SG-04) |
| Run anything when the gate cannot be reached. It denies and tells the owner. | gate client (SG-05) |
| Call emergency services (police, fire brigade, ambulance, 911/112/999, panic dialing). Refused in code, and no policy entry can enable it. | backend policy (SG-06) |
| Lock, unlock or disarm through a wildcard. Each lock or alarm entity must be listed exactly in `allowSensitive`. | backend policy (SG-06) |
| Approve by email. | design (D5); email has no approval links |
| Send a frame to the Reasoner. | extension network boundary (SG-15) |

Things this design does **not** protect against, stated plainly:

- A fully compromised backend holds the gate's device key and can sign approvals. Keep the backend host
  patched and its `.env` private. See `docs/THREAT_MODEL.md`.
- Anyone who can tap Approve on the approver's unlocked phone can approve. Telegram is the second factor
  here, so protect it (passcode, two-step verification).
- The policy is yours. If you allow `switch.*` and a switch powers a door strike, the policy allows it.
