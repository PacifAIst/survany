## New watch recipe

- Recipe id: `...`
- What it watches for, in one sentence:
- Gate type (`detector` / `motion` / `region-diff` / `sampled`) and why:
- Tested against (describe the tab or camera scene; no faces of people who did not consent):

### Checklist

- [ ] One JSON file in `packages/recipes/recipes/<id>.watch.json`
- [ ] `pnpm --filter @survey-anything/recipes test` passes (schema, SG-18)
- [ ] The confirm prompt asks about the scene, not about identities (no face recognition, re-identification or emotion inference, §1.2)
- [ ] I have signed the CLA

Credit line for the README gallery (name or handle):
