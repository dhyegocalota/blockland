# --- build stage ---
FROM rust:1-slim-bookworm AS build
WORKDIR /app

# libsql bundles SQLite (C) and links via clang/bindgen.
RUN apt-get update \
 && apt-get install -y --no-install-recommends clang libclang-dev pkg-config \
 && rm -rf /var/lib/apt/lists/*

# Cache dependency builds: copy manifests + stub sources first.
COPY Cargo.toml ./
COPY crates/protocol/Cargo.toml crates/protocol/Cargo.toml
COPY crates/sim/Cargo.toml crates/sim/Cargo.toml
COPY crates/server/Cargo.toml crates/server/Cargo.toml
RUN mkdir -p crates/protocol/src crates/sim/src crates/server/src \
 && echo "" > crates/protocol/src/lib.rs \
 && echo "" > crates/sim/src/lib.rs \
 && echo "fn main() {}" > crates/server/src/main.rs \
 && cargo build --release -p server || true

# Real sources.
COPY crates ./crates
RUN touch crates/*/src/*.rs && cargo build --release -p server

# --- runtime stage ---
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/server /usr/local/bin/server
COPY tenants.toml /etc/blockland/tenants.toml
ENV TENANTS_FILE=/etc/blockland/tenants.toml \
    DATABASE_PATH=/var/lib/blockland/blockland.db \
    BIND=0.0.0.0:8080 \
    RUST_LOG=info,server=debug
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD curl -fsS http://localhost:8080/healthz || exit 1
CMD ["server"]
