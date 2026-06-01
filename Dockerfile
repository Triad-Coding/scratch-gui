# =====================================================================
# Triad-Coding/scratch-gui — build the BSD-3-Clause editor (4.1.7 base)
# and serve the static bundle with Static Web Server (SWS).
# Railway builds this repo directly, so `git push` == deploy.
# =====================================================================

# ---------- Stage 1: build scratch-gui ----------
FROM node:20-bookworm AS build
WORKDIR /src

# Build the local checkout (this repo), so your modifications are included.
COPY . .

RUN npm ci

# Origin allowed to embed + message this editor (your app). Baked in at build
# time and read by src/playground/embed-bridge.js via webpack DefinePlugin.
# Override per-environment:  --build-arg EMBED_PARENT_ORIGIN=https://app.example.com
ARG EMBED_PARENT_ORIGIN=https://app.yourdomain.com
ENV EMBED_PARENT_ORIGIN=${EMBED_PARENT_ORIGIN}

# REQUIRED: downloads the micro:bit firmware and generates
# src/generated/microbit-hex-url.cjs, which webpack imports. The build fails
# without it. Needs build-time network access to downloads.scratch.mit.edu.
RUN npm run prepublish

# Webpack 5 + Node 20 -> no --openssl-legacy-provider needed. Outputs to /src/build
RUN npm run build

# ---------- Stage 2: serve ----------
FROM joseluisq/static-web-server:2
COPY --from=build /src/build /public
COPY sws.toml /etc/sws.toml
