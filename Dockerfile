FROM node:22-bookworm-slim AS build

ARG BUILD_MIRROR=0

WORKDIR /app

COPY package.json package-lock.json ./
RUN if [ "$BUILD_MIRROR" = "1" ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; \
    fi \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
RUN if [ "$BUILD_MIRROR" = "1" ]; then \
      npm ci --registry=https://registry.npmmirror.com; \
    else \
      npm ci; \
    fi

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app ./

USER node

EXPOSE 3000 9989

CMD ["npm", "start"]
