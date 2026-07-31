/**
 * `POST /races` response — spec §8: `{ race_id, code? }`.
 *
 * Deliberately *not* the full race. Creation answers the two things the client
 * needs to proceed: the id to open a socket against, and — for a private room —
 * the code to share. A quick-match room has no code (it enqueues; there is
 * nothing to share), so the key is omitted rather than sent as null, matching
 * the absent-vs-null convention used across the API.
 */
export interface CreateRaceResponseDto {
  race_id: string;
  code?: string;
}
