# .github/actions/codebase-snapshot/Dockerfile

FROM node:20-slim

WORKDIR /app

COPY package.json ./
COPY package-lock.json ./
COPY tsconfig.json ./
COPY common ./common
COPY codebase-snapshot/src ./codebase-snapshot/src

RUN apt-get update && apt-get install -y --no-install-recommends \
    zip \
    tar \
    && npm ci \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

RUN npm run build:snapshot

LABEL org.opencontainers.image.source=https://github.com/opvia/seal-github-actions
LABEL org.opencontainers.image.description="Creates a codebase snapshot archive and uploads to Seal."
LABEL repository="https://github.com/opvia/seal-github-actions"
LABEL homepage="https://github.com/opvia/seal-github-actions"
LABEL maintainer="Seal <support@seal.run>"

ENTRYPOINT ["node", "/app/codebase-snapshot/dist/index.js"]
