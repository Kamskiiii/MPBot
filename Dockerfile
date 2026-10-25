FROM node:20-alpine
WORKDIR /usr/src/app
ENV DATA_DIR=/app/data
RUN mkdir -p /app/data
RUN apk add --no-cache python3 make g++

COPY package.json ./
RUN npm install

COPY . .
RUN npm run build && npm prune --omit=dev

CMD ["npm", "start"]