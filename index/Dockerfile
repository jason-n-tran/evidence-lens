# syntax=docker/dockerfile:1.7
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/indexer ./cmd/indexer

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/indexer /indexer
ENTRYPOINT ["/indexer"]
