FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 PYTHONPATH=/app/src BI_CONFIG_DIR=/app/config
WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY config/ ./config/
COPY src/ ./src/

# Cloud Run sets $PORT. One worker, generous timeout for the daily pipeline.
CMD exec gunicorn -b :${PORT:-8080} --workers 1 --threads 4 --timeout 600 bi_agent.main:app
