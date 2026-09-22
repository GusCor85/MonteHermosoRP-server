FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.js account_store.js schema.sql ./
EXPOSE 9080
CMD ["node", "server.js"]
