# =====================================================================
# Triad-Coding/scratch-gui — build the BSD-3-Clause editor (4.1.7 base)
# and serve the static bundle with Static Web Server (SWS).
# Railway builds this repo directly, so `git push` == deploy.
#
# Single source of truth: the EMBED_PARENT_ORIGIN build arg drives BOTH
#   (a) the JS origin check, via webpack DefinePlugin, and
#   (b) the SWS frame-ancestors header, via template substitution below.
# Set it per environment (staging vs production) and the two can't drift.
# =====================================================================

# ---------- Stage 1: build scratch-gui ----------
FROM node:20-bookworm AS build
WORKDIR /src
COPY . .
RUN npm ci

# Required, no default: each environment must set its own origin explicitly.
# The build fails loudly rather than silently baking in the wrong origin.
ARG EMBED_PARENT_ORIGIN
RUN test -n "${EMBED_PARENT_ORIGIN}" \
    || { echo "ERROR: EMBED_PARENT_ORIGIN build arg is required (e.g. https://app.yourdomain.com)"; exit 1; }
ENV EMBED_PARENT_ORIGIN=${EMBED_PARENT_ORIGIN}

# Generate sws.toml from the template using the SAME value baked into the JS.
# `|` delimiter avoids escaping the slashes in the origin URL.
RUN sed "s|__EMBED_PARENT_ORIGIN__|${EMBED_PARENT_ORIGIN}|g" sws.toml.template > sws.toml

# Required: downloads micro:bit firmware -> generates src/generated/microbit-hex-url.cjs
# (webpack imports it; build fails without it). Needs net access to downloads.scratch.mit.edu.
RUN npm run prepublish

# Webpack 5 + Node 20 -> no --openssl-legacy-provider needed. Outputs to /src/build
RUN npm run build

# ---------- Stage 2: serve ----------
FROM joseluisq/static-web-server:2
COPY --from=build /src/build /public
COPY --from=build /src/sws.toml /etc/sws.toml