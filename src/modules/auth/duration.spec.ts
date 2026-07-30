import { durationToSeconds } from './duration';

describe('durationToSeconds', () => {
  it('parses the config defaults the token TTLs use', () => {
    expect(durationToSeconds('15m')).toBe(900);
    expect(durationToSeconds('30d')).toBe(2_592_000);
  });

  it('parses each unit', () => {
    expect(durationToSeconds('45s')).toBe(45);
    expect(durationToSeconds('2h')).toBe(7_200);
    expect(durationToSeconds('1d')).toBe(86_400);
  });

  it('treats a bare number as seconds', () => {
    expect(durationToSeconds('900')).toBe(900);
  });

  it('throws on an unparseable duration rather than guessing', () => {
    expect(() => durationToSeconds('soon')).toThrow();
    expect(() => durationToSeconds('15x')).toThrow();
  });
});
