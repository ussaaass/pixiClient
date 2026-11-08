# syntax=docker/dockerfile:1
#
# 生产镜像：API 服务端。
#
# 与 Dockerfile.dev（开发热重载）的分工：
# - Dockerfile.dev：挂载源码、跑 watch 进程，用于本地开发；
# - Dockerfile（本文）：多阶段构建，产物为自包含 ESM 文件，运行时不含 TS 源码与 workspace 链接。
#
# 构建：docker build -f Dockerfile -t gameing-hall-api:prod .
# 运行：docker run --rm -p 10300:3000 -e PORT=3000 gameing-hall-api:prod

# ---------- 构建阶段 ----------
FROM node:26.13.0-bookworm-slim AS builder

RUN npm install --global --allow-scripts=pnpm pnpm@12.10.1

WORKDIR /workspace

# 先只复制清单，利用 Docker 层缓存：源码变动不需要重装依赖。
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY apps/server/package.json apps/server/
COPY packages/contracts/package.json packages/contracts/
COPY packages/admin-contracts/package.json packages/admin-contracts/
COPY apps/web/package.json apps/web/
COPY apps/admin/package.json apps/admin/
COPY games/shisanshui/client/package.json games/shisanshui/client/
COPY games/shisanshui/rules/package.json games/shisanshui/rules/
COPY tools/asset-generation/package.json tools/asset-generation/

RUN pnpm install --frozen-lockfile --ignore-scripts

COPY apps/server apps/server
COPY packages packages

RUN pnpm --filter @gameing/server build

# ---------- 运行阶段 ----------
FROM node:26.13.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS=--enable-source-maps

WORKDIR /app

# 以非 root 运行；node 镜像自带 uid 1000 的 node 用户。
COPY --from=builder --chown=node:node /workspace/apps/server/dist ./dist

USER node

EXPOSE 3000

# 存活探针命中 /health/live（进程存活）；就绪探针用 /health/ready（依赖就绪）。
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.js"]
