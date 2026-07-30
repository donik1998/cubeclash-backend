# 🧊 CubeClash — Backend

The server for **CubeClash**, a competitive speedcubing app: a solo WCA timer plus live 1v1 head-to-head races. This repo is the backend — the centerpiece of a *Path to Big Tech* portfolio, built to demonstrate **backend and real-time systems ownership** end to end.

The Flutter client is already feature-complete against the contract below, so this is not designing into a vacuum: there is a real consumer with real expectations on the other end.

## Stack

| | |
|---|---|
| **Language** | TypeScript |
| **Framework** | NestJS — modular monolith |
| **Database** | PostgreSQL via **Drizzle** |
| **Cache / real-time state** | Redis |
| **Real-time** | WebSockets (Socket.IO) with the Redis adapter |
| **Auth** | JWT — short-lived access + refresh rotation |
| **Infra** | Docker · GitHub Actions · **Railway** |

Rationale for every one of those, and the alternatives that lost, is in ADR-001.

## Architecture

Two planes on one deployable:

- **Stateless REST** — auth, solves, sync, stats, leaderboards, lobby. Scales horizontally with no session affinity.
- **Stateful WebSocket race server** — server-authoritative live races. Room state lives in Redis and fans out over the Socket.IO Redis adapter, so any instance can serve any socket.

PostgreSQL is the source of truth; Redis holds only ephemeral or derived state (race rooms, matchmaking queue, leaderboard sorted sets, hot-read caches).

```
src/
  domain/     the seventeen WCA events — the facts the server must enforce
  db/         Drizzle schema, the DrizzleModule provider, migration runner
  common/     exception filter, logging interceptor, Redis, Socket.IO adapter
  config/     environment contract, validated at boot
  modules/    auth · users · solves · sync · scramble · stats
              leaderboard · race · friends · tournaments · health
drizzle/      generated SQL migrations (committed)
```

Each domain module layers the same way: **Controller (HTTP) / Gateway (WS) → Service → Repository (Drizzle)**, with DTO validation at the edge.

### Why a modular monolith

For a solo build it maximises shipping speed while still demonstrating real service boundaries. The module lines are drawn so the race tier can be lifted into its own service later without touching the rest — which is the point of drawing them now.

### Where the SQL is hand-written, on purpose

The statistics and leaderboard reads — ao5 / ao12 / ao100 windows, ranking, percentiles — are hand-written SQL behind the repository interface, not query-builder calls. Window functions are exactly where a typed builder stops paying for itself, and this is the part worth being able to explain out loud.

## Getting started

Requires Node 22+ and Docker.

```bash
cp .env.example .env      # then fill in the two JWT secrets
npm install
docker compose up -d      # Postgres + Redis
npm run db:migrate
npm run start:dev
```

Then:

```bash
curl localhost:3000/health
```

### Scripts

| Command | Does |
|---|---|
| `npm run start:dev` | Watch-mode server |
| `npm run build` | Compile to `dist/` |
| `npm run lint` · `npm run typecheck` | Static checks |
| `npm test` | Unit tests |
| `npm run test:e2e` | Integration tests against a real Postgres |
| `npm run db:generate` | Generate a migration from the schema |
| `npm run db:migrate` | Apply migrations (+ required extensions) |
| `npm run db:studio` | Drizzle Studio |

## Database

Tables are defined in TypeScript under `src/db/schema/`. Change a table, then:

```bash
npm run db:generate   # writes drizzle/NNNN_*.sql
npm run db:migrate    # applies it
```

Both the generated SQL and its metadata are committed, and CI fails if the schema and the migrations have drifted apart.

Migrations are applied by `src/db/migrate.ts` rather than `drizzle-kit migrate` directly, because the schema depends on the `citext` extension and drizzle-kit does not emit `CREATE EXTENSION`. Running the same entrypoint in dev, CI and production keeps a fresh database one command away from correct.

### Notes on the model

- **`solves.scramble` is text, but `\n` is significant.** Megaminx line breaks are semantic and Multi-Blind is N scrambles, one per line — exactly what TNoodle emits. The server does not parse notation; it only has to round-trip it byte for byte, which the integration suite asserts.
- **`time_ms` is the attempt's duration for every event.** Fewest Moves and Multi-Blind are timed too — they are simply not *ranked* on the clock. Rank on the event's own result, never on `time_ms` alone.
- **Three nullable long-form columns** (`move_count`, `solved_count`, `attempted_count`) carry FMC and MBLD results. They are null for the other fifteen events, where they are genuinely inapplicable rather than zero — and omitted from request bodies entirely, because an absent key says *inapplicable* where an explicit null does not.
- **`(user_id, client_id)` is unique.** That single constraint is what makes offline sync idempotent: a retried submit is a no-op, not a duplicate.
- **There is no `sessions` table.** A session is a client-side grouping; the server deliberately does not track practice activity session-wise.

## Testing

- **Unit** (`npm test`) — pure logic, no I/O.
- **Integration** (`npm run test:e2e`) — a real Postgres, migrated by the production entrypoint. Locally it starts one with Testcontainers; in CI it uses the workflow's service container. It tests the rules the schema encodes (case-insensitive email, sync idempotency, join-code reuse, cascade behaviour), not its column list.

## Deployment

One Railway project, three services — **app**, **PostgreSQL**, **Redis** — on private networking, with `DATABASE_URL` and `REDIS_URL` injected as reference variables rather than copied secrets. `railway.json` runs migrations as the pre-deploy step and health-checks `/health`.

> ⚠️ **Railway's private network is IPv6-only.** `*.railway.internal` has no A record. `src/common/redis/redis.module.ts` detects that hostname and forces `family: 6`, because ioredis otherwise defaults to IPv4 and fails with `ENOTFOUND`. This is the one known deployment trap on this path.

Persistent WebSocket connections are unproblematic here: the container does not sleep and there is no request timeout to fight, which is why the serverless-shaped hosts were never candidates.

Single-provider hosting is a single point of failure, mitigated by everything being Dockerized and the datastores being stock Postgres and Redis — moving to Fly + Neon + Upstash later is a config change, not a rewrite.

## Status

🚧 **Scaffolded.** Infrastructure is real and tested: schema, migrations, DI wiring, error contract, health checks, Docker, CI, deploy config. The ten domain modules are registered but empty — endpoints land next, starting with auth and solves.

## Clients

- `cubeclash-flutter` — primary cross-platform client, feature-complete MVP
- `cubeclash-ios` — native iOS (Swift), reserved
- `cubeclash-android` — native Android (Kotlin), reserved

## License

MIT © 2026 Doniyor Murodkulov

> Name is a working title — repo may be renamed once the product name is finalized.
