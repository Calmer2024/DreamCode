ARG BASE_IMAGE=dreameval-agents-build-base:2026-10-10
FROM ${BASE_IMAGE}
USER root
WORKDIR /opt/harness
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund \
 && chmod -R a+rX /opt/harness
COPY sdk/package.json sdk/package-lock.json ./sdk/
RUN npm ci --prefix sdk --no-audit --no-fund \
 && chmod -R a+rX /opt/harness/sdk
USER 10001:10001
