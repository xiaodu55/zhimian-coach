# 知面陪练 · 单容器部署（CloudBase 云托管 / 任意容器平台）
# 关键点：
#  - 生产阶段不需要 tsx：只跑 tsc 产物 dist/index.js
#  - 必须带 pnpm-lock.yaml 才能 --frozen-lockfile（可复现构建）
#  - 静态站点由同一进程托管（同域，规避 CORS，也便于录音需要的 HTTPS 域名）

FROM node:20-slim

WORKDIR /app

# pnpm 版本与仓库 packageManager 保持一致
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

# 先只拷依赖清单，命中 Docker 层缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/bff/package.json ./apps/bff/package.json

RUN pnpm install --frozen-lockfile

# 再拷源码并构建（含前端静态资源，BFF 同域托管）
COPY apps ./apps
RUN pnpm --filter @zhimian/bff build

ENV NODE_ENV=production
ENV PORT=8787

# 需要持久化知乎公开内容缓存时，挂载卷并设置：
#   CACHE_PERSIST=1  CACHE_DIR=/data/.cache
EXPOSE 8787

CMD ["node", "apps/bff/dist/index.js"]
