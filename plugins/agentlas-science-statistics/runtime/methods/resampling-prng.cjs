"use strict";

/**
 * Seeded deterministic pseudo-random generator shared by the resampling and missing-data families.
 *
 * Generator: xoshiro128** (Blackman & Vigna 2018, 32-bit state words) seeded by SplitMix32 from a
 * single uint32 `seed`. All arithmetic is explicit uint32 (Math.imul + `>>> 0`) so the stream is
 * byte-for-byte reproducible in any IEEE-754 runtime and can be ported to the Python oracle.
 *
 *  - nextUint32(): raw 32-bit output
 *  - nextDouble(): 53-bit uniform in [0, 1): ((hi >>> 5) * 2^26 + (lo >>> 6)) / 2^53
 *  - nextIndex(n): Math.floor(nextDouble() * n)
 *  - nextNormal(): Box-Muller (two uniforms per pair, second value cached)
 *  - nextGamma(shape): Marsaglia-Tsang (2000) with the shape < 1 boost
 *  - shuffle(array): Fisher-Yates in place, i from n-1 down to 1, j = nextIndex(i + 1)
 */

const GENERATOR_ID = "xoshiro128**/splitmix32-seeded/v1";
const DEFAULT_SEED = 20240901;

function splitMix32(seedValue) {
  let a = seedValue >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad) >>> 0;
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97) >>> 0;
    t ^= t >>> 15;
    return t >>> 0;
  };
}

function rotl(x, k) {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

function createPrng(seed = DEFAULT_SEED) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("seed must be an integer in [0, 2^32 - 1]");
  const mix = splitMix32(seed);
  let s0 = mix();
  let s1 = mix();
  let s2 = mix();
  let s3 = mix();
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;
  let cachedNormal = null;
  let draws = 0;

  function nextUint32() {
    draws += 1;
    const result = Math.imul(rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = rotl(s3, 11);
    return result;
  }

  function nextDouble() {
    const hi = nextUint32() >>> 5;
    const lo = nextUint32() >>> 6;
    return (hi * 67108864 + lo) / 9007199254740992;
  }

  function nextIndex(n) {
    return Math.floor(nextDouble() * n);
  }

  function nextNormal() {
    if (cachedNormal !== null) {
      const value = cachedNormal;
      cachedNormal = null;
      return value;
    }
    let u1 = nextDouble();
    const u2 = nextDouble();
    if (u1 <= 0) u1 = 1e-300;
    const radius = Math.sqrt(-2 * Math.log(u1));
    const angle = 2 * Math.PI * u2;
    cachedNormal = radius * Math.sin(angle);
    return radius * Math.cos(angle);
  }

  function nextGamma(shape) {
    if (!(shape > 0)) throw new Error("gamma shape must be positive");
    if (shape < 1) {
      const u = nextDouble();
      return nextGamma(shape + 1) * Math.pow(Math.max(u, 1e-300), 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x;
      let v;
      do {
        x = nextNormal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = nextDouble();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(Math.max(u, 1e-300)) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }

  function nextChiSquare(df) {
    return 2 * nextGamma(df / 2);
  }

  function shuffle(array) {
    for (let i = array.length - 1; i >= 1; i -= 1) {
      const j = nextIndex(i + 1);
      const tmp = array[i];
      array[i] = array[j];
      array[j] = tmp;
    }
    return array;
  }

  return {
    generator: GENERATOR_ID,
    seed,
    nextUint32,
    nextDouble,
    nextIndex,
    nextNormal,
    nextGamma,
    nextChiSquare,
    shuffle,
    drawCount: () => draws,
  };
}

const seedOption = Object.freeze({
  schema: { type: "integer", minimum: 0, maximum: 4294967295 },
  default: DEFAULT_SEED,
  parse(value, H, path) {
    return H.integer(value, 0, 4294967295, path);
  },
});

module.exports = { GENERATOR_ID, DEFAULT_SEED, createPrng, seedOption };
