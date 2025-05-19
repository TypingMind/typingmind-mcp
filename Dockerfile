FROM node:23-slim
WORKDIR /app

RUN npm install -g pnpm

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod

COPY . .

# install curl so Coolify’s health‐probe will work
RUN apt-get update && apt-get install -y curl

ENV PORT=12757
EXPOSE 12757

# add a Docker healthcheck on /ping
HEALTHCHECK --interval=30s --timeout=5s \
  CMD curl -fs http://localhost:${PORT}/ping || exit 1

CMD ["node", "bin/index.js"]
