# .github/actions/upload-artifacts/Dockerfile
FROM ubuntu:22.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    jq \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh

LABEL org.opencontainers.image.source=https://github.com/opvia/change-order-github-app
LABEL org.opencontainers.image.description="Finds artifacts based on patterns, uploads them to Seal, and links them to a Seal entity."

LABEL repository="https://github.com/opvia/change-order-github-app"
LABEL homepage="https://github.com/opvia/change-order-github-app"

LABEL maintainer="Seal <support@seal.run>"

ENTRYPOINT ["/entrypoint.sh"]
