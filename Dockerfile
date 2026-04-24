FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production
# Render / Fly などが PORT を渡す（未指定なら 3333）
EXPOSE 3333
CMD ["node", "server.js"]
