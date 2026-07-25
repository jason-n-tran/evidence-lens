/** @type {import('next').NextConfig} */
// Static export for Cloudflare Pages. The app is a SPA that talks to the gateway
// API from the browser (no Next server). `output: "export"` emits static HTML +
// assets to `out/`, which Pages serves from its global CDN.
//
// Consequences this config + the pages account for:
//   - No server rendering: pages that need request-time data (recalls, a single
//     document/trial) are client components that fetch the gateway in-browser
//     and read their id from `?id=` (dynamic [id] path routes can't be
//     statically exported with unbounded ids).
//   - next/headers() is NOT supported in export mode; the security headers +
//     CSP live in frontend/public/_headers (Cloudflare Pages applies them).
//   - next/image optimization needs a server, so images are unoptimized.
export default {
  reactStrictMode: true,
  output: "export",
  images: { unoptimized: true },
  experimental: { typedRoutes: true },
  env: {
    NEXT_PUBLIC_GATEWAY_URL: process.env.NEXT_PUBLIC_GATEWAY_URL ?? "http://localhost:8080",
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:8080/ws",
    NEXT_PUBLIC_WEBLLM_URL: process.env.NEXT_PUBLIC_WEBLLM_URL ?? "",
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL ?? "https://evidencelens.pages.dev",
  },
};
