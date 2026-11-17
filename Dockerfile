# 简历专家 · 生产镜像（ModelScope 创空间 / 任意容器平台通用）
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
# ModelScope 创空间要求 Docker 类型必须监听 7860；本地可用 -e PORT=5173 覆盖
ENV PORT=7860

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .
# 容器内以非 root 运行，日志目录需可写
RUN mkdir -p /app/logs && chown -R node:node /app
USER node

EXPOSE 7860

# 平台健康检查用：/api/health 不需要访问口令
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||7860)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
