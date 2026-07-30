/**
 * The seventeen official WCA events, as the backend needs to know them.
 *
 * This is a deliberately small mirror of the client's `WcaEvent` registry
 * (`cubeclash-flutter/lib/features/timer/domain/entities/wca_event.dart`) —
 * only the facts the *server* has to enforce live here:
 *
 *  - the wire id, because it is a column value and a query parameter;
 *  - `resultKind`, because it decides which of the three nullable long-form
 *    columns a `POST /solves` body may carry, and how a result ranks;
 *  - `format`, because the stats layer computes per-event aggregates;
 *  - `raceable` / `quickMatch`, because `POST /races` must reject an event
 *    outside the set rather than enqueue a match that will never fill.
 *
 * Notation, icons and session-card layout are client concerns and are
 * deliberately absent.
 *
 * Ids extend the ones already in the database (`3x3`, `4x4`) rather than the
 * WCA's own `333`/`444` codes: existing rows stay valid and the ids stay
 * readable in a log.
 */

/** How an attempt's result is expressed — decides ranking and column use. */
export type ResultKind = 'time' | 'move_count' | 'multi_blind';

/** Competition format, WCA Regulation 9b. */
export type EventFormat = 'ao5' | 'mo3' | 'bo3' | 'bo1';

export interface WcaEventSpec {
  readonly id: string;
  readonly name: string;
  readonly format: EventFormat;
  readonly resultKind: ResultKind;
  /** Whether a private race room will accept this event. */
  readonly raceable: boolean;
  /** Whether the matchmaking queue will search for it. Stricter than `raceable`. */
  readonly quickMatch: boolean;
  /** Attempt cap inherent to the event (Regulations E2, H1b), in ms. */
  readonly attemptLimitMs?: number;
}

const HOUR_MS = 60 * 60 * 1000;

export const WCA_EVENTS: readonly WcaEventSpec[] = [
  // --- Cubes ---------------------------------------------------------------
  { id: '2x2', name: '2×2 Cube', format: 'ao5', resultKind: 'time', raceable: true, quickMatch: true }, // prettier-ignore
  { id: '3x3', name: '3×3 Cube', format: 'ao5', resultKind: 'time', raceable: true, quickMatch: true }, // prettier-ignore
  { id: '4x4', name: '4×4 Cube', format: 'ao5', resultKind: 'time', raceable: true, quickMatch: false }, // prettier-ignore
  { id: '5x5', name: '5×5 Cube', format: 'ao5', resultKind: 'time', raceable: true, quickMatch: false }, // prettier-ignore
  { id: '6x6', name: '6×6 Cube', format: 'mo3', resultKind: 'time', raceable: true, quickMatch: false }, // prettier-ignore
  { id: '7x7', name: '7×7 Cube', format: 'mo3', resultKind: 'time', raceable: true, quickMatch: false }, // prettier-ignore

  // --- Other puzzles -------------------------------------------------------
  { id: '3x3-oh', name: '3×3 One-Handed', format: 'ao5', resultKind: 'time', raceable: true, quickMatch: true }, // prettier-ignore
  { id: 'clock', name: 'Clock', format: 'ao5', resultKind: 'time', raceable: true, quickMatch: false }, // prettier-ignore
  { id: 'megaminx', name: 'Megaminx', format: 'ao5', resultKind: 'time', raceable: true, quickMatch: false }, // prettier-ignore
  { id: 'pyraminx', name: 'Pyraminx', format: 'ao5', resultKind: 'time', raceable: true, quickMatch: false }, // prettier-ignore
  { id: 'skewb', name: 'Skewb', format: 'ao5', resultKind: 'time', raceable: true, quickMatch: false }, // prettier-ignore
  { id: 'square-1', name: 'Square-1', format: 'ao5', resultKind: 'time', raceable: true, quickMatch: false }, // prettier-ignore

  // --- Blindfolded ---------------------------------------------------------
  // Never raceable: the memorisation phase is *inside* the timed attempt, and
  // nothing on screen can tell concentrating from stalling.
  { id: '3x3-bld', name: '3×3 Blindfolded', format: 'bo3', resultKind: 'time', raceable: false, quickMatch: false }, // prettier-ignore
  { id: '4x4-bld', name: '4×4 Blindfolded', format: 'bo3', resultKind: 'time', raceable: false, quickMatch: false }, // prettier-ignore
  { id: '5x5-bld', name: '5×5 Blindfolded', format: 'bo3', resultKind: 'time', raceable: false, quickMatch: false }, // prettier-ignore

  // --- Special -------------------------------------------------------------
  { id: '3x3-fmc', name: '3×3 Fewest Moves', format: 'mo3', resultKind: 'move_count', raceable: false, quickMatch: false, attemptLimitMs: HOUR_MS }, // prettier-ignore
  { id: '3x3-mbld', name: '3×3 Multi-Blind', format: 'bo1', resultKind: 'multi_blind', raceable: false, quickMatch: false, attemptLimitMs: HOUR_MS }, // prettier-ignore
] as const;

const BY_ID = new Map<string, WcaEventSpec>(WCA_EVENTS.map((e) => [e.id, e]));

export const EVENT_IDS: readonly string[] = WCA_EVENTS.map((e) => e.id);

export const RACEABLE_EVENT_IDS: readonly string[] = WCA_EVENTS.filter((e) => e.raceable).map(
  (e) => e.id,
);

export const QUICK_MATCH_EVENT_IDS: readonly string[] = WCA_EVENTS.filter((e) => e.quickMatch).map(
  (e) => e.id,
);

export function findEvent(id: string): WcaEventSpec | undefined {
  return BY_ID.get(id);
}

export function isKnownEvent(id: string): boolean {
  return BY_ID.has(id);
}

export function isRaceable(id: string): boolean {
  return BY_ID.get(id)?.raceable ?? false;
}

export function isQuickMatch(id: string): boolean {
  return BY_ID.get(id)?.quickMatch ?? false;
}

/**
 * Which of the three long-form columns an event is allowed to populate.
 *
 * The API contract is that these keys are **omitted entirely** for the events
 * they do not apply to — an absent key says *inapplicable*, where an explicit
 * null does not.
 */
export function allowedResultColumns(id: string): readonly string[] {
  switch (BY_ID.get(id)?.resultKind) {
    case 'move_count':
      return ['move_count'];
    case 'multi_blind':
      return ['solved_count', 'attempted_count'];
    default:
      return [];
  }
}
