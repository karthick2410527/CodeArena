# CodeArena judge worker.
#
# This is the only image that contains a C++ compiler, because it is the only
# process that compiles and executes submitted code.
#
# The runtime image is deliberately larger than the API's: it needs `g++` and
# the C++ standard library. It also carries the `docker` CLI, used only by
# `RUNNER_STRATEGY=docker`; with the default `local` strategy it goes unused and
# no socket is mounted (see docker-compose.yml and docs/SECURITY.md).

# ---------------------------------------------------------------- build stage
FROM rust:1.99-bookworm AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
        cmake \
        libssl-dev \
        libsasl2-dev \
        libcurl4-openssl-dev \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build

COPY Cargo.toml Cargo.lock ./
RUN mkdir -p src/bin \
    && echo 'fn main() {}' > src/main.rs \
    && echo 'fn main() {}' > src/bin/worker.rs \
    && echo 'fn main() {}' > src/bin/dlq.rs \
    && echo '' > src/lib.rs \
    && cargo build --release --bin codearena-worker \
    && rm -rf src

COPY src ./src
COPY migrations ./migrations
RUN find src -name '*.rs' -exec touch {} + \
    && cargo build --release --bin codearena-worker --bin codearena-dlq

# -------------------------------------------------------------- runtime stage
FROM debian:bookworm-slim

# g++ and libstdc++ for compiling submissions; docker-cli only for the
# optional per-run-container strategy.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        g++ \
        libstdc++-12-dev \
        zlib1g \
        docker.io \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/target/release/codearena-worker /usr/local/bin/codearena-worker
COPY --from=builder /build/target/release/codearena-dlq /usr/local/bin/codearena-dlq

# Sandboxes are created here. Compose mounts a tmpfs over it.
RUN mkdir -p /sandbox && chmod 1777 /sandbox
ENV RUNNER_WORKDIR=/sandbox \
    RUNNER_STRATEGY=local \
    RUNNER_UID=65534 \
    RUNNER_GID=65534

# Intentionally root: the local strategy starts as root purely so it can drop
# to uid 65534 for each sandboxed process, which an unprivileged process cannot
# do. The container itself runs with cap_drop=ALL, no-new-privileges, a
# read-only root filesystem and bounded pids/memory — see docker-compose.yml.
USER 0:0
WORKDIR /

ENTRYPOINT ["/usr/local/bin/codearena-worker"]
