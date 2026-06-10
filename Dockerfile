FROM node:22-alpine AS builder
WORKDIR /app
RUN corepack enable
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/core/package.json packages/core/tsconfig.json packages/core/
COPY packages/cli/package.json packages/cli/tsconfig.json packages/cli/
RUN pnpm install --frozen-lockfile
COPY packages/shared/src/ packages/shared/src/
COPY packages/core/src/ packages/core/src/
COPY packages/cli/src/ packages/cli/src/
RUN pnpm build

FROM node:22-alpine
WORKDIR /app
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/core/dist/ packages/core/dist/
COPY --from=builder /app/packages/cli/dist/ packages/cli/dist/
COPY --from=builder /app/packages/cli/package.json packages/cli/
COPY --from=builder /app/packages/core/package.json packages/core/
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/shared/node_modules/ packages/shared/node_modules/
COPY --from=builder /app/packages/core/node_modules/ packages/core/node_modules/
COPY --from=builder /app/packages/cli/node_modules/ packages/cli/node_modules/
ENV DEEPSEEK_BASE_URL=https://api.deepseek.com
ENTRYPOINT ["node", "packages/cli/dist/index.js"]
