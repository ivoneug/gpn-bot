FROM node:22-alpine

ENV NODE_ENV=production \
    TZ=Europe/Moscow \
    STATE_FILE=/app/data/state.json

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src

# Каталог состояния держим под пользователем node — контейнер работает не от root.
RUN mkdir -p /app/data && chown -R node:node /app
USER node

VOLUME ["/app/data"]

CMD ["node", "src/index.js"]
