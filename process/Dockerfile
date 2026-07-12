FROM python:3.12-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential libxml2-dev libxslt1-dev curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
# NOTE: build context is the repo ROOT (see docker-compose.yml processor block),
# so COPY sources are repo-relative and the processor tree is under process/.
COPY process/pyproject.toml ./
# Install with the [ml] extra (spaCy + scispaCy) so the entity linker uses
# real UMLS linking instead of the regex fallback. The en_core_sci_lg model
# isn't on PyPI — pull it from scispaCy's release bucket. (The UMLS linker's
# knowledge-base files ~1GB still download lazily on the first link() call.)
RUN pip install uv && uv pip install --system ".[ml]" \
        "https://s3-us-west-2.amazonaws.com/ai2-s2-scispacy/releases/v0.5.4/en_core_sci_lg-0.5.4.tar.gz"

COPY process/ ./
# Repo-root files the processor reads at runtime:
#   /config  -> _load_predatory_issns() looks at Path(__file__).parent.parent/"config"
#   /app/infra/scripts -> enrich_citations.py (scheduled via ofelia job-exec)
COPY config /config
COPY infra/scripts /app/infra/scripts
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsSL http://127.0.0.1:8080/healthz || exit 1
ENTRYPOINT ["python", "main.py"]
