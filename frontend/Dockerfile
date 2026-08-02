# Multi-stage build for the STATIC-EXPORT frontend.
# next.config.js uses output: "export" -> `next build` emits a fully static site
# to /app/out (no Node server). The runtime image is just nginx serving those
# files, which also matches how Cloudflare Pages serves them. Keeps parity
# between the compose/VPS frontend and the Pages deploy.
#
# For hermetic local builds, run from the repo root with --workspace=frontend.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json ./
RUN npm install --legacy-peer-deps

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# NEXT_PUBLIC_* vars must be present at build time so Next.js can inline them.
ARG NEXT_PUBLIC_GATEWAY_URL=http://localhost:8088
ARG NEXT_PUBLIC_WS_URL=ws://localhost:8088/ws
ARG NEXT_PUBLIC_SITE_URL=http://localhost:3000
ENV NEXT_PUBLIC_GATEWAY_URL=$NEXT_PUBLIC_GATEWAY_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ENV NEXT_PUBLIC_SITE_URL=$NEXT_PUBLIC_SITE_URL
RUN npm run build

FROM nginx:alpine AS runner
# SPA-style fallback so client routes (/document, /trial, /search) resolve, and
# a tiny config that serves the static export. Next export already writes
# per-route .html files; try_files covers query-param client pages too.
RUN printf 'server {\n\
  listen 3000;\n\
  root /usr/share/nginx/html;\n\
  index index.html;\n\
  location / { try_files $uri $uri.html $uri/ /index.html; }\n\
}\n' > /etc/nginx/conf.d/default.conf
COPY --from=builder /app/out /usr/share/nginx/html
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -q -O- http://127.0.0.1:3000/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
