# IMMUNE Python kernel — Channel B. Same doctrine as src/lib/immune.
# Digest-pinned multi-arch OCI index for python:3.15-slim from mirror.gcr.io (the
# Docker Hub library/python mirror). Dependabot's docker group refreshes the
# digest; keep the tag and digest together when changing the runtime line.
FROM mirror.gcr.io/library/python:3.15-slim@sha256:65a65fc7b30b06cb6df4930fd4650697cb23f4c2698ab81fc87e4b031bc36928
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PORT=7860 IMMUNE_DATA_DIR=/app/data/immune
COPY python/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt
COPY python/immune ./immune
COPY python/space/index.html ./index.html
COPY python/space/nexus.html ./nexus.html
COPY python/space/run.py ./server.py
EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7860/healthz', timeout=4)"
CMD ["python", "-u", "server.py"]
