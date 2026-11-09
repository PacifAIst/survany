# Contributing to Survey Anything

**Every contributor must sign the [Contributor License Agreement](CLA.md) before their first pull request can be merged.** The CLA bot (`.github/workflows/cla.yml`) comments on your first PR; reply with the sentence it asks for and it records your signature. We use a CLA rather than a DCO on purpose: a DCO leaves copyright scattered across every contributor, which would block the project from ever relicensing or changing stewardship. The CLA keeps your copyright with you while granting the project the rights it needs. No exceptions, including for one-line fixes.

## Ground rules

- Read [docs/PLAN.md](docs/PLAN.md). It is the authoritative spec. Changes that contradict it need a plan change first.
- Product boundaries are permanent (§1.2): no face recognition, person re-identification, emotion inference, stealth or hidden-indicator modes, audio capture, or autonomous contact with emergency services. PRs adding these, even behind a flag, will be closed.
- Every security gate in [§7](docs/PLAN.md#7-security-gate-register) carries a `SECURITY-GATE SG-xx:` comment in code and a test that names it. CI fails if one is missing for a completed milestone.
- No raw `fetch` in the extension or provider packages: use `guardedFetch` (SG-14). Lint enforces this.
- Never hardcode a model ID outside `packages/shared/src/defaults.ts`.
- No TODOs or stubs in merged code. Strict TypeScript, tests for behavior changes.

## Development

```bash
pnpm install
pnpm --filter @survey-anything/extension fetch-assets   # models + ORT WASM, checksum-verified
pnpm -r build
pnpm lint && pnpm typecheck && pnpm test && pnpm check
```

Requirements: Node 24 LTS, pnpm 10, Chromium ≥ 120 for the extension, Docker for `deploy/`.

## Recipes: the easiest first PR

A watch recipe is a single JSON file in `packages/recipes/recipes/`. Use the recipe PR template. Recipes are data only: they cannot change routing, egress or actions (SG-18), and the schema rejects any key that tries.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Do not open public issues for vulnerabilities.
