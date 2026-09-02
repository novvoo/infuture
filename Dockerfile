# syntax=docker/dockerfile:1
# infuture — 桌面 Workbench 容器化部署
# 多层构建：构建阶段产出前端产物，运行阶段仅拷贝产物与依赖，镜像更小更安全
# 单端口同时服务：前端静态产物（HTTP）+ 后端 JSON-RPC（WebSocket）
# 依赖安装默认走国内镜像（registry.npmmirror.com），可用 --build-arg NPM_REGISTRY 覆盖
#
# 构建：docker build -t infuture .
# 运行：docker run --rm -p 50051:50051 infuture   →  打开 http://localhost:50051
# 远程访问：docker build --build-arg VITE_WS_URL=ws://<host>:50051 -t infuture .

# 国内镜像源（可在 build-arg 覆盖）
ARG NPM_REGISTRY=https://registry.npmmirror.com

# ── 构建阶段：安装依赖 + 构建前端产物 ──
FROM node:20-alpine AS build
WORKDIR /app

# 前端连接后端的 ws 地址（默认本机；远程/容器桥接场景可覆盖）
ARG VITE_WS_URL=ws://localhost:50051
ENV VITE_WS_URL=$VITE_WS_URL
ARG NPM_REGISTRY
ENV NPM_CONFIG_REGISTRY=$NPM_REGISTRY

# 先拷锁文件与源码清单，最大化复用层缓存
COPY package.json package-lock.json tsconfig.json ./
COPY packages apps ./

# 安装依赖：BuildKit 缓存挂载避免重复下载，国内镜像加速
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline

# 构建前端产物（apps/desktop/dist）
RUN npm run desktop:build

# ── 运行阶段：复用构建产物与依赖，仅保留运行所需 ──
FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
# 容器内与浏览器通过同一端口通信（HTTP 静态 + WS）
ENV INFUTURE_PORT=50051

# 源码、依赖、前端产物统一从构建阶段拷贝
COPY --from=build /app/package.json /app/package-lock.json /app/tsconfig.json ./
COPY --from=build /app/packages packages
COPY --from=build /app/apps apps
COPY --from=build /app/node_modules node_modules

EXPOSE 50051

# 生产模式：desktop 后端检测到 dist 后在同一端口托管静态页面
CMD ["npm", "run", "server", "--workspace", "@infuture/desktop"]
