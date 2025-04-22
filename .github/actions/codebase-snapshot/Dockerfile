# .github/actions/codebase-snapshot/Dockerfile
# Use a base image with necessary tools or install them
FROM ubuntu:22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    zip \
    curl \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# [IMPORTANT] Add OCI labels to link the package to the source repository
# Replace with your actual repository URL
LABEL org.opencontainers.image.source=https://github.com/opvia/change-order-github-app
LABEL org.opencontainers.image.description="Creates a codebase snapshot and uploads to Seal."

LABEL repository="https://github.com/opvia/change-order-github-app"
LABEL homepage="https://github.com/opvia/change-order-github-app"

LABEL maintainer="Seal <support@seal.run>"

ENTRYPOINT ["/entrypoint.sh"]
