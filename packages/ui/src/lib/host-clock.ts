export interface HostClockSample { readonly hostNowMs: number; readonly clockEpoch: string }
export interface HostTimeInterval { readonly lowerMs: number; readonly upperMs: number }
type Observation = { monoMs: number; wallMs: number }
type Estimate = HostTimeInterval & { receivedMonoMs: number; receivedWallMs: number; initialUncertaintyMs: number }
const MAX_RTT_MS = 5_000
const MAX_AGE_MS = 60_000
const MAX_DISCONTINUITY_MS = 2_000
const MAX_DATE_MS = 8_640_000_000_000_000

/** A bounded estimate for one transport generation; wall drift contributes uncertainty. */
export class HostClockEstimator {
  private generation: number | null = null
  private epoch: string | null = null
  private estimate: Estimate | null = null
  private observation: Observation | null = null

  reset(generation: number): void {
    this.generation = generation
    this.epoch = null
    this.invalidate()
  }

  invalidate(): void {
    this.estimate = null
    this.observation = null
  }

  accept(sample: unknown, timing: { generation: number; sentMonoMs: number; sentWallMs: number; receivedMonoMs: number; receivedWallMs: number }): boolean {
    if (timing.generation !== this.generation || this.generation === null) return false
    const fail = () => { this.invalidate(); return false }
    const { sentMonoMs, sentWallMs, receivedMonoMs, receivedWallMs } = timing
    const rtt = receivedMonoMs - sentMonoMs
    if (!Number.isFinite(sentMonoMs) || !Number.isFinite(sentWallMs) || !Number.isFinite(receivedMonoMs) || !Number.isFinite(receivedWallMs) ||
        sentMonoMs < 0 || rtt < 0 || rtt > MAX_RTT_MS || !Number.isFinite(rtt)) return fail()
    const initialUncertaintyMs = Math.abs((receivedWallMs - sentWallMs) - rtt)
    if (!Number.isFinite(initialUncertaintyMs) || initialUncertaintyMs > MAX_DISCONTINUITY_MS) return fail()
    if (typeof sample !== 'object' || sample === null || !('hostNowMs' in sample) || !('clockEpoch' in sample) ||
        typeof sample.hostNowMs !== 'number' || !Number.isSafeInteger(sample.hostNowMs) || sample.hostNowMs < 0 ||
        typeof sample.clockEpoch !== 'string' || sample.clockEpoch.length === 0) return fail()
    if (this.epoch !== null && this.epoch !== sample.clockEpoch) return fail()
    if (this.observation && ((this.estimate !== null && sentMonoMs < this.estimate.receivedMonoMs) || !this.isContinuous(receivedMonoMs, receivedWallMs))) return fail()
    // A shared wall adjustment after the Host stamps its reply would be lost
    // by a receipt-only anchor. Retain the request discrepancy in both bounds.
    const lowerMs = sample.hostNowMs - initialUncertaintyMs
    const upperMs = sample.hostNowMs + rtt + 1 + initialUncertaintyMs
    if (!Number.isFinite(lowerMs) || lowerMs < 0 || !Number.isSafeInteger(Math.ceil(upperMs)) || upperMs > MAX_DATE_MS) return fail()
    if (this.estimate) {
      const elapsed = receivedMonoMs - this.estimate.receivedMonoMs
      if (elapsed > MAX_AGE_MS || sample.hostNowMs > this.estimate.upperMs + elapsed || upperMs < this.estimate.lowerMs + elapsed) return fail()
    }
    this.epoch = sample.clockEpoch
    this.estimate = { lowerMs, upperMs, receivedMonoMs, receivedWallMs, initialUncertaintyMs }
    this.observation = { monoMs: receivedMonoMs, wallMs: receivedWallMs }
    return true
  }

  read(timing: { generation: number; monoMs: number; wallMs: number }): HostTimeInterval | null {
    if (timing.generation !== this.generation || this.generation === null || !this.estimate) return null
    if (!this.isContinuous(timing.monoMs, timing.wallMs)) { this.invalidate(); return null }
    const elapsed = timing.monoMs - this.estimate.receivedMonoMs
    if (elapsed < 0 || elapsed > MAX_AGE_MS) { this.invalidate(); return null }
    // Keep the sample's wall anchor: replacing it on every read hides cumulative
    // small steps. Either a local Host shares the adjustment or a remote one does
    // not, so widen both ends until a fresh sample resolves that uncertainty.
    const uncertainty = Math.abs((timing.wallMs - this.estimate.receivedWallMs) - elapsed)
    // Request uncertainty already widens the stored interval. Later drift adds
    // to the same budget, even when it reverses the request's wall adjustment.
    if (!Number.isFinite(uncertainty) || this.estimate.initialUncertaintyMs + uncertainty > MAX_DISCONTINUITY_MS) { this.invalidate(); return null }
    const lowerMs = this.estimate.lowerMs + elapsed - uncertainty
    const upperMs = this.estimate.upperMs + elapsed + uncertainty
    if (!Number.isFinite(lowerMs) || lowerMs < 0 || !Number.isSafeInteger(Math.ceil(upperMs)) || upperMs > MAX_DATE_MS) { this.invalidate(); return null }
    this.observation = { monoMs: timing.monoMs, wallMs: timing.wallMs }
    return { lowerMs, upperMs }
  }

  private isContinuous(monoMs: number, wallMs: number): boolean {
    if (!Number.isFinite(monoMs) || !Number.isFinite(wallMs) || monoMs < 0 || !this.observation) return false
    const monoDelta = monoMs - this.observation.monoMs
    const wallDelta = wallMs - this.observation.wallMs
    return monoDelta >= 0 && Math.abs(wallDelta - monoDelta) <= MAX_DISCONTINUITY_MS
  }
}
