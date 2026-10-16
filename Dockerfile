FROM node:20-alpine

WORKDIR /app

ENV DATA_DIR=/app/data
RUN mkdir -p /app/data && chmod 777 /app/data

COPY package*.json ./

# Устанавливаем ВСЕ зависимости
RUN npm install

COPY . .

# Компилируем TypeScript с выводом ошибок в лог сборки
RUN npx tsc --pretty || (echo "TYPESCRIPT BUILD FAILED" && exit 1)

# Запускаем скомпилированное приложение
CMD ["node", "dist/index.js"]