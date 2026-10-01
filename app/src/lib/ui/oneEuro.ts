/**
 * One Euro filter (Casiez et al., CHI 2012): a low-pass filter whose cutoff
 * rises with speed, so a noisy but still signal is smoothed hard while real
 * motion is followed with little lag. Used for the live outline's corners,
 * which arrive at an uneven ~5-15 Hz with a few px of detection noise.
 */
export class OneEuro {
  #x: number | null = null
  #dx = 0
  #t = 0

  /**
   * @param minCutoff Hz at rest (lower = smoother when still)
   * @param beta cutoff gain per unit/s of speed (higher = less lag in motion)
   * @param dCutoff Hz for the speed estimate itself
   */
  constructor(
    private readonly minCutoff = 1,
    private readonly beta = 0.004,
    private readonly dCutoff = 1,
  ) {}

  reset(): void {
    this.#x = null
  }

  /** Filter sample `x` taken at `tMs` (ms, monotonic). */
  filter(x: number, tMs: number): number {
    if (this.#x === null) {
      this.#x = x
      this.#dx = 0
      this.#t = tMs
      return x
    }
    const dt = Math.max(0.001, (tMs - this.#t) / 1000)
    this.#t = tMs
    const alpha = (cutoff: number): number => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt))
    this.#dx += alpha(this.dCutoff) * ((x - this.#x) / dt - this.#dx)
    this.#x += alpha(this.minCutoff + this.beta * Math.abs(this.#dx)) * (x - this.#x)
    return this.#x
  }
}
