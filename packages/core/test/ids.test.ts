import { expect, test, describe } from 'vitest';
import { seededRng, mintId, type Rng } from '../src/ids.js';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

describe('seededRng', () => {
  test('is deterministic: same seed produces the same stream', () => {
    const a = seededRng(42);
    const b = seededRng(42);
    const aStream = Array.from({ length: 10 }, () => a());
    const bStream = Array.from({ length: 10 }, () => b());
    expect(aStream).toEqual(bStream);
  });

  test('different seeds produce different streams', () => {
    const a = seededRng(1);
    const b = seededRng(2);
    expect(Array.from({ length: 20 }, () => a())).not.toEqual(
      Array.from({ length: 20 }, () => b()),
    );
  });

  test('returns values in [0, 1)', () => {
    const rng = seededRng(7);
    for (let i = 0; i < 100; i++) {
      const v = rng();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('mintId', () => {
  test('produces a 6-character lowercase base36 id', () => {
    const rng = seededRng(1);
    for (let i = 0; i < 50; i++) {
      const id = mintId(new Set(), rng);
      expect(id).toHaveLength(6);
      for (const ch of id) {
        expect(ALPHABET).toContain(ch);
        expect(ch).toBe(ch.toLowerCase());
      }
    }
  });

  test('never returns an id already present in `taken`', () => {
    const taken = new Set(['aaaaaa', 'bbbbbb', '123456', 'zzzzzz']);
    const rng = seededRng(9);
    for (let i = 0; i < 50; i++) {
      const before = new Set(taken); // snapshot at call time
      const id = mintId(taken, rng);
      expect(before.has(id)).toBe(false);
    }
  });

  test('adds each minted id to `taken` so later calls stay unique', () => {
    const taken = new Set<string>();
    const rng = seededRng(3);
    const ids = Array.from({ length: 20 }, () => mintId(taken, rng));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('retries past a collision to a free id', () => {
    // Scripted rng: first six draws yield 10/36 (-> "aaaaaa"), then 11/36 (-> "bbbbbb").
    const values: number[] = Array.from({ length: 6 }, () => 10 / 36).concat(
      Array.from({ length: 6 }, () => 11 / 36),
    );
    let i = 0;
    const rng: Rng = () => values[i++ % values.length]!;

    const taken = new Set(['aaaaaa']);
    expect(mintId(taken, rng)).toBe('bbbbbb');
    expect(taken.has('bbbbbb')).toBe(true);
  });

  test('a seeded collision test is reproducible', () => {
    const taken = new Set<string>();
    const rng = seededRng(1234);
    const first = mintId(taken, rng);
    const again = mintId(taken, rng);
    expect(first).not.toBe(again);
  });
});
