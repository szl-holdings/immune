# IMMUNE Python kernel — Channel B. Flattened HF Space layout.
FROM mirror.gcr.io/library/python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=7860 IMMUNE_DATA_DIR=/app/data/immune
COPY requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY immune ./immune
COPY index.html ./index.html
COPY nexus.html ./nexus.html
COPY server.py ./server.py
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7860/api/immune/state', timeout=4)"
CMD ["python", "-u", "server.py"]
