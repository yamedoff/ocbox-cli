/** Injectable wall clock so expiry, skew, and timeout logic stay deterministic. */
export interface ClockPort {
  now(): number
}

export const systemClock: ClockPort = {
  now: () => Date.now(),
}
