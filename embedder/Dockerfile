# NVIDIA CUDA base for vLLM. CPU fallback path works on any host.
FROM nvidia/cuda:12.4.1-runtime-ubuntu22.04 AS base
RUN apt-get update && apt-get install -y --no-install-recommends \
        curl ca-certificates git && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV PYTHONUNBUFFERED=1
ENV PIP_NO_CACHE_DIR=1

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:$PATH"

COPY pyproject.toml ./
RUN uv venv --python 3.12 /opt/venv
ENV PATH="/opt/venv/bin:$PATH"
# torch (with its bundled CUDA runtime) comes from `uv pip install .`. We do NOT
# pre-pin a cu124 wheel: a previous attempt did, but the subsequent
# `uv pip install .` re-resolved torch>=2.5.0 from the default index and
# overwrote it (verified: the container ran torch 2.x+cu130, not cu124). The
# default wheel works on the RTX 4070 (sm_89); the real "CUDA error: unknown
# error" was a cross-thread CUDA-context bug in the service, fixed by the
# dedicated CUDA thread in main.py — not a torch-build problem.
RUN uv pip install .

COPY evidencelens ./evidencelens
COPY . .

EXPOSE 50051 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
    CMD curl -fsSL http://localhost:8080/healthz || exit 1

ENTRYPOINT ["/opt/venv/bin/python", "main.py"]
