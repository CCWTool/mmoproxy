FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app ./

USER node

EXPOSE 3000 9989

CMD ["npm", "start"]
