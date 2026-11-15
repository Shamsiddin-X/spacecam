# Живой сервер (необязателен): история любой точки неба через /api/field + раздача сайта
FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 SKYWATCH_CACHE=/tmp/skywatch-cache FRONTEND_DIR=/srv/web PORT=8000
WORKDIR /srv/python
COPY python/requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY python/ /srv/python/
COPY web/ /srv/web/
EXPOSE 8000
CMD ["sh", "-c", "uvicorn skywatch.main:app --host 0.0.0.0 --port ${PORT}"]
