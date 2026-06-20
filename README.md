<!-- LOGO placeholder -->

# EvidenceLens

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Go](https://img.shields.io/badge/Go-1.23-00ADD8?logo=go&logoColor=white)](https://go.dev/)
[![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Next.js](https://img.shields.io/badge/Next.js-15-000000?logo=nextdotjs&logoColor=white)](https://nextjs.org/)
[![NestJS](https://img.shields.io/badge/NestJS-11-E0234E?logo=nestjs&logoColor=white)](https://nestjs.com/)
[![Docker](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://docs.docker.com/compose/)

A free, public, agentic biomedical evidence search engine that unifies the literature, clinical trials, regulatory filings, and conflict-of-interest records behind a single hybrid ranker. EvidenceLens surfaces conflict-of-interest badges next to every author and synthesizes answers using **your** inference tier — so it never burns server-side LLM tokens. The entire stack runs on free and self-hosted infrastructure for **$0/year** in recurring cost.

## Visuals

![Project Screenshot](path/to/screenshot.png)

<!--
Best screenshot: the main search results view showing a query (e.g. "statins cardiovascular outcomes"),
the streamed result cards with source badges (PubMed / Trials / FDA), and a conflict-of-interest badge
expanded next to an author name. A second shot of the citation graph (D3) would also showcase the product well.
-->

## Table of Contents

- [About The Project](#about-the-project)
  - [Motivation](#motivation)
  - [Key Features](#key-features)
  - [Built With](#built-with)
- [Getting Started](#getting-started)
  - [Prerequisites](#prerequisites)
  - [Installation](#installation)
- [Usage](#usage)
  - [Common Commands](#common-commands)
  - [Configuration](#configuration)
- [Architecture](#architecture)
- [Roadmap](#roadmap)
- [License](#license)
- [Contact / Support](#contact--support)
- [Disclaimer](#disclaimer)

## About The Project

### Motivation

Biomedical evidence is fragmented across a dozen authoritative-but-siloed databases — PubMed, bioRxiv/medRxiv, ClinicalTrials.gov, the FDA, CMS Open Payments, NIH RePORTER, and more. A clinician or researcher trying to assess a claim has to query each one separately and has no easy way to see whether an author was paid by the company whose drug they are studying.

EvidenceLens solves this by ingesting all of these sources into one hybrid (BM25 + vector + citation + recency) search index, joining author records against public conflict-of-interest data, and exposing the whole thing through a free, fast, open interface. Because answer synthesis runs on the user's own key, in their browser, or through their MCP client, the project stays free to operate at scale.

### Key Features

- **Unified multi-source ingestion** — Go ingesters pull from PubMed, preprints, clinical trials, FDA/regulatory data, Open Payments, NIH RePORTER, NSF, OpenAlex, Crossref, and more (Dockerfiles staged for 20+ sources).
- **Hybrid ranking pipeline** — a Python scorer pool runs BM25, vector, citation-graph, and recency sub-scorers in parallel, fuses them with Reciprocal Rank Fusion, and reranks with an XGBoost LambdaMART head.
- **Conflict-of-interest badges** — author names are fuzzy-matched against CMS Open Payments records, surfacing financial conflicts inline with every result.
- **Three free inference tiers** — Bring-Your-Own-Key (Anthropic / OpenAI-compat / Ollama), Model Context Protocol for Claude Desktop / Cursor / Cline / Goose, or fully in-browser WebLLM — the server never pays for tokens.
- **Streaming results** — a NestJS gateway fans out to the scorers and streams result waves to the Next.js frontend over WebSockets.
- **Polyglot, container-native** — every service ships as a Docker image, orchestrated by a single root `docker-compose.yml` with overlays for local, VPS, and NAS deployment topologies.

### Built With

**Languages**

![Go](https://img.shields.io/badge/Go-00ADD8?logo=go&logoColor=white)
![Python](https://img.shields.io/badge/Python-3776AB?logo=python&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white)

**Frontend**

![Next.js](https://img.shields.io/badge/Next.js-000000?logo=nextdotjs&logoColor=white)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react&logoColor=black)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss&logoColor=white)
![WebLLM](https://img.shields.io/badge/WebLLM-FF6F00?logo=webassembly&logoColor=white)

**Backend & Services**

![NestJS](https://img.shields.io/badge/NestJS-E0234E?logo=nestjs&logoColor=white)
![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)
![gRPC](https://img.shields.io/badge/gRPC-4285F4?logo=google&logoColor=white)
![MCP](https://img.shields.io/badge/Model_Context_Protocol-000000)

**Data & Infrastructure**

![PostgreSQL](https://img.shields.io/badge/PostgreSQL-4169E1?logo=postgresql&logoColor=white)
![NATS](https://img.shields.io/badge/NATS_JetStream-27AAE1?logo=natsdotio&logoColor=white)
![Redis](https://img.shields.io/badge/Redis-DC382D?logo=redis&logoColor=white)
![Meilisearch](https://img.shields.io/badge/Meilisearch-FF5CAA)
![Milvus](https://img.shields.io/badge/Milvus-00A1EA)
![Neo4j](https://img.shields.io/badge/Neo4j-4581C3?logo=neo4j&logoColor=white)
![XGBoost](https://img.shields.io/badge/XGBoost-337AB7)
![Docker](https://img.shields.io/badge/Docker-2496ED?logo=docker&logoColor=white)

## Getting Started

### Prerequisites

- **Docker Desktop** (or Docker Engine + Compose v2) — runs the entire stack.
- **Node.js 20+** — only needed for the npm script wrappers and workspace tooling.

That's it. The data plane (Postgres, NATS, Redis, Meilisearch, Milvus, Neo4j) all run as containers — nothing else to install locally.

### Installation

```bash
# 1. Clone the repository
git clone https://github.com/your-org/evidencelens.git
cd evidencelens

# 2. Create your environment file (defaults work as-is for local dev)
cp .env.example .env

# 3. Install workspace tooling (one-time)
npm install

# 4. Bring up the full stack: data plane + apps + frontend
npm run up

# 5. Run the end-to-end smoke test
npm run smoke
```

Once up, the frontend is served locally and the gateway exposes REST + GraphQL + WebSocket endpoints.

## Usage

EvidenceLens is a self-hosted application stack. The primary workflow is launching the stack with Docker Compose via the npm script wrappers, which work identically in PowerShell, Git Bash, and WSL.

### Common Commands

```bash
npm run up               # data plane + apps + frontend (default)
npm run up:full          # default + ingesters + observability stack
npm run up:apps          # apps only (point at external Postgres/NATS/etc.)
npm run up:data          # local data plane only

npm run ingest:pubmed    # one-shot ingester run (also: trials, fda, preprint, openalex, ...)
npm run smoke            # in-cluster end-to-end smoke test
npm run logs             # tail all service logs
npm run ps               # list running services
npm run down             # stop everything
```

Develop a single service with hot reload, outside compose:

```bash
npm run dev --workspace frontend        # Next.js dev server
npm run start:dev --workspace gateway   # NestJS watch mode
```

Connect the **MCP server** to an MCP client (Claude Desktop, Cursor, Cline, Goose) to query EvidenceLens directly from your AI tooling — the same search and synthesis tools the web UI uses.

### Configuration

Configuration is driven entirely by environment variables in a root `.env` file (copy from `.env.example`). The defaults are tuned for local development. Notable categories:

| Variable group | Purpose |
|----------------|---------|
| Data plane connections | Postgres, NATS, Redis, Meilisearch, Milvus, and Neo4j hosts/ports |
| Object storage | S3-compatible store for raw payload archival (MinIO, Backblaze B2, etc.) |
| BYOK / inference | Optional upstream keys for the agent proxy (Anthropic, OpenAI-compatible, Ollama) |
| Optional integrations | Turnstile, OpenTelemetry, Sentry, PostHog — **all degrade to no-op when left blank** |

Deployment-specific overlays let you split the stack across machines without editing the base compose file:

- `docker-compose.yml` — application services (gateway, agent, mcp-server, processor, indexer, scorer, embedder, frontend, ofelia)
- `docker-compose.data.yml` — local data plane
- `docker-compose.vps.yml` — VPS overlay (gateway · agent · mcp-server)
- `docker-compose.truenas*.yml` — NAS overlay (data plane + scorer · embedder · indexer)
- `docker-compose.workingpc.yml` — intermittent worker (processor · ingesters · ofelia)

## Architecture

A polyglot pipeline orchestrated by a single root `docker-compose.yml`. **Go ingesters** run as one-shot, cron-triggered containers (via an [ofelia](https://github.com/mcuadros/ofelia) sidecar), archive raw payloads to S3-compatible storage, and publish `RawDocEvent` to **NATS JetStream**. A **Python processor** parses, normalizes, entity-links, chunks, embeds (gRPC to a BGE-M3 embedder), joins Open Payments by fuzzy name match, and republishes `IndexableDocEvent`. A **Go indexer** batches into **Meilisearch** (text + facets), **Milvus** (1024-d HNSW vectors, COSINE), and **Neo4j** (citation graph). A **Python gRPC scorer pool** runs BM25 + vector + citation + recency in parallel, fuses with RRF, and reranks with **XGBoost** LambdaMART. A **NestJS gateway** streams result waves over WebSockets to a **Next.js** frontend, and an **MCP server** exposes the same tools to AI clients.

## Roadmap

- [x] Multi-source Go ingestion pipeline (PubMed, trials, FDA, preprints wired; 20+ sources staged)
- [x] Hybrid scorer pool (BM25 + vector + citation + recency + RRF + LambdaMART)
- [x] Conflict-of-interest badges via Open Payments fuzzy matching
- [x] Three free inference tiers (BYOK, MCP, in-browser WebLLM)
- [ ] Wire up the remaining staged ingesters into the default schedule
- [ ] Expand automated test and CI/CD coverage
- [ ] Public, documented GraphQL API for third-party integrations

## License

Distributed under the MIT License. See [LICENSE](LICENSE) for more information.

EvidenceLens consumes data from sources with their own terms — it never serves full text from non-OA sources, only metadata and deep links.

## Contact / Support

- **Email:** [tran219jn@gmail.com](mailto:tran219jn@gmail.com)
- **Website:** [jasontran.pages.dev](https://jasontran.pages.dev/)

## Disclaimer

EvidenceLens is a research tool. It is **not** medical advice, **not** clinical decision support, and **not** a substitute for a licensed clinician or pharmacist. Conflict-of-interest badges are computed from public records via fuzzy matching and may contain false positives or omissions. Always verify critical findings against primary sources.
