/**
 * Short, stable identifiers for tasks that need cross-region references.
 *
 * IDs are assigned only when an operation creates a link that plain nesting
 * cannot express (an archived child pointing at a timeline parent, or an
 * archived undated root remembering its section). They are never regenerated
 * or stripped, so `format` is guaranteed id-stable.
 *
 * The RNG is injectable so tests get byte-identical output under a fixed seed.
 */

export type Rng = () => number;

/** Deterministic mulberry32 PRNG. Same seed -> same stream. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
const ID_LENGTH = 6;

function randomId(rng: Rng): string {
  let out = '';
  for (let i = 0; i < ID_LENGTH; i++) {
    out += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  }
  return out;
}

/**
 * Mint an id not present in `taken`. `taken` should span every region
 * (timeline + archive) so ids stay unique across moves.
 */
export function mintId(taken: Set<string>, rng: Rng): string {
  let id = randomId(rng);
  while (taken.has(id)) {
    id = randomId(rng);
  }
  taken.add(id);
  return id;
}
