FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends curl build-essential && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
COPY pyproject.toml ./
RUN pip install uv && uv pip install --system .
COPY evidencelens ./evidencelens
COPY . .
EXPOSE 50052 8090
# Run the HTTP shim alongside the gRPC server. supervisord-style:
# the shim imports from main.py so a single process is enough.
CMD ["sh", "-c", "python main.py & python http_server.py && wait"]
