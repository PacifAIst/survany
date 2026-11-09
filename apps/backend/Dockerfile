# Survey Anything backend. Build from the repository root:
#   docker build -f apps/backend/Dockerfile -t survey-anything/backend .
FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8 AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
# The root postinstall fetches the extension's ONNX model, which the backend does not use: present but skipped.
ENV SA_SKIP_MODEL_FETCH=1
COPY scripts/fetch-model.ts scripts/
COPY packages/shared/package.json packages/shared/
COPY packages/providers/package.json packages/providers/
COPY packages/recipes/package.json packages/recipes/
COPY apps/backend/package.json apps/backend/
RUN pnpm install --frozen-lockfile --filter @survey-anything/backend...
COPY packages ./packages
COPY apps/backend ./apps/backend
RUN pnpm --filter @survey-anything/backend build \
 && pnpm --filter @survey-anything/backend deploy --prod --legacy /out \
 && cp -r apps/backend/dist /out/dist

FROM node:24-alpine@sha256:a34ab6d7f6f4813f4d0c5469d74685604b962fbdbf5793a7bc7b4998ecb867c8
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
# The data directory belongs to the unprivileged user; named volumes inherit this ownership.
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 8080
LABEL org.opencontainers.image.source="https://github.com/PacifAIst/survany" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server.js"]
