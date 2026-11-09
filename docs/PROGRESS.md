# Survey Anything: Progress

**Goal:** v1.0 as defined at the end of §8 of docs/PLAN.md
**Current milestone:** M0
**Last updated:** 2026-11-09 08:52

## Milestones
| ID | Status (todo/doing/done) | Acceptance evidence | Notes |
|----|--------------------------|---------------------|-------|
| M0 | doing | Local: `pnpm install && pnpm -r typecheck && pnpm lint && pnpm vitest run` → 101 tests passed (scripts 11, shared 45, recipes 14, providers 31). CI run pending. | shared, recipes and providers packages were started early because every later milestone depends on them |
| M1 | todo | | |
| M2 | todo | | |
| M3 | doing | Provider contract tests against a real mock HTTP server: 31 passed (request shape per adapter, error mapping, C25 retry, probe refuses text-only mock, failover order) | Remaining: guardedFetch, budget persistence, Options page, import/export |
| M4 | todo | | |
| M5 | todo | | |
| M6 | todo | | |
| M7 | todo | | |
| M8 | todo | | |

## Security gates
| SG | Code marker | Test | Status |
|----|-------------|------|--------|
| SG-01 | | | todo |
| SG-02 | | | todo |
| SG-03 | | | todo |
| SG-04 | | | todo |
| SG-05 | | | todo |
| SG-06 | | | todo |
| SG-07 | | | todo |
| SG-08 | packages/shared/src/callback.ts | packages/shared/test/security.test.ts (5,000-iteration property test) | marker+test |
| SG-09 | | | todo |
| SG-10 | | | todo |
| SG-11 | | | todo |
| SG-12 | | | todo |
| SG-13 | | | todo |
| SG-14 | eslint.config.js (raw fetch ban) | | partial |
| SG-15 | | | todo |
| SG-16 | | | todo |
| SG-17 | packages/shared/src/sanitize.ts | packages/shared/test/security.test.ts | marker+test |
| SG-18 | packages/recipes/src/schema.ts | packages/recipes/test/recipes.test.ts | marker+test |
| SG-19 | | | todo |
| SG-20 | | | todo |
| SG-21 | packages/shared/src/secrets.ts | packages/shared/test/security.test.ts | marker+test |
| SG-22 | | | todo |
| SG-23 | | | todo |
| SG-24 | | | todo |
| SG-25 | | | todo |
| SG-26 | | | todo |
| SG-27 | packages/shared/src/viewer-meta.ts | packages/shared/test/security.test.ts | partial (viewer rendering pending) |

## Failure matrix
| Row (§10) | Test | Status |
|-----------|------|--------|
| OME stream does not start in 5 s | | todo |
| Viewer cannot establish WebRTC | | todo |
| Every alert: parallel redundant send | | todo |
| Telegram error | | todo |
| Email error | | todo |
| All configured channels fail | | todo |
| Zero channels configured | packages/shared/test/config.test.ts (min(1) rejected at save) | partial (refuse-to-arm pending) |
| Backend unreachable | | todo |
| Viewer backend unreachable | | todo |
| Provider timeout, 429, 5xx, parse error | packages/providers/test/adapters.test.ts "failover chain" | done |
| All providers fail | packages/providers/test/adapters.test.ts (AllProvidersFailedError) | partial (unconfirmed alert path pending) |
| Budget exhausted | | todo |
| MCP gate unreachable | | todo |
| Camera lost, track ended, frozen or black frames | | todo |
| Browser or host dies while armed | | todo |
| Browser restart with a tab source | | todo |
| Offscreen document crash | | todo |
| WebGPU device lost | | todo |
| OME admission webhook failing | | todo |

## Needs human
- [ ] **Repo slug decision (D1).** The plan names `PacifAIst/survey-anything`; development happens in `PacifAIst/survany` as instructed. The `survey-anything` slug is currently free (checked 2026-11-09 with `gh repo view`). Decide whether to rename the repo; the CLA workflow and `SOURCE_URL` in `packages/shared/src/defaults.ts` point at `survany` and must change with it.
- [ ] **CLA legal review (§13, D3).** Have counsel review `CLA.md` and confirm the steward entity name before the first external merge. Record the review here.

## Decisions and deviations from PLAN.md
| Date | Change | Why | Reversible? |
|------|--------|-----|-------------|
| 2026-11-09 | D1, D3 locked; alerts.channels made user-editable with min(1); review gaps 15–24 folded in. | Plan review before M0 | D1, D3: no |
| 2026-11-09 | v1.2: coturn removed (D11); viewer metadata carried in URL query string (SG-27); PIN re-pairing rationale corrected; OME `TcpRelay` + `doctor` and an arm-time WHIP probe replace coturn. | Topology review — TURN solves a problem the browser→SFU path does not have; `TcpRelay` covers UDP-blocked viewers. | D11: reversible (add coturn back if a real failure mode appears) |
| 2026-11-09 | Repository is `github.com/PacifAIst/survany`, not `survey-anything`. Product name stays "Survey Anything" (D1 untouched). | Owner instruction at kickoff. | Yes (GitHub rename + two URLs) |
| 2026-11-09 | Config schema additions beyond §6.2: `provider*.timeoutMs` (default 20000, max 25000), `alerts.nonRedundantAck`, `backend.url`, `direct.telegram`, `direct.email` (T0 HTTP mail adapter = Resend). All default so the §6.2 sample validates verbatim (tested). | §6.2 requires a stored single-channel acknowledgement; T0 needs bot token and mail key refs; proxyMode needs a backend URL to validate "loopback only". | Yes |
| 2026-11-09 | Recipe gate schema adds optional `requireClasses`, `minCount`, `requireMotion`, `region` to `detector`; `pixelDelta` and `region` to `motion`; `mode`/`targetColor` to `region-diff`; `everyMinutes` to `sampled`. | §6.3 names the gate types but not their parameters; the built-ins (robbery = person + motion, queue = count, restricted zone = region) need them. | Yes |
| 2026-11-09 | Failover advances on every provider error kind, not only the §6.1 list (adds network, bad-request, blocked). | Fail safe: a misconfigured provider must not block the rest of the chain. Superset of the plan. | Yes |
| 2026-11-09 | Parsed `confidence` values from 2 to 100 are read as percentages; values in (1, 2) are clamped to 1. | Some local models answer "85". | Yes |
| 2026-11-09 | `pnpm-workspace.yaml` sets `minimumReleaseAge: 20160` (14 days). | Supply-chain guard: never resolve a just-published version. | Yes |

## External facts checked
| Date | API or library | Version or doc URL | Result |
|------|----------------|--------------------|--------|
| 2026-11-09 | Anthropic Messages API version | S32 https://platform.claude.com/docs/en/api/migration-2026-10-21 | Confirmed: `anthropic-version: 2026-10-21`; `temperature`, `top_p`, `top_k` return 400 even at default values. Top-level `system` unchanged. Adapter sends none of the three (tested). |
| 2026-11-09 | OME AdmissionWebhooks | S11 https://ovenmedia.com/docs/ome/access-control/admission-webhooks | Confirmed: `X-OME-Signature` = HMAC-SHA1 over body, base64url; request `client{address,port,real_ip,user_agent}`, `request{direction,protocol,status,url,new_url?,time}`; opening response `{allowed,new_url?,lifetime(ms),reason?}`; closing response `{}`; `<Enables><Providers>`/`<Publishers>`. |
| 2026-11-09 | confirm-gate-mcp device API | S17 https://github.com/Prashant-thakur77/confirm-gate-mcp/blob/main/docs/API.md | Confirmed routes `POST /device/pair {code,name}`→`{device_id,user_id,key,name}`, `GET /device/pending` (cards with `nonce`), `POST /device/evidence {pending_id,nonce,kind:"tap",option}` or `answer:"yes"/"no"`→`{evidence_ref,decision}`, `POST /device/confirm {pending_id,evidence_ref}`, `GET /device/receipts`. Headers `x-device-id`, `x-timestamp`, `x-signature`; signature HMAC-SHA256(key, METHOD\nPATH(+query)\nTIMESTAMP\nSHA256(BODY)), ±60 s, single use. `pending_ttl` default 120 s is a `Gate` class attribute (override by subclassing). Docs do not state the hex/base64 encoding of signature and body hash: M6 must confirm from source. |
| 2026-11-09 | YOLOX ONNX | S23 https://huggingface.co/Heliosoph/yolox-onnx | Apache-2.0; `yolox_tiny.onnx` present (Megvii's published checkpoint, ~20 MB). Output is raw grid predictions `[1, N, 85]`, needs grid/stride decode. Input size must be read from the model (Megvii tiny/nano use 416). |
| 2026-11-09 | D-Fire dataset | S24 https://github.com/gaiasd/DFireDataset (LICENSE file) | Confirmed CC0 1.0 Universal in the repo LICENSE file. |

## Session log (newest first)
### 2026-11-09: kickoff, M0 scaffold, shared/recipes/providers
- Done: cloned the empty repo; saved PLAN.md; pnpm monorepo with strict TS, ESLint (SG-14 raw-fetch ban), Vitest projects; AGPL-3.0 LICENSE (from the GitHub licenses API); CONTRIBUTING (CLA in first paragraph), CLA.md, SECURITY.md, PR and issue templates; CI and CLA workflows with actions pinned by commit SHA; `check-security-gates`, `check-licenses`, `check-alarm-period`, `gen-secrets`; `packages/shared` (config schema v1, callback codec, sanitize, viewer metadata, redaction, host classification, wire contracts); `packages/recipes` (strict schema, 10 built-ins); `packages/providers` (5 adapters, one prompt, defensive parse, PNG probe, failover, reasoner).
- Tests run: `pnpm vitest run` → 101 passed. `pnpm -r typecheck` clean. `pnpm lint` clean.
- Next: push, confirm CI; M1 extension capture and scan loop.
- Blockers: none.
