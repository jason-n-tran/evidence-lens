FROM node:20-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --legacy-peer-deps
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production MCP_TRANSPORT=http
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
EXPOSE 8082
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O- http://127.0.0.1:8082/healthz || exit 1
CMD ["node", "dist/server.js"]
