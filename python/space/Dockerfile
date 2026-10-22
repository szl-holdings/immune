# IMMUNE Python kernel — Channel B. Flattened HF Space layout.
# Digest-pinned OCI index for python:3.12-slim (3.12.14-slim-trixie, linux/amd64
# included), identical on mirror.gcr.io and registry-1.docker.io on 2026-09-29.
FROM mirror.gcr.io/library/python:3.15-slim@sha256:2da676046630d7bf14c6764ae1143dc7fa0377a53f94bf5a642f0b214aca5bce
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
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7860/healthz', timeout=4)"
CMD ["python", "-u", "server.py"]
