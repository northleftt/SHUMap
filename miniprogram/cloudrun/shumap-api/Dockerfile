# 微信云托管 Dockerfile 部署：纯 Node 反向代理，无第三方依赖。
# 云托管要求容器监听 80 端口（server.mjs 默认即 80）。
FROM node:20-alpine

WORKDIR /app
COPY server.mjs package.json ./

# Default upstream; CloudBase console env can still override this.
ENV UPSTREAM_BASE=https://map.shutf.com
ENV PORT=80

EXPOSE 80
CMD ["node", "server.mjs"]
