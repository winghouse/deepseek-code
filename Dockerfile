FROM node:20-alpine

WORKDIR /app

# 安装 pnpm
RUN corepack enable && corepack prepare pnpm@10 --activate

# 复制 monorepo 配置
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./

# 复制子包
COPY packages/shared/package.json packages/shared/tsconfig.json packages/shared/
COPY packages/core/package.json packages/core/tsconfig.json packages/core/
COPY packages/cli/package.json packages/cli/tsconfig.json packages/cli/

# 安装依赖
RUN pnpm install --frozen-lockfile --prod

# 复制源码并编译
COPY packages/shared/src/ packages/shared/src/
COPY packages/core/src/ packages/core/src/
COPY packages/cli/src/ packages/cli/src/
RUN pnpm build

ENV DEEPSEEK_BASE_URL=https://api.deepseek.com

ENTRYPOINT ["node", "packages/cli/dist/index.js"]
