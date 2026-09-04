# IMMUNE Python kernel — Channel B. Same doctrine as src/lib/immune.
"
    "FROM mirror.gcr.io/library/python:3.12-slim

"
    "ENV PYTHONDONTWRITEBYTECODE=1 \
"
    "    PYTHONUNBUFFERED=1 \
"
    "    PORT=7860 \
"
    "    IMMUNE_DATA_DIR=/app/data/immune

"
    "RUN groupadd --system --gid 10001 immune \
"
    "    && useradd --system --uid 10001 --gid immune --create-home \
"
    "       --home-dir /home/immune --shell /usr/sbin/nologin immune \
"
    "    && install -d -o immune -g immune /app /app/data/immune

"
    "WORKDIR /app
"
    "COPY python/requirements.txt ./requirements.txt
"
    "RUN pip install --no-cache-dir -r requirements.txt
"
    "COPY --chown=immune:immune python/immune ./immune
"
    "COPY --chown=immune:immune python/space/index.html ./index.html
"
    "COPY --chown=immune:immune python/space/run.py ./server.py

"
    "USER immune
"
    "EXPOSE 7860
"
    "HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
"
    "  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7860/readyz', timeout=4)"
"
    "CMD ["python", "-u", "server.py"]
