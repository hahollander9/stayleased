/** Deterministic seeded RNG (mulberry32) — the seed and simulators depend on
 * reproducibility, so Math.random is banned in domain code. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(min: number, max: number): number {
    return Math.floor(this.next() * (max - min + 1)) + min;
  }
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  /** pick with weights: [[value, weight], ...] */
  weighted<T>(pairs: readonly (readonly [T, number])[]): T {
    const total = pairs.reduce((s, p) => s + p[1], 0);
    let r = this.next() * total;
    for (const [v, w] of pairs) {
      if ((r -= w) <= 0) return v;
    }
    return pairs[pairs.length - 1]![0];
  }
  shuffle<T>(arr: T[]): T[] {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }
  /** normal-ish via sum of 3 uniforms, clamped */
  around(mean: number, spread: number): number {
    const u = (this.next() + this.next() + this.next()) / 3;
    return mean + (u - 0.5) * 2 * spread;
  }
  fork(salt: number): Rng {
    return new Rng((this.s ^ Math.imul(salt + 1, 2654435761)) >>> 0);
  }
}

export const GLOBAL_SEED = 42;
