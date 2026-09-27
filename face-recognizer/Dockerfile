FROM python:3.11-slim

WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Models are downloaded and checksum-verified at build time, never committed
COPY scripts/download_models.py scripts/
RUN python scripts/download_models.py

COPY app/ app/

# Enrolled embeddings are biometric data: keep them on a volume, never in the image
VOLUME /app/index
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
