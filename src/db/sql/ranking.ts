import { SQL, sql } from 'drizzle-orm';

import { solves, tournamentEntries } from '../schema';

/**
 * How a solve ranks against another solve of the same event.
 *
 * Everything competitive in this codebase — personal bests, leaderboards,
 * session statistics — reduces to one question: *is this attempt better than
 * that one?* The answer is not "compare `time_ms`", because three of the
 * seventeen events do not rank on the clock. Encoding it once, here, is what
 * keeps `is_pb` derivable rather than something a service has to remember to
 * write correctly on every path.
 */

/**
 * A single sortable key per solve. **Lower is better. NULL means unranked.**
 *
 * The three branches use different units — milliseconds, move counts, and the
 * WCA's packed multi-blind integer. That is safe, and only safe, because every
 * comparison below partitions by `event`: two keys are never compared across
 * event boundaries.
 *
 * - **Timed events (15 of 17)** — `time_ms`, plus 2,000 ms when a `+2` applies.
 *   The penalty has to be folded in here rather than at the call site, or a
 *   penalised solve would out-rank a clean one it actually lost to.
 *
 * - **Fewest Moves** — the solution length. FMC is timed (one hour, Regulation
 *   E2) but is not *ranked* on the clock, so `time_ms` is the wrong key
 *   entirely. `+2` is meaningless on a move count and the client hides it.
 *
 * - **Multi-Blind** — ranked by points, then by time (Regulation 9f12), which is
 *   two keys, not one. Rather than invent an encoding, this uses **the WCA's
 *   own**: `(99 − points) × 10^7 + seconds × 100 + missed`, the format the WCA
 *   results database itself stores. It sorts points-then-time correctly as a
 *   plain integer, and being the standard means it needs no defending.
 *   Regulation 9f12 also auto-DNFs an attempt below two solved cubes or at a
 *   non-positive score — expressed here as NULL, the same as any other DNF.
 *
 * A `dnf` penalty is NULL everywhere: not a slow result, a non-result. NULL
 * keys are ignored by `MIN()`, so a DNF can neither be a personal best nor
 * reset the record it failed to beat.
 */
export const rankingKey: SQL<number | null> = sql`
  case
    when ${solves.penalty} = 'dnf' then null

    when ${solves.event} = '3x3-fmc' then ${solves.moveCount}

    when ${solves.event} = '3x3-mbld' then
      case
        when ${solves.solvedCount} is null
          or ${solves.attemptedCount} is null
          or ${solves.solvedCount} < 2
          or (${solves.solvedCount} - (${solves.attemptedCount} - ${solves.solvedCount})) <= 0
        then null
        else
          (99 - (${solves.solvedCount} - (${solves.attemptedCount} - ${solves.solvedCount}))) * 10000000
          + least(${solves.timeMs} / 1000, 99999) * 100
          + (${solves.attemptedCount} - ${solves.solvedCount})
      end

    else ${solves.timeMs}
       + case when ${solves.penalty} = 'plus2' then 2000 else 0 end
  end
`;
// Deliberately int4 throughout, with no widening cast. The largest value this
// can produce is a multi-blind key at just under 1e9 — comfortably inside int4,
// and an hour-long attempt in milliseconds is only 3.6e6. Staying in int4 means
// the driver hands back a JS `number`; an int8 would arrive as a *string*,
// because node-postgres will not silently risk precision loss, and the declared
// type above would then be a lie.

/**
 * Whether a solve was a personal best **at the moment it was set**.
 *
 * This is the historical badge a timer shows next to the solve that broke a
 * record — not "is this currently your best", which would be true of exactly
 * one row. So the frame is every *earlier* solve of the same event and nothing
 * after it.
 *
 * `MIN(...) OVER (... ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING)` is the
 * whole trick. For the first ranked solve the frame is empty, the minimum is
 * NULL, and the comparison is NULL — so `COALESCE` falls back to "a first
 * ranked result is always a personal best".
 *
 * **Why this is derived and not stored.** `PATCH /solves/:id { penalty }` lets a
 * cuber apply a `+2` or a DNF to a solve after the fact — which is a normal
 * thing to do, and which changes that solve's ranking key. A stored `is_pb`
 * would then be wrong not just on that row but on every later row whose record
 * it used to hold, and fixing it means recomputing a user's whole history on
 * every penalty edit. Derived, the edit simply changes the answer. The column
 * this replaces was a cache with no invalidation.
 *
 * Callers must exclude soft-deleted rows in the same query's WHERE clause;
 * Postgres applies WHERE before window functions, so a deleted solve correctly
 * drops out of the frame rather than holding a record it no longer has.
 */
export const isPersonalBest: SQL<boolean> = sql`
  coalesce(
    ${rankingKey} < min(${rankingKey}) over (
      partition by ${solves.userId}, ${solves.event}
      order by ${solves.solvedAt}, ${solves.id}
      rows between unbounded preceding and 1 preceding
    ),
    ${rankingKey} is not null
  )
`;

/** Ordering fragment: best first, unranked (DNF) last. */
export const bestFirst: SQL = sql`${rankingKey} asc nulls last`;

/**
 * A competitor's place in a tournament, derived from their best time.
 *
 * `RANK()` and not `ROW_NUMBER()`: a tie is a tie, and two people on the same
 * time should both read 3rd rather than one of them losing a coin flip to
 * whatever order the planner happened to produce.
 *
 * Replaces a stored `tournament_entries.rank`. A stored rank has to be
 * recomputed every time anyone in the field improves a time — so it is either
 * wrong between recomputes, or it needs a job whose only purpose is to
 * re-derive what this line derives for free.
 */
export const tournamentRank: SQL<number> = sql`
  rank() over (
    partition by ${tournamentEntries.tournamentId}
    order by ${tournamentEntries.bestTimeMs} asc nulls last
  )
`;
