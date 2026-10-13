# CodeArena API.
#
# Two stages: a builder with the Rust toolchain and librdkafka's build
# dependencies, and a slim runtime that carries only the binary. The runtime has
# no compiler, by design — the API must never be able to build or run submitted
# code.

# ---------------------------------------------------------------- build stage
FROM rust:1.99-bookworm AS builder

# librdkafka is compiled from source by the `rdkafka` crate's cmake-build
# feature; these are its headers.
RUN apt-get update && apt-get install -y --no-install-recommends \
        cmake \
        libssl-dev \
        libsasl2-dev \
        libcurl4-openssl-dev \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

# Dependencies first, so editing application code does not rebuild the world.
COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src/bin \
    && echo 'fn main() {}' > src/main.rs \
    && echo 'fn main() {}' > src/bin/worker.rs \
    && echo 'fn main() {}' > src/bin/dlq.rs \
    && echo '' > src/lib.rs \
    && cargo build --release --bin codearena-api \
    && rm -rf src

COPY src ./src
COPY migrations ./migrations
# COPY keeps the files' old mtimes, which are older than the stub build above,
# so cargo would reuse the empty stub library. Touch every source file.
RUN find src -name '*.rs' -exec touch {} + \
    && cargo build --release --bin codearena-api

# A health check that needs no curl in the runtime image.
RUN printf '%s\n' \
    '#!/bin/sh' \
    'exec /usr/bin/wget -q -O /dev/null "http://127.0.0.1:${PORT:-8080}/api/v1/health"' \
    > /healthcheck.sh && chmod +x /healthcheck.sh

# -------------------------------------------------------------- runtime stage
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        wget \
        zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home --shell /usr/sbin/nologin codearena

COPY --from=builder /build/target/release/codearena-api /usr/local/bin/codearena-api
COPY --from=builder /healthcheck.sh /usr/local/bin/codearena-healthcheck

# The API has no business being root, and nothing here needs privileges.
USER 10001:10001
WORKDIR /home/codearena

EXPOSE 8080
ENV BIND_ADDR=0.0.0.0:8080 \
    RUNNER_STRATEGY=disabled

ENTRYPOINT ["/usr/local/bin/codearena-api"]
