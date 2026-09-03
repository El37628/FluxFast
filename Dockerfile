# syntax=docker/dockerfile:1

ARG NODE_IMAGE=docker.io/library/node:24.19.0-bookworm-slim

FROM ${NODE_IMAGE} AS builder

ENV NEXT_TELEMETRY_DISABLED=1 \
    FLUXFAST_STANDALONE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    PYTHONDONTWRITEBYTECODE=1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global pnpm@10.15.0

WORKDIR /workspace

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/package.json
COPY packages/next/package.json packages/next/package.json
COPY packages/next/bin packages/next/bin
COPY tests/browser/frontend/package.json tests/browser/frontend/package.json

RUN pnpm install --frozen-lockfile

COPY packages packages
COPY scripts/write-esm-package.mjs scripts/write-esm-package.mjs
COPY python/fluxfast python/fluxfast
COPY tests/browser/backend.py tests/browser/backend.py
COPY tests/browser/distributed_backend.py tests/browser/distributed_backend.py
COPY tests/browser/frontend tests/browser/frontend

RUN python3 -m venv /opt/fluxfast \
    && /opt/fluxfast/bin/python -m pip install './python/fluxfast[redis]' \
    && pnpm --filter @fluxfast/core run build \
    && pnpm --filter @fluxfast/next run build \
    && /opt/fluxfast/bin/fluxfast types tests.browser.backend:app \
        --frontend tests/browser/frontend \
    && /opt/fluxfast/bin/fluxfast build \
        --app tests.browser.backend:app \
        --frontend tests/browser/frontend

FROM ${NODE_IMAGE} AS runtime

ENV HOME=/tmp \
    NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PATH=/opt/fluxfast/bin:$PATH \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=builder /opt/fluxfast /opt/fluxfast
COPY --from=builder /workspace/tests/browser/frontend/.next/standalone/ ./
COPY --from=builder /workspace/tests/browser/frontend/.next/static/ \
    ./tests/browser/frontend/.next/static/
COPY --from=builder /workspace/tests/browser/backend.py ./tests/browser/backend.py
COPY --from=builder /workspace/tests/browser/distributed_backend.py \
    ./tests/browser/distributed_backend.py
COPY tests/container/frontend.package.json ./tests/browser/frontend/package.json
COPY tests/container/start-next.mjs ./tests/browser/frontend/start-next.mjs

USER node

EXPOSE 3000
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/_fluxfast/readyz').then(response => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"]

CMD ["fluxfast", "start", "tests.browser.backend:app", "--frontend", "tests/browser/frontend"]
