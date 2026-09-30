# IMMUNE Python kernel — Channel B. Same doctrine as src/lib/immune.
# Digest-pinned OCI index for python:3.12-slim (3.12.14-slim-trixie, linux/amd64
# included), identical on mirror.gcr.io and registry-1.docker.io on 2026-09-29.
FROM mirror.gcr.io/library/python:3.14-slim@sha256:51dafde81dbdb6ebde285137a295cf18a47ca95234fe388a343719cb97305b3d
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
