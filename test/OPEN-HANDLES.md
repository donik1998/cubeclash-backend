# Why `test:e2e` runs with `--forceExit`

The race gateway is the first thing in this codebase that owns timers and a
second Redis connection, and adding it stopped the e2e runner from exiting:

    Jest did not exit one second after the test run has completed.

CI runs `npm run test:e2e` with no timeout of its own, so that is not a warning
— it is a job that hangs until the runner kills it.

## Three real leaks, found and fixed

These were genuine bugs, not test noise. Each is fixed in `src/`, not papered
over here:

1. **`RedisIoAdapter` never closed its two Redis clients.** It creates a pub and
   a sub connection (Socket.IO needs both; a subscribing client cannot issue
   other commands) and nothing else in the provider graph owns them, so nothing
   ever shut them down. Now closed in an overridden `close()`.
2. **The progress relay's `setInterval` outlived the app.** `RaceGateway` had no
   `onModuleDestroy`, so every relay kept ticking after shutdown — and a tick
   firing into a torn-down app throws `Connection is closed` from the Redis
   adapter *synchronously*, which failed the whole suite rather than just
   logging. Now cleared on destroy, guarded by a `destroyed` flag, and the emit
   itself is wrapped.
3. **Countdown and disconnect-grace timers were untracked.** The countdown
   scheduled five bare `setTimeout`s and each disconnect scheduled a **30-second**
   grace timer. Every one is a live handle. They now go through a tracked
   `later()` helper and are cleared on destroy.

## What is left

After all three, the gateway spec passes cleanly (4/4, no suite errors) but the
process still does not exit, and `--detectOpenHandles` cannot attribute the
remaining handle — it prints nothing. A control run of `solves.e2e-spec.ts`,
which predates the gateway, exits in ~10s, so the residual is specific to this
spec's stack: two real `socket.io-client` connections, a Socket.IO server, and
the Redis adapter, on top of two testcontainers.

`--forceExit` is therefore a deliberate, scoped decision: the assertions have
all run and reported by the time it fires, so it cannot turn a red suite green.

**It does have a cost, and it is worth naming:** it will also hide the *next*
leak. If you add something to the gateway that holds the loop open, this flag
means you will not hear about it. Re-run without it periodically:

    npx jest --config ./test/jest-e2e.json --runInBand --detectOpenHandles
