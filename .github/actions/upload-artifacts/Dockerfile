# .github/actions/upload-artifacts/Dockerfile

FROM node:20-slim

WORKDIR /app

# Copy package files from the actions root directory
COPY ../package.json ./
COPY ../package-lock.json ./

RUN npm ci

# Copy tsconfig from the actions root directory
COPY ../tsconfig.json ./

# Copy shared common code from the actions root directory
COPY ../common ./common
# Copy this action's specific source code from the build context
COPY ./src ./upload-artifacts/src

RUN npm run build:artifacts

LABEL org.opencontainers.image.source=https://github.com/opvia/seal-github-actions
LABEL org.opencontainers.image.description="Finds artifacts based on patterns, uploads them to Seal, and links them to a Seal entity."
LABEL repository="https://github.com/opvia/seal-github-actions"
LABEL homepage="https://github.com/opvia/seal-github-actions"
LABEL maintainer="Seal <support@seal.run>"

# Entrypoint uses the output path defined in the build script
ENTRYPOINT ["node", "/app/upload-artifacts/dist/index.js"]
