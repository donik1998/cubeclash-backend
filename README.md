# 🧊 CubeClash — Backend

The server for **CubeClash**, a competitive speedcubing app: a solo WCA timer plus live 1v1 head-to-head races. This repo is the backend — the centerpiece of a *Path to Big Tech* portfolio, built to demonstrate **backend and real-time systems ownership** end to end.

## Stack
- **Language:** TypeScript
- **Framework:** NestJS (modular monolith)
- **Database:** PostgreSQL via Prisma
- **Cache / real-time state:** Redis
- **Real-time:** WebSockets (Socket.IO)
- **Auth:** JWT (short-lived access + refresh rotation)
- **Infra:** Docker · GitHub Actions CI · deploy to Fly.io / Railway

## Architecture
Two planes on one deployable:
- **Stateless REST** — auth, solves, stats, leaderboards, lobby. Scales horizontally.
- **Stateful WebSocket race server** — server-authoritative live races; room state in Redis, pub/sub backplane for horizontal scale.

PostgreSQL is the source of truth; Redis holds ephemeral/hot state (race rooms, leaderboard sorted sets, matchmaking queue).

## Status
🚧 **Scaffolding.** Product, design, and engineering specs are complete; implementation is starting.

## Clients
- `cubeclash-flutter` — primary cross-platform client
- `cubeclash-ios` — native iOS (Swift)
- `cubeclash-android` — native Android (Kotlin)

## License
MIT © 2026 Doniyor Murodkulov

> Name is a working title — repo may be renamed once the product name is finalized.
