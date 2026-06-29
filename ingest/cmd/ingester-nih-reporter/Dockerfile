# syntax=docker/dockerfile:1.7
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN go mod tidy
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w"     -o /out/ingester-nih-reporter ./cmd/ingester-nih-reporter

FROM alpine:3.20
RUN apk add --no-cache ca-certificates tzdata
COPY --from=build /out/ingester-nih-reporter /ingester-nih-reporter
ENTRYPOINT ["/ingester-nih-reporter"]
