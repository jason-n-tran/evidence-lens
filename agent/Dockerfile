# Agent build context is the repo root, so this Dockerfile can pull in
# both `agent/` and `prompts/`. Reference from compose as:
#   build: { context: ., dockerfile: agent/Dockerfile }
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
COPY agent/pyproject.toml ./
RUN pip install uv && uv pip install --system .
COPY agent/ ./
COPY prompts/agent_system.md /prompts/agent_system.md
EXPOSE 8081
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsSL http://127.0.0.1:8081/healthz || exit 1
CMD ["python", "main.py"]
