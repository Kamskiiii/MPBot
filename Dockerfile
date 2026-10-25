FROM node:20-alpine

WORKDIR /usr/src/app

# Постоянные данные (SQLite). На хостинге подключите сюда Volume.
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data

# Запасной вариант, если для better-sqlite3 нет готового бинарника
RUN apk add --no-cache python3 make g++

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

CMD ["sh", "-c", "node server.js & node dist/index.js"]