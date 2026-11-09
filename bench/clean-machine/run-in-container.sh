#!/usr/bin/env bash
# Copyright (C) 2026 PacifAIst
# SPDX-License-Identifier: AGPL-3.0-only
# M7 acceptance "README quickstart run from a clean machine". Runs inside a fresh node:24-bookworm
# container with nothing cached: clones the public repository and follows README.md "Try it in about
# five minutes" step 1 verbatim, then drives steps 2-5 with the quickstart test (Chromium's fake camera
# plays the demo's fire scene, because automation cannot click the toolbar button).
#
#   docker run --rm --shm-size 2g -e COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
#     -v "$PWD/bench/clean-machine:/harness:ro" -v "<an empty dir>:/out" node:24-bookworm@sha256:<digest> \
#     bash /harness/run-in-container.sh <git ref>
set -euo pipefail
REF="${1:-main}"
log() { echo "[$(date -u +%H:%M:%S)] $*" | tee -a /out/steps.log; }
start=$(date +%s)
log "node $(node -v), $(uname -sm), ref ${REF}"

log "README step 1: git clone"
git clone --quiet https://github.com/PacifAIst/survany /w/survany
cd /w/survany
git checkout --quiet "$REF"
log "cloned $(git rev-parse --short HEAD)"

log "README step 1: corepack enable"
corepack enable
log "README step 1: pnpm install"
pnpm install 2>&1 | tail -20 | tee -a /out/install.log
log "README step 1: pnpm build"
pnpm build 2>&1 | tail -30 | tee -a /out/build.log
test -f apps/extension/dist/manifest.json
log "built apps/extension/dist ($(du -sh apps/extension/dist | cut -f1))"

log "README steps 2-5, automated: install Chromium for Playwright"
pnpm --filter @survey-anything/extension exec playwright install --with-deps chromium > /out/playwright-install.log 2>&1
log "README steps 2-5, automated: quickstart test"
set +e
pnpm --filter @survey-anything/extension exec playwright test -c e2e/playwright.config.ts quickstart 2>&1 | tee /out/quickstart.log
status=${PIPESTATUS[0]}
set -e
log "quickstart exit ${status}; total $(( $(date +%s) - start )) s"
exit "$status"
