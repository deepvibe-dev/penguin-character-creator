# syntax=docker/dockerfile:1
ARG PYTHON_IMAGE=python:3.15-slim
FROM ${PYTHON_IMAGE}

# uv manages the project; the app itself only needs the standard library.
RUN pip install --no-cache-dir uv==0.13.5

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    PATH="/app/.venv/bin:$PATH" \
    HOST=0.0.0.0 \
    PORT=8000 \
    PENGUIN_DATA_FILE=/data/penguins.csv

WORKDIR /app
COPY pyproject.toml uv.lock README.md ./
COPY penguin_creator ./penguin_creator
RUN uv sync --frozen --no-dev \
    && useradd --create-home --uid 10001 penguin \
    && mkdir -p /data && chown penguin /data

USER penguin
VOLUME ["/data"]
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request,os;urllib.request.urlopen(f'http://127.0.0.1:{os.environ[\"PORT\"]}/healthz')" || exit 1
CMD ["penguin-creator"]
