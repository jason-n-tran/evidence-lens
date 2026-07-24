FROM node:20-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --legacy-peer-deps
COPY src ./src
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/src/schema.graphql ./src/schema.graphql
COPY package.json ./
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "dist/main.js"]
