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
# image (the ECR mirror of the official Node 24 Alpine image) because Hugging Face's
# shared Docker builders pull anonymously from Docker Hub and hit its anonymous
# pull-rate limit; when throttled the FROM pull stalls until the build job hits its
# wall-clock limit ("Job timeout"). ECR Public has no such limit, so the pull is fast
# and deterministic. This is the ONLY unbounded step in an otherwise COPY-only build.
#
# Tag node:24-alpine, pinned to the multi-arch OCI image-index digest that ECR Public
# returned on 2026-09-25 (identical to Docker Hub library/node:24-alpine at that time).
# Bump the tag and the digest together.
FROM public.ecr.aws/docker/library/node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1

# Cache-bust / fresh-container marker (bump to force HF to rebuild+redeploy):
ARG IMMUNE_DEPLOY_REV=2026-08-29-operational

WORKDIR /app

# Self-contained server bundle, the vite-built SPA, and the REAL receipt/evidence chain.
COPY dist/immune-server.js ./immune-server.js
COPY dist/hf-deploy-manifest.json ./hf-deploy-manifest.json
COPY dist/public ./public
COPY dist/data ./data

# Hugging Face Spaces runs the container as a non-root user (UID 1000); the immune
# ledger appends to ./data/immune, so that path must be writable by that user.
RUN chmod -R a+rwX /app/data && chown -R 1000:1000 /app

ENV NODE_ENV=production \
    PORT=7860 \
    IMMUNE_DEMO_OPERATOR=1

EXPOSE 7860

USER 1000

# Process liveness only: /healthz answers 200 whenever the server is running.
# /readyz remains the truthful readiness contract. The image has no Python, so the
# probe uses Node's built-in fetch.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||7860)+'/healthz',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

CMD ["node", "immune-server.js"]
