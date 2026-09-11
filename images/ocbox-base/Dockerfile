# syntax=docker/dockerfile:1.7

# Pin generated timestamps (config created, history, and index annotation) so the
# classic-load and attested-OCI builds of the same context produce the same
# config digest. CI overrides this with the source commit time.
ARG SOURCE_DATE_EPOCH=0
ARG BASE_IMAGE=node:24-bookworm-slim@sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa
FROM --platform=linux/amd64 ${BASE_IMAGE}

ARG DEBIAN_SNAPSHOT=20260908T000000Z
ARG COREPACK_VERSION=0.36.0
ARG COREPACK_INTEGRITY=sha512-SiiJsBhZqdBiPHTEl6OT3sASrRrKIcYTQMsVGXx6EE/gM8WFMwYjeIX8Tt8RiU4Iv2J6LbT8KpGfCOsBpRWB/w==
ARG PNPM_VERSION=11.24.0
ARG PNPM_INTEGRITY=sha512-vSfjRel23LC+C3oSKCF7BJqBfiGx81XJDb59xGZxiVqLwebQbCRVRQXqk+oLRfSJon7Bv7yN5qlln8oPFvoAAA==

LABEL org.opencontainers.image.source="https://github.com/yamedoff/ocbox-cli" \
      org.opencontainers.image.title="OpenCloudBox base image" \
      org.opencontainers.image.description="Reproducible non-root development runtime for OpenCloudBox sandboxes" \
      org.opencontainers.image.url="https://github.com/yamedoff/ocbox-cli" \
      org.opencontainers.image.documentation="https://github.com/yamedoff/ocbox-cli/blob/main/docs/image-release-policy.md" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.base.name="docker.io/library/node:24-bookworm-slim" \
      org.opencontainers.image.base.digest="sha256:6642ef280aebc09c4541bee0b15c9f89f0f3f3c247ddee79ae1d37eddfdcbbaa"

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Snapshot URLs freeze package resolution. The base image is Debian Bookworm,
# whose deb822 sources are present at this path.
RUN sed -ri \
      -e "s#http://deb.debian.org/debian-security#https://snapshot.debian.org/archive/debian-security/${DEBIAN_SNAPSHOT}#g" \
      -e "s#http://deb.debian.org/debian#https://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT}#g" \
      /etc/apt/sources.list.d/debian.sources \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends \
      build-essential \
      ca-certificates \
      curl \
      git \
      gzip \
      jq \
      openssh-client \
      patch \
      python3 \
      ripgrep \
      tar \
      tini \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Download exact archives, verify registry SRI before installation, then remove
# npm cache and archives from the layer. No package lifecycle scripts run.
RUN npm pack "corepack@${COREPACK_VERSION}" --pack-destination /tmp \
    && node -e 'const c=require("node:crypto"),f=require("node:fs");const a="sha512-"+c.createHash("sha512").update(f.readFileSync(process.argv[1])).digest("base64");if(a!==process.argv[2])process.exit(1)' \
      "/tmp/corepack-${COREPACK_VERSION}.tgz" "${COREPACK_INTEGRITY}" \
    && npm install --global --ignore-scripts --force "/tmp/corepack-${COREPACK_VERSION}.tgz" \
    && npm pack "pnpm@${PNPM_VERSION}" --pack-destination /tmp \
    && node -e 'const c=require("node:crypto"),f=require("node:fs");const a="sha512-"+c.createHash("sha512").update(f.readFileSync(process.argv[1])).digest("base64");if(a!==process.argv[2])process.exit(1)' \
      "/tmp/pnpm-${PNPM_VERSION}.tgz" "${PNPM_INTEGRITY}" \
    && npm install --global --ignore-scripts --force "/tmp/pnpm-${PNPM_VERSION}.tgz" \
    && node --version | grep -Fx 'v24.20.0' \
    && corepack --version | grep -Fx "${COREPACK_VERSION}" \
    && pnpm --version | grep -Fx "${PNPM_VERSION}" \
    && npm cache clean --force \
    && rm -rf /root/.npm /root/.cache /tmp/corepack-*.tgz /tmp/pnpm-*.tgz

RUN groupadd --gid 10001 ocbox \
    && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/ocbox --shell /bin/bash ocbox \
    && install -d -o ocbox -g ocbox -m 0750 /opt/ocbox/bin /workspace

# Install the compiled CLI bundle and its oclif manifest. The bundle inlines its
# production dependencies, so the image ships no node_modules tree.
COPY --chown=ocbox:ocbox package.json /opt/ocbox/cli/package.json
COPY --chown=ocbox:ocbox dist /opt/ocbox/cli/dist

# T5 owns the compiled versioned helper. Building T7 from a branch without T5
# must fail here instead of silently installing a shell-string fallback. The
# helper is a single self-contained file at its fixed contract path.
COPY --chown=ocbox:ocbox dist/execution-helper.js /opt/ocbox/bin/ocbox-exec-helper.js
COPY --chown=root:root images/ocbox-base/entrypoint.sh images/ocbox-base/readiness.sh images/ocbox-base/ocbox /opt/ocbox/bin/
RUN chmod 0555 /opt/ocbox/bin/entrypoint.sh /opt/ocbox/bin/readiness.sh /opt/ocbox/bin/ocbox \
    && chmod 0444 /opt/ocbox/bin/ocbox-exec-helper.js

ENV HOME=/home/ocbox \
    PATH=/opt/ocbox/bin:/usr/local/bin:/usr/bin:/bin \
    SHELL=/bin/bash

USER 10001:10001
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/ocbox/bin/entrypoint.sh"]
CMD ["bash"]
