# Blockland load/stress harness

A 1000-bot WebSocket load test for the Rust multiplayer server. Each bot joins a tenant's room as a
guest and runs a realistic mix of actions — running, flying, digging, placing/breaking blocks, hitting
creatures, PvP, and chatting — spread across the giant map so per-player AOI culling is exercised. Bots
decode the binary snapshot frames (mirroring `crates/protocol/src/snapshot_codec.rs`) to target nearby
creatures and players, and count the bytes/frames they receive.

It measures the real wire cost under load: total RX, **avg RX bytes/sec per bot**, avg frames/sec, and
the p50/p95 per-bot RX, plus the per-action send counts so you can see the mix.

## Install

```bash
cd apps/server/loadtest
npm install
```

## Run against a local server

By default the harness opens 1000 bots from one machine (one IP) into one room. The shipped server caps
players-per-room at 10 and connections-per-IP at 6, so you must raise both via env when you boot the
server, or every bot past the cap is rejected:

```bash
# in apps/server, with the server built:
MAX_PLAYERS_PER_ROOM=1000 MAX_CONNECTIONS_PER_IP=2000 cargo run --release
```

(Both env vars are read in `crates/server/src/hub.rs`; unset/garbage falls back to the shipped defaults.)

Then, in another terminal:

```bash
cd apps/server/loadtest
BOTS=1000 DURATION_S=30 URL=ws://localhost:8080/ws TENANT=acme npm start
```

## Run against the docker server

Boot the server image with the two caps raised, publishing port 8080:

```bash
docker run --rm -p 8080:8080 \
  -e MAX_PLAYERS_PER_ROOM=1000 \
  -e MAX_CONNECTIONS_PER_IP=2000 \
  blockland-server
```

Then point the harness at it:

```bash
cd apps/server/loadtest
BOTS=1000 DURATION_S=30 URL=ws://localhost:8080/ws TENANT=acme npm start
```

## Options (env / CLI)

| Var | Default | Meaning |
| --- | --- | --- |
| `BOTS` | `1000` | Number of bots to connect. |
| `DURATION_S` | `30` | How long to run after the ramp. |
| `URL` | `ws://localhost:8080/ws` | Server WebSocket endpoint. |
| `TENANT` | `acme` | Tenant whose room the bots join. |
| `SPREAD` | `1` | `1` = scatter bots across the whole map (AOI matters); `0` = cluster near the origin (busy-room worst case). |
| `RAMP_BATCH` | `50` | Connections opened per ramp batch (so the box isn't hammered). |
| `RAMP_DELAY_MS` | `100` | Pause between ramp batches. |

## Smoke test

A quick 5-bot / 5-second run to confirm connectivity and the metrics output:

```bash
BOTS=5 DURATION_S=5 npm start
```
