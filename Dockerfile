# 知面陪练 · 单容器部署（CloudBase 云托管 / 任意容器平台）
# 关键点：
#  - 生产阶段不需要 tsx：只跑 tsc 产物 dist/index.js
#  - 交付包管理器固定 npm（官方 AI Works 部署契约），用 package-lock.json 做可复现构建
#  - 静态站点由同一进程托管（同域，规避 CORS，也便于录音需要的 HTTPS 域名）

FROM node:20-slim

WORKDIR /app

# 先只拷依赖清单，命中 Docker 层缓存
COPY package.json package-lock.json ./
COPY apps/bff/package.json ./apps/bff/package.json

RUN npm ci

# 再拷源码并构建（含前端静态资源，BFF 同域托管）
COPY apps ./apps
RUN npm run build --workspace @zhimian/bff

ENV NODE_ENV=production
ENV PORT=8787

# 缓存已改为纯内存（云函数文件系统只读，落盘会被官方部署探测阻断），无需挂卷
EXPOSE 8787

CMD ["node", "apps/bff/dist/index.js"]
