FROM oven/bun:1.3.13
WORKDIR /app

COPY package.json bun.lock ./
COPY packages/db/package.json packages/db/package.json
COPY apps/web/package.json apps/web/package.json
COPY apps/ch-stream/package.json apps/ch-stream/package.json

RUN bun install --frozen-lockfile

COPY packages/db packages/db
COPY apps/ch-stream apps/ch-stream

WORKDIR /app/apps/ch-stream
CMD ["bun", "src/index.ts"]
