# syntax=docker/dockerfile:1

# Pin the official multi-architecture Dev Containers image by digest. The
# upstream image supplies the non-root `node` user and Codespaces utilities;
# the repository's exact Node.js release is installed and verified below.
FROM mcr.microsoft.com/devcontainers/javascript-node:5.1.2-24-bookworm@sha256:fe599ef9d866c4adb1fbb1f8a37af2892a090e5fd0d93feb8471e9de15a5f14d

ARG NODE_VERSION=24.20.0
ARG NODE_SHA256_AMD64=2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2
ARG NODE_SHA256_ARM64=5f4ddab610c1ab2016b3c227cebdbf6d9495161487e4739c7b90090595f465f7
ARG COREPACK_VERSION=0.36.0
ARG COREPACK_SHA512=4a2889b01859a9d0623c74c497a393dec012ad1aca21c61340cb15197c7a104fe033c5853306237885fc4edf11894e08bf627a2db4fc2a919f08eb01a51581ff
ARG PNPM_VERSION=11.24.0
ARG PNPM_SHA512=bd27e345e976dcb0be0b7a1228217b049a817e21b1f355c90dbe7dc46671895a8bc1e6d06c24554505ea93ea0b45f489a27ec1bfbc8de6a9659fca0f16fa0000

ENV COREPACK_HOME=/usr/local/share/corepack
ENV PATH=/usr/local/bin:${PATH}

# Node.js and Corepack archives are fetched at exact versions and checked
# against their publisher-provided hashes. Corepack then verifies pnpm against
# the pinned SHA-512 descriptor while priming a cache shared with `node`.
RUN set -eux; \
    case "$(dpkg --print-architecture)" in \
      amd64) node_arch='x64'; node_sha256="${NODE_SHA256_AMD64}" ;; \
      arm64) node_arch='arm64'; node_sha256="${NODE_SHA256_ARM64}" ;; \
      *) echo 'Unsupported architecture; expected amd64 or arm64.' >&2; exit 1 ;; \
    esac; \
    node_archive="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz"; \
    curl --fail --silent --show-error --location \
      --output "/tmp/${node_archive}" \
      "https://nodejs.org/dist/v${NODE_VERSION}/${node_archive}"; \
    echo "${node_sha256}  /tmp/${node_archive}" | sha256sum --check --strict; \
    tar --extract --xz --file "/tmp/${node_archive}" \
      --directory /usr/local --strip-components=1 --no-same-owner; \
    rm "/tmp/${node_archive}"; \
    test "$(node --version)" = "v${NODE_VERSION}"; \
    corepack_archive="/tmp/corepack-${COREPACK_VERSION}.tgz"; \
    curl --fail --silent --show-error --location \
      --output "${corepack_archive}" \
      "https://registry.npmjs.org/corepack/-/corepack-${COREPACK_VERSION}.tgz"; \
    echo "${COREPACK_SHA512}  ${corepack_archive}" | sha512sum --check --strict; \
    npm install --global --prefix /usr/local --force --ignore-scripts "${corepack_archive}"; \
    rm "${corepack_archive}"; \
    corepack enable --install-directory /usr/local/bin pnpm; \
    mkdir -p "${COREPACK_HOME}"; \
    corepack install --global "pnpm@${PNPM_VERSION}+sha512.${PNPM_SHA512}"; \
    chown -R node:node "${COREPACK_HOME}"; \
    test "$(corepack --version)" = "${COREPACK_VERSION}"; \
    test "$(pnpm --version)" = "${PNPM_VERSION}"
