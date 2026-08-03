# `infra/`

Supporting files for the root `docker-compose.yml`. The compose file itself lives at the repo root, not here.

| Path | Purpose |
|---|---|
| [`ofelia/`](ofelia/) | Cron schedules for ingesters + nightly jobs (replaces the old `dokploy/schedules.yaml` and the GHA `scheduled-*.yml` workflows). |
| [`otel/`](otel/) | OpenTelemetry Collector configs (used when running with `--profile observability`). |
| [`prometheus/`](prometheus/) | Prometheus scrape config (used when running with `--profile observability`). |
| [`grafana/`](grafana/) | Grafana dashboards + alerting provisioning (used when running with `--profile observability`). |
| [`sql/`](sql/) | Postgres init scripts. The `migrate` compose service runs these against the in-cluster Postgres on first boot. |
| [`scripts/`](scripts/) | One-shot helper scripts (e.g. `minio-bootstrap.sh` to create the two S3 buckets). |

## Bringing the stack up

Always operate from the repo root:

```bash
cp .env.example .env       # tweak passwords for non-local use
npm run up                  # docker compose up -d
```

To enable observability:

```bash
npm run up:observability    # adds otel-collector, prometheus, grafana on profile
```

To run an ingester ad-hoc:

```bash
npm run ingest:pubmed       # one-shot, exits when done
```

## Production

The prod overlay keeps the app services and points them at an external data plane (e.g. TrueNAS):

```bash
npm run up:prod
# = docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

See [docs/CURRENT_STATE.md](../docs/CURRENT_STATE.md#deployment-topologies-the-compose-files)
for all topologies (local / VPS+TrueNAS / prod) and which compose files each stacks.

## Secrets

Never commit `.env`. The shared `.env.example` at the repo root documents every variable; everything under `# OPTIONAL` can be left blank.
