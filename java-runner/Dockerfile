FROM eclipse-temurin:21-jdk-alpine

WORKDIR /app

# Install Node.js (needed to run the Express wrapper)
RUN apk add --no-cache nodejs npm

COPY package*.json ./
RUN npm ci --omit=dev

COPY server.js .

EXPOSE 3001

CMD ["node", "server.js"]
