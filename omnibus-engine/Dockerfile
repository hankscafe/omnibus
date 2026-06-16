# syntax=docker/dockerfile:1

# ---- Chef base: Rust toolchain + cargo-chef + the C/C++ build deps ----
FROM rust:1.96-bookworm AS chef
WORKDIR /app
# System deps for the C/C++-backed crates: bzip2-sys, libwebp-sys (build via `cc`);
# clang/libclang-dev/pkg-config cover any bindgen use. (No libssl-dev: reqwest now uses rustls, not OpenSSL.)
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential clang libclang-dev pkg-config \
    && rm -rf /var/lib/apt/lists/*
RUN cargo install cargo-chef --locked

# ---- Planner: capture the dependency graph as a recipe (changes only when deps change) ----
FROM chef AS planner
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src
RUN cargo chef prepare --recipe-path recipe.json

# ---- Builder: cook deps (cached layer), then compile the app ----
FROM chef AS builder
COPY --from=planner /app/recipe.json recipe.json
# Compiles & caches ALL dependencies (incl. the slow vendored C/C++ builds). This layer is reused
# across source edits and only busts when Cargo.toml / Cargo.lock change.
RUN cargo chef cook --release --recipe-path recipe.json
COPY Cargo.toml Cargo.lock build.rs ./
COPY src ./src
RUN cargo build --release

# ---- Runtime ----
FROM debian:bookworm-slim
# Archive decoders for the converter: official `unrar` (non-free component; primary RAR decoder —
# unar corrupts some RAR 2.0 streams) and `unar` (format-agnostic fallback, handles genuine 7z .cb7).
RUN sed -i 's/Components: main/Components: main non-free/' /etc/apt/sources.list.d/debian.sources \
    && apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates libstdc++6 unar unrar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /app/target/release/omnibus-engine /usr/local/bin/omnibus-engine

# Listen on all interfaces so other containers (the Node web app) can reach the engine.
ENV OMNIBUS_ENGINE_BIND=0.0.0.0:8000

# Release version baked at build time (CI passes --build-arg OMNIBUS_VERSION=<package.json version>);
# the engine's /health endpoint reports it so the Node app can detect web/engine version drift.
# Written to a FILE rather than an ENV on purpose: container platforms (e.g. QNAP Container Station)
# materialize an image's ENV vars into the container definition and freeze them, which silently pins a
# stale version across image updates. A baked file can't be overridden that way.
ARG OMNIBUS_VERSION=""
RUN printf '%s' "${OMNIBUS_VERSION}" > /etc/omnibus-version

EXPOSE 8000

CMD ["omnibus-engine"]
