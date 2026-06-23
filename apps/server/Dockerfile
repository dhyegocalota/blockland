# --- build stage ---
# Built from the REPO ROOT (docker-compose context: .) so .git is present and the build can bake the
# deploy's short SHA into the binary automatically — no per-deploy GIT_SHA arg to set.
# IMPORTANT: in Dokploy set the build context to the repo root (or use Docker Compose), not apps/server.
FROM rust:1-slim-bookworm AS build
WORKDIR /app

# libsql bundles SQLite (C) and links via clang/bindgen; git lets the build read the deploy SHA.
RUN apt-get update \
 && apt-get install -y --no-install-recommends clang libclang-dev pkg-config git \
 && rm -rf /var/lib/apt/lists/*

# Cache dependency builds: copy manifests + stub sources first.
COPY apps/server/Cargo.toml ./
COPY apps/server/crates/protocol/Cargo.toml crates/protocol/Cargo.toml
COPY apps/server/crates/sim/Cargo.toml crates/sim/Cargo.toml
COPY apps/server/crates/server/Cargo.toml crates/server/Cargo.toml
RUN mkdir -p crates/protocol/src crates/sim/src crates/server/src \
 && echo "" > crates/protocol/src/lib.rs \
 && echo "" > crates/sim/src/lib.rs \
 && echo "fn main() {}" > crates/server/src/main.rs \
 && cargo build --release -p server || true

# Real sources + .git so the build can resolve the short SHA. git refuses a repo owned by another user
# inside the container, so mark it safe; export BUILD_GIT_SHA before the build (option_env! reads it).
COPY apps/server/crates ./crates
COPY .git ./.git
RUN git config --global --add safe.directory /app \
 && export BUILD_GIT_SHA="$(git rev-parse --short HEAD)" \
 && echo "baking backend version: $BUILD_GIT_SHA" \
 && touch crates/*/src/*.rs && cargo build --release -p server

# --- runtime stage ---
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/server /usr/local/bin/server
COPY apps/server/tenants.toml /etc/blockland/tenants.toml
ENV TENANTS_FILE=/etc/blockland/tenants.toml \
    DATABASE_PATH=/var/lib/blockland/blockland.db \
    BIND=0.0.0.0:8080 \
    RUST_LOG=info,server=debug
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD curl -fsS http://localhost:8080/healthz || exit 1
CMD ["server"]
