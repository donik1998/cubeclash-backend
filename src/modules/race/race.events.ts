/**
 * The wire vocabulary of the race gateway — spec §2/§3, read off three shipped
 * clients (Flutter `race_gateway.dart`, Android `core/realtime`, iOS
 * `Core/Realtime`). **Every string and every key here is already parsed in
 * production.** Renaming one silently breaks all three clients, so they live in
 * one place, named, rather than scattered as string literals a refactor could
 * quietly diverge.
 */

/** Client → server event names (spec §2). */
export const ClientEvent = {
  CREATE: 'race:create',
  JOIN: 'race:join',
  READY: 'race:ready',
  SOLVE_START: 'solve:start',
  SOLVE_STOP: 'solve:stop',
  LEAVE: 'race:leave',
} as const;

/** Server → client event names (spec §3). */
export const ServerEvent = {
  STATE: 'race:state',
  READY_UPDATE: 'race:ready_update',
  COUNTDOWN: 'race:countdown',
  SCRAMBLE: 'race:scramble',
  OPPONENT_PROGRESS: 'race:opponent_progress',
  RESULT: 'race:result',
  /** Not in the happy path: a validation refusal (e.g. an implausible time). */
  ERROR: 'race:error',
} as const;

/** The status string in `race:state` — the gateway phase, `ready-check` included. */
export type WireStatus = 'waiting' | 'ready-check' | 'countdown' | 'racing' | 'settled';

/** One player as `race:state.players[]` carries them (spec §3). `is_me` is per viewer. */
export interface StatePlayer {
  user_id: string;
  display_name: string;
  country: string | null;
  ready: boolean;
  /** Computed per recipient — true only in the payload sent to this player. */
  is_me: boolean;
  connected: boolean;
}

/** `race:state` — per-recipient, because of `is_me` and the code-hiding rule. */
export interface RaceStatePayload {
  race_id: string;
  status: WireStatus;
  /** Present only for a private room, and only to a participant. */
  code?: string;
  event: string;
  players: StatePlayer[];
}

/** `race:ready_update` — broadcastable; nothing viewer-relative. */
export interface ReadyUpdatePayload {
  user_id: string;
  ready: boolean;
}

/** `race:countdown` — `n` counts 3 → 2 → 1 → 0, where **0 means GO**. */
export interface CountdownPayload {
  n: number;
}

/** `race:scramble` — the same string to both, at the same instant; `\n` significant. */
export interface ScramblePayload {
  scramble: string;
}

/** `race:opponent_progress` — to each player, about *the other* one. */
export interface OpponentProgressPayload {
  running_ms: number;
}

/**
 * `race:result` — **per-recipient**. `result` is from this recipient's point of
 * view; `your_time`/`opp_time` are swapped per player and `elo_delta` is this
 * player's own signed delta (spec §3/§5).
 */
export interface RaceResultPayload {
  result: 'win' | 'loss';
  your_time: number | null;
  opp_time: number | null;
  opponent_dnf: boolean;
  elo_delta: number;
}

/** `solve:stop` client payload — the one number the server must never trust unchecked. */
export interface SolveStopPayload {
  client_time_ms: number;
}

/** `race:error` — a refusal the client can render (e.g. anti-cheat rejection). */
export interface RaceErrorPayload {
  code: string;
  message: string;
}
