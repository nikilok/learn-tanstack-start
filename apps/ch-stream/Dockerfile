FROM oven/bun:1.4.0@sha256:5ff609364c049b54eb0ff560ec96319729a972078ef2c755d758f0c6ef89c2d6
WORKDIR /app

COPY package.json bun.lock ./
COPY packages/db/package.json packages/db/package.json
COPY packages/gemma/package.json packages/gemma/package.json
COPY packages/skyline/package.json packages/skyline/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/ch-stream/package.json apps/ch-stream/package.json
COPY apps/desktop/package.json apps/desktop/package.json

RUN bun install --frozen-lockfile

COPY packages/db packages/db
COPY apps/ch-stream apps/ch-stream

USER bun
WORKDIR /app/apps/ch-stream
CMD ["bun", "src/index.ts"]
