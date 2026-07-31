import { ELO_K_FACTOR, eloDelta, expectedScore } from './elo';

describe('elo', () => {
  describe('expectedScore', () => {
    it('is 0.5 for equal ratings', () => {
      expect(expectedScore(1000, 1000)).toBeCloseTo(0.5, 6);
    });

    it('climbs above 0.5 as A out-rates B, and mirrors below', () => {
      expect(expectedScore(1400, 1000)).toBeGreaterThan(0.5);
      expect(expectedScore(1000, 1400)).toBeLessThan(0.5);
      // The two expectations of a pairing sum to 1.
      expect(expectedScore(1400, 1000) + expectedScore(1000, 1400)).toBeCloseTo(1, 6);
    });
  });

  describe('eloDelta', () => {
    it('awards +K/2 to the winner of an even pairing and debits the loser', () => {
      expect(eloDelta(1000, 1000, 'win')).toBe(ELO_K_FACTOR / 2); // +16
      expect(eloDelta(1000, 1000, 'loss')).toBe(-ELO_K_FACTOR / 2); // -16
    });

    it('rewards an upset more than an expected win', () => {
      const underdogWin = eloDelta(1000, 1400, 'win');
      const favouriteWin = eloDelta(1400, 1000, 'win');
      expect(underdogWin).toBeGreaterThan(favouriteWin);
    });

    it('scores a draw as half, near zero for even ratings', () => {
      expect(eloDelta(1000, 1000, 'draw')).toBe(0);
    });

    it('never exceeds the K-factor in magnitude', () => {
      for (const [a, b] of [
        [1000, 2000],
        [2000, 1000],
        [1500, 1500],
      ]) {
        expect(Math.abs(eloDelta(a, b, 'win'))).toBeLessThanOrEqual(ELO_K_FACTOR);
        expect(Math.abs(eloDelta(a, b, 'loss'))).toBeLessThanOrEqual(ELO_K_FACTOR);
      }
    });
  });
});
