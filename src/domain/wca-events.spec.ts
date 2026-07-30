import {
  EVENT_IDS,
  QUICK_MATCH_EVENT_IDS,
  RACEABLE_EVENT_IDS,
  WCA_EVENTS,
  allowedResultColumns,
  findEvent,
  isKnownEvent,
} from './wca-events';

/**
 * These assertions mirror `cubeclash-flutter`'s `wca_event_test.dart`. The two
 * registries are separate code, so the only thing keeping them honest is that
 * both are tested against the same facts.
 */
describe('WCA events', () => {
  it('has all seventeen official events', () => {
    expect(WCA_EVENTS).toHaveLength(17);
    expect(new Set(EVENT_IDS).size).toBe(17);
  });

  it('uses the readable ids already in the database, not the WCA codes', () => {
    expect(EVENT_IDS).toContain('3x3');
    expect(EVENT_IDS).toContain('3x3-oh');
    expect(EVENT_IDS).toContain('4x4-bld');
    expect(EVENT_IDS).not.toContain('333');
    expect(EVENT_IDS).not.toContain('444');
  });

  describe('raceability', () => {
    it('excludes blindfolded, fewest moves and multi-blind', () => {
      // BLD: the memorisation phase is inside the timed attempt, and nothing on
      // screen distinguishes concentrating from stalling.
      expect(RACEABLE_EVENT_IDS).not.toContain('3x3-bld');
      expect(RACEABLE_EVENT_IDS).not.toContain('4x4-bld');
      expect(RACEABLE_EVENT_IDS).not.toContain('5x5-bld');
      // FMC: the result is a written solution, not a time.
      expect(RACEABLE_EVENT_IDS).not.toContain('3x3-fmc');
      // MBLD: an hour.
      expect(RACEABLE_EVENT_IDS).not.toContain('3x3-mbld');
    });

    it('covers the remaining twelve', () => {
      expect(RACEABLE_EVENT_IDS).toHaveLength(12);
    });

    it('quick match is a strict subset of raceable', () => {
      for (const id of QUICK_MATCH_EVENT_IDS) {
        expect(RACEABLE_EVENT_IDS).toContain(id);
      }
      expect(QUICK_MATCH_EVENT_IDS.length).toBeLessThan(RACEABLE_EVENT_IDS.length);
    });

    it('quick match is only the three events with a realistic queue', () => {
      // Matchmaking on 6×6 would sit in the search screen forever.
      expect([...QUICK_MATCH_EVENT_IDS].sort()).toEqual(['2x2', '3x3', '3x3-oh']);
    });
  });

  describe('long-form result columns', () => {
    it('gives Fewest Moves a move count and nothing else', () => {
      expect(allowedResultColumns('3x3-fmc')).toEqual(['move_count']);
    });

    it('gives Multi-Blind solved and attempted counts', () => {
      expect(allowedResultColumns('3x3-mbld')).toEqual(['solved_count', 'attempted_count']);
    });

    it('gives the other fifteen none — the columns are inapplicable, not zero', () => {
      const longForm = new Set(['3x3-fmc', '3x3-mbld']);
      for (const id of EVENT_IDS.filter((e) => !longForm.has(e))) {
        expect(allowedResultColumns(id)).toEqual([]);
      }
    });
  });

  it('treats an unknown id as unknown rather than throwing', () => {
    expect(isKnownEvent('4x4-oh')).toBe(false);
    expect(findEvent('4x4-oh')).toBeUndefined();
    expect(allowedResultColumns('4x4-oh')).toEqual([]);
  });

  it('caps the two hour-long events and nothing else', () => {
    const capped = WCA_EVENTS.filter((e) => e.attemptLimitMs !== undefined).map((e) => e.id);
    expect(capped.sort()).toEqual(['3x3-fmc', '3x3-mbld']);
  });
});
