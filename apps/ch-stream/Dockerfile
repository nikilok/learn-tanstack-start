FROM oven/bun:1.3.13@sha256:87416c977a612a204eb54ab9f3927023c2a3c971f4f345a01da08ea6262ae30e
WORKDIR /app

COPY package.json bun.lock ./
COPY packages/db/package.json packages/db/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/ch-stream/package.json apps/ch-stream/package.json

RUN bun install --frozen-lockfile

COPY packages/db packages/db
COPY apps/ch-stream apps/ch-stream

USER bun
WORKDIR /app/apps/ch-stream
CMD ["bun", "src/index.ts"]
