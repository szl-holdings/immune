# IMMUNE investor demo — self-contained image.
# Build context = this deploy/ directory. Run build-standalone.sh FIRST to produce ./dist.
#
#   bash build-standalone.sh
#   docker build -t immune-demo .
#   docker run --rm -p 7860:7860 immune-demo
#
# The server bundle has all node deps inlined, so no npm install is needed at image
# build time — the image stays small.
#
# Base image is pulled from the AWS ECR Public mirror of the official Docker Library
# image (bit-identical to docker.io/library/node:20-alpine) because Hugging Face's
# shared Docker builders pull anonymously from Docker Hub and hit its anonymous
# pull-rate limit; when throttled the FROM pull stalls until the build job hits its
# wall-clock limit ("Job timeout"). ECR Public has no such limit, so the pull is fast
# and deterministic. This is the ONLY unbounded step in an otherwise COPY-only build.
FROM public.ecr.aws/docker/library/node:20-alpine

# Cache-bust / fresh-container marker (bump to force HF to rebuild+redeploy):
ARG IMMUNE_DEPLOY_REV=2026-07-08d

WORKDIR /app

# Self-contained server bundle, the vite-built SPA, and the REAL receipt/evidence chain.
COPY dist/immune-server.js ./immune-server.js
COPY dist/public ./public
COPY dist/data ./data

# Hugging Face Spaces runs the container as a non-root user (UID 1000); the immune
# ledger appends to ./data/immune, so that path must be writable by that user.
RUN chmod -R a+rwX /app/data && chown -R 1000:1000 /app

ENV NODE_ENV=production \
    PORT=7860

EXPOSE 7860

USER 1000

CMD ["node", "immune-server.js"]
