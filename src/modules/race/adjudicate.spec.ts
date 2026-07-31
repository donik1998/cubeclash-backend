import { Finish, adjudicate } from './adjudicate';

/** No forced loss — rank purely on the clock. */
const onTime = () => null;

const finish = (
  userId: string,
  timeMs: number | null,
  penalty: Finish['penalty'] = 'none',
): Finish => ({
  userId,
  timeMs,
  penalty,
});

/**
 * The pure ranking behind settlement (spec §5). Every case is two finishes in →
 * two results out, asserting the win/loss/dnf/left rule and that the fields the
 * per-recipient `race:result` reads (`result`, `timeMs`) are correct.
 */
describe('adjudicate', () => {
  it('the strictly faster valid time wins; the other loses', () => {
    const [a, b] = adjudicate([finish('a', 8_000), finish('b', 9_500)], onTime);
    expect(a).toMatchObject({ userId: 'a', result: 'win', timeMs: 8_000 });
    expect(b).toMatchObject({ userId: 'b', result: 'loss', timeMs: 9_500 });
  });

  it('order of input does not change who wins', () => {
    const [b, a] = adjudicate([finish('b', 9_500), finish('a', 8_000)], onTime);
    expect(a.result).toBe('win');
    expect(b.result).toBe('loss');
  });

  it('a dnf penalty loses to any valid time (opponent wins)', () => {
    const [a, b] = adjudicate([finish('a', null, 'dnf'), finish('b', 12_000)], onTime);
    expect(a).toMatchObject({ result: 'dnf', timeMs: null });
    expect(b.result).toBe('win');
  });

  it('a null time (never posted) is a dnf, and loses to a valid time', () => {
    const [a, b] = adjudicate([finish('a', null), finish('b', 12_000)], onTime);
    expect(a.result).toBe('dnf');
    expect(b.result).toBe('win');
  });

  it('a forced walkout is `left`, and the opponent wins on the clock', () => {
    const forced = (f: Finish) => (f.userId === 'a' ? ('left' as const) : null);
    const [a, b] = adjudicate([finish('a', 8_000), finish('b', 20_000)], forced);
    // Even though a had the faster time, the walkout overrides it.
    expect(a.result).toBe('left');
    expect(b.result).toBe('win');
  });

  it('both DNF: nobody wins on the clock, both are dnf (service still rates each as a loss)', () => {
    const [a, b] = adjudicate([finish('a', null, 'dnf'), finish('b', null, 'dnf')], onTime);
    expect(a.result).toBe('dnf');
    expect(b.result).toBe('dnf');
  });

  it('an exact tie credits the first-listed the win rather than freezing both', () => {
    const [a, b] = adjudicate([finish('a', 7_777), finish('b', 7_777)], onTime);
    expect(a.result).toBe('win');
    expect(b.result).toBe('loss');
  });
});
