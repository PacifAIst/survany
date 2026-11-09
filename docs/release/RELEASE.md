# Release 1.0.0: review list and commands (draft)

Nothing in this file has been run against GitHub, a registry or the Chrome Web Store. The local steps
(build, pack, SBOM, digests) were dry-run on 2026-11-09; the outward-facing steps are marked **OUTWARD** and
wait for the owner.

## Review list (owner)

1. **Scope of 1.0.0.** `docs/PROGRESS.md`: every milestone M0–M7 is done; the open items are on Needs human
   (cloud providers other than OpenRouter, the clip set, a manual demo with a real tab, real-phone and
   VPS checks for live view).
2. **Version number.** All packages are `0.1.0`; the extension's manifest version comes from
   `apps/extension/package.json`. Decide `1.0.0` (plan) or a `0.9.x` preview while the Needs-human items
   are open.
3. **Chrome Web Store answers.** `docs/release/CWS_LISTING.md`: single purpose, permission
   justifications, data categories (three **Decide** items: category, camera frames, policy URL).
4. **Privacy policy and responsible use.** `docs/PRIVACY_POLICY.md`, `docs/RESPONSIBLE_USE.md` (dated
   2026-11-09). Not legal advice: have counsel read them with the CLA (Needs human).
5. **SBOM.** `release/sbom.cdx.json` (CycloneDX 1.5): production npm packages, bundled models and WASM with
   SHA-256, pinned images. Generated per commit by `pnpm sbom`.
6. **Licenses.** `THIRD_PARTY_LICENSES.md` (generated) and `pnpm check` (license allowlist, media-plane
   rule). OvenMediaEngine is AGPL-3.0, as is this repository.
7. **Image digests.** `docs/release/IMAGE_DIGESTS.md`: every third-party image is pinned by digest. The two
   images built from this repository get digests when they are built and pushed.
8. **Container registry.** **Decide** whether to publish `survey-anything/backend` and
   `survey-anything/confirm-gate` to GHCR, or keep "build from source" (the compose file builds the backend
   from the repository today).
9. **CRX.** A `.crx` needs a signing key that must be kept forever. Chrome installs CRX files only from the
   Web Store (or by enterprise policy), so for most users the zip ("Load unpacked") and the Store listing are
   what matter. **Decide** whether to ship a CRX at all; if yes, create and store the key offline.
10. **Release notes.** `docs/release/RELEASE_NOTES.md` (draft).
11. **Known compromises.** `docs/PROGRESS.md` "Known compromises" (the 20 MB ONNX in git history).
12. **Rotate the OpenRouter key** that was pasted into the development conversation on 2026-11-09.

## Commands

### 1. Preconditions (local, read-only)

```bash
git switch main && git pull --ff-only
gh run list --branch main --limit 4            # the latest ci and secrets runs must be green
pnpm install --frozen-lockfile                  # also fetches and verifies the fire/smoke model
pnpm typecheck && pnpm lint && pnpm test && pnpm check
pnpm --filter @survey-anything/extension e2e    # browser suite
pnpm bench                                      # fails if the fire model is below the retrain floor
```

### 2. Version (local commit; pushing it is OUTWARD)

```bash
for p in package.json apps/*/package.json packages/*/package.json; do
  node -e "const f='$p',j=require('./'+f);j.version='1.0.0';require('fs').writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
done
git commit -am "Release 1.0.0"
```

### 3. Artifacts from a clean clone (local)

```bash
git clone https://github.com/PacifAIst/survany /tmp/sa-1.0.0 && cd /tmp/sa-1.0.0
git checkout <release commit>
corepack enable && pnpm install --frozen-lockfile && pnpm build
pnpm pack:extension          # release/survey-anything-extension-1.0.0.zip + .sha256 (deterministic)
pnpm sbom                    # release/sbom.cdx.json
pnpm release:digests         # must print "all pinned by digest"
pnpm licenses:third-party
# Reproducibility: a second clean clone must print the same zip sha256.
```

### 4. Container images (OUTWARD, only if item 8 says publish)

```bash
docker build -f apps/backend/Dockerfile -t ghcr.io/pacifaist/survey-anything-backend:1.0.0 .
docker build -t ghcr.io/pacifaist/survey-anything-gate:1.0.0 deploy/gate
docker push ghcr.io/pacifaist/survey-anything-backend:1.0.0
docker push ghcr.io/pacifaist/survey-anything-gate:1.0.0
docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/pacifaist/survey-anything-backend:1.0.0
docker inspect --format '{{index .RepoDigests 0}}' ghcr.io/pacifaist/survey-anything-gate:1.0.0
# Record both digests in docs/release/IMAGE_DIGESTS.md and pin them in deploy/docker-compose.yml.
```

### 5. Tag and GitHub release (OUTWARD)

```bash
git tag -s v1.0.0 -m "Survey Anything 1.0.0"
git push origin main v1.0.0
gh release create v1.0.0 --verify-tag --title "Survey Anything 1.0.0" \
  --notes-file docs/release/RELEASE_NOTES.md \
  release/survey-anything-extension-1.0.0.zip \
  release/survey-anything-extension-1.0.0.zip.sha256 \
  release/sbom.cdx.json
```

### 6. M8 acceptance: the tagged release installs from its artifacts alone (local, after step 5)

```bash
mkdir -p /tmp/sa-verify && cd /tmp/sa-verify
gh release download v1.0.0 --repo PacifAIst/survany
sha256sum -c survey-anything-extension-1.0.0.zip.sha256
unzip -q survey-anything-extension-1.0.0.zip -d ext
# Load /tmp/sa-verify/ext unpacked in Chrome and follow README "Try it in about five minutes";
# or run the quickstart test against it from the repository:
#   SA_EXTENSION_DIST=/tmp/sa-verify/ext pnpm --filter @survey-anything/extension exec playwright test -c e2e/playwright.config.ts quickstart
```

### 7. Chrome Web Store (OUTWARD, owner in the dashboard)

Upload `release/survey-anything-extension-1.0.0.zip`, then fill the listing, privacy and permission tabs from
`docs/release/CWS_LISTING.md`.
