# Thin pass-through to the npm scripts in package.json. Kept for muscle
# memory; npm is the cross-platform entrypoint (works in PowerShell too).
.PHONY: help up up-full down logs ps build smoke proto

help:
	@echo "EvidenceLens — common targets (each delegates to npm)"
	@echo "  make up         npm run up         (default profile)"
	@echo "  make up-full    npm run up:full    (default + ingest + observability)"
	@echo "  make down       npm run down"
	@echo "  make logs       npm run logs"
	@echo "  make ps         npm run ps"
	@echo "  make build      npm run build"
	@echo "  make smoke      npm run smoke"
	@echo "  make proto      npm run proto"

up:        ; npm run up
up-full:   ; npm run up:full
down:      ; npm run down
logs:      ; npm run logs
ps:        ; npm run ps
build:     ; npm run build
smoke:     ; npm run smoke
proto:     ; npm run proto
