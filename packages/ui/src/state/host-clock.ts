import { HostClockEstimator, type HostTimeInterval } from '../lib/host-clock'

/** One outstanding sample per connection. A timeout never starts another request. */
export class HostClockController {
  private readonly estimator = new HostClockEstimator()
  private generation = 0
  private supported = false
  private pending: object | null = null
  private refresh: ReturnType<typeof setTimeout> | null = null
  private timeout: ReturnType<typeof setTimeout> | null = null
  private resample = false

  constructor(private readonly request: () => Promise<unknown>, private readonly changed: () => void) {}

  connect(supported: boolean): void {
    this.disconnect()
    this.supported = supported
    if (supported) this.probe()
  }

  disconnect(): void {
    this.supported = false
    this.pending = null
    this.resample = false
    this.clearTimers()
    this.fence()
  }

  resume(): void {
    if (!this.supported) return
    this.clearTimers()
    this.fence()
    if (this.pending) this.resample = true
    else this.probe()
  }

  read(): HostTimeInterval | null {
    return this.estimator.read({ generation: this.generation, monoMs: performance.now(), wallMs: Date.now() })
  }

  private fence(): void {
    this.estimator.reset(++this.generation)
    this.changed()
  }

  private clearTimers(): void {
    if (this.refresh !== null) clearTimeout(this.refresh)
    if (this.timeout !== null) clearTimeout(this.timeout)
    this.refresh = this.timeout = null
  }

  private probe(): void {
    if (!this.supported || this.pending) return
    const token = {}
    this.pending = token
    const generation = this.generation
    const sentMonoMs = performance.now()
    this.timeout = setTimeout(() => {
      this.timeout = null
      if (this.pending === token) this.fence()
    }, 5_000)
    void this.request().then(sample => {
      if (this.pending !== token || generation !== this.generation) return
      this.estimator.accept(sample, { generation, sentMonoMs, receivedMonoMs: performance.now(), receivedWallMs: Date.now() })
      this.changed()
    }, () => {
      if (this.pending === token && generation === this.generation) this.fence()
    }).finally(() => {
      if (this.pending !== token) return
      this.pending = null
      if (this.timeout !== null) clearTimeout(this.timeout)
      this.timeout = null
      if (!this.supported) return
      if (this.resample) { this.resample = false; this.probe() }
      else this.refresh = setTimeout(() => { this.refresh = null; this.probe() }, 30_000)
    })
  }
}
