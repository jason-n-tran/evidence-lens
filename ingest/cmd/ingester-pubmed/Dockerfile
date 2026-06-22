# syntax=docker/dockerfile:1.7
# Multi-stage Dockerfile for ingester-pubmed.
# Build context expected: the `ingest/` directory (so the shared go.mod
# is reachable). Set in deploy-dokploy.yml.

FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/ingester-pubmed ./cmd/ingester-pubmed

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/ingester-pubmed /ingester-pubmed
ENTRYPOINT ["/ingester-pubmed"]
