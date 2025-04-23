# .github/actions/upload-artifacts/Dockerfile

FROM node:20-slim

WORKDIR /app

COPY package.json ./
COPY package-lock.json ./
COPY tsconfig.json ./
COPY common ./common
COPY upload-artifacts/src ./upload-artifacts/src

RUN npm ci

RUN npm run build:artifacts

LABEL org.opencontainers.image.source=https://github.com/opvia/seal-github-actions
LABEL org.opencontainers.image.description="Finds artifacts based on patterns, uploads them to Seal, and links them to a Seal entity."
LABEL repository="https://github.com/opvia/seal-github-actions"
LABEL homepage="https://github.com/opvia/seal-github-actions"
LABEL maintainer="Seal <support@seal.run>"

ENTRYPOINT ["node", "/app/upload-artifacts/dist/index.js"]
