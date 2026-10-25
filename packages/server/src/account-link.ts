import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hostname } from 'node:os'
import { DeskChallengeResponse, PollDeskLinkResponse, StartDeskLinkRequest, StartDeskLinkResponse } from '@harnessdesk/contract'
import { b64u, deskLinkProofMessage } from '@harnessdesk/crypto'
import { loadOrCreateDeskIdentity, type DeskIdentity } from '@harnessdesk/phone-link'
import type { AccountLinkState } from '@harnessdesk/protocol'

interface Options {
  readonly home: string
  readonly baseUrl?: string
  readonly name?: string
  readonly changed: (state: AccountLinkState) => void
}
class ServiceError extends Error {
  constructor(readonly status: number) { super('account link service refused') }
}
const safeUrl = (value: string): URL => {
  const url = new URL(value)
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('invalid link URL')
  return url
}
const reason = (error: unknown): string => error instanceof ServiceError
  ? error.status === 401 ? 'The desk proof was rejected. Try again.'
    : error.status === 429 ? 'Too many attempts. Try again later.'
      : 'The account service could not complete the link. Try again.'
  : 'The account service could not be reached. Try again.'

/** Host-owned device grant. Only an approved, service-bound link is durable; the grant secret stays in memory. */
export class AccountLink {
  readonly enabled: boolean
  #state: AccountLinkState
  #base: string | null = null
  #identity: DeskIdentity | null = null
  #generation = 0
  #abort: AbortController | null = null
  #pollTimer: ReturnType<typeof setTimeout> | undefined
  #expiryTimer: ReturnType<typeof setTimeout> | undefined
  #closed = false
  #save: Promise<void> | null = null
  constructor(private readonly options: Options) {
    this.enabled = Boolean(options.baseUrl?.trim())
    this.#state = { status: this.enabled ? 'idle' : 'unavailable' }
    if (this.enabled) {
      try { const url = safeUrl(options.baseUrl!.trim()); url.hash = ''; url.search = ''; this.#base = url.href.replace(/\/$/, '') }
      catch { this.#state = { status: 'error', reason: 'The account service address is invalid.' } }
    }
  }
  state(): AccountLinkState { return this.#state }
  async load(): Promise<void> {
    if (!this.#base || this.#closed) return
    try {
      const saved = JSON.parse(await readFile(join(this.options.home, 'account-link.json'), 'utf8')) as Record<string, unknown>
      if (saved['v'] !== 1 || saved['service'] !== this.#base) return
      this.#identity = await loadOrCreateDeskIdentity(join(this.options.home, 'phone-link'))
      if (saved['deskId'] !== this.#identity.id || typeof saved['linkedAt'] !== 'number' || !Number.isSafeInteger(saved['linkedAt']) || saved['linkedAt'] < 0) throw new Error('invalid saved link')
      if (!this.#closed) this.#set({ status: 'linked', deskId: this.#identity.id, linkedAt: saved['linkedAt'] })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !this.#closed) this.#set({ status: 'error', reason: 'The saved account link could not be read. Try again.' })
    }
  }
  async start(): Promise<AccountLinkState> {
    if (!this.#base || this.#closed || ['starting', 'waiting', 'linked'].includes(this.#state.status)) return this.#state
    this.#stop()
    const generation = this.#generation, abort = this.#abort = new AbortController()
    this.#set({ status: 'starting' })
    try {
      const identity = this.#identity ??= await loadOrCreateDeskIdentity(join(this.options.home, 'phone-link'))
      if (!this.#current(generation)) return this.#state
      const challenge = DeskChallengeResponse.parse(await this.#post('/desk/challenge', {}, abort.signal)).challenge
      const sig = b64u(await identity.key.sign(deskLinkProofMessage(identity.id, challenge)))
      if (!this.#current(generation)) return this.#state
      const request = StartDeskLinkRequest.parse({ deskPub: identity.pub, name: (this.options.name ?? hostname()).slice(0, 80), challenge, sig })
      const grant = StartDeskLinkResponse.parse(await this.#post('/desk-link/start', request, abort.signal))
      if (!this.#current(generation)) return this.#state
      const verifyUrl = safeUrl(grant.verifyUrl).href, expiresAt = grant.expiresAt * 1000
      if (expiresAt <= Date.now()) { this.#finish({ status: 'expired' }); return this.#state }
      this.#set({ status: 'waiting', userCode: grant.userCode, verifyUrl, expiresAt })
      this.#expiryTimer = setTimeout(() => { if (this.#current(generation)) this.#finish({ status: 'expired' }) }, Math.min(expiresAt - Date.now(), 2_147_483_647))
      const poll = async (): Promise<void> => {
        if (!this.#current(generation)) return
        try {
          const result = PollDeskLinkResponse.parse(await this.#post('/desk-link/poll', { pollSecret: grant.pollSecret }, abort.signal))
          if (!this.#current(generation)) return
          if (Date.now() >= expiresAt) return this.#finish({ status: 'expired' })
          if (result.status === 'pending') { schedule(); return }
          if (result.status === 'denied') return this.#finish({ status: 'denied' })
          if (result.deskId !== identity.id) throw new Error('wrong desk')
          // Approval has happened remotely. Once saving starts, cancellation waits for it rather than pretending to revoke it.
          clearTimeout(this.#expiryTimer)
          const linked = { status: 'linked' as const, deskId: identity.id, linkedAt: Date.now() }
          this.#save = this.#persist(linked)
          await this.#save
          if (this.#current(generation)) this.#finish(linked)
        } catch (error) {
          if (this.#current(generation)) this.#finish(error instanceof ServiceError && error.status === 410 ? { status: 'expired' } : { status: 'error', reason: reason(error) })
        } finally { this.#save = null }
      }
      const schedule = () => { this.#pollTimer = setTimeout(() => { void poll() }, Math.min(grant.intervalSeconds * 1000, 2_147_483_647)) }
      schedule()
    } catch (error) {
      if (this.#current(generation)) this.#finish({ status: 'error', reason: reason(error) })
    }
    return this.#state
  }
  async cancel(): Promise<AccountLinkState> {
    if (this.#save) { await this.#save.catch(() => {}); return this.#state }
    if (!this.#closed && ['starting', 'waiting'].includes(this.#state.status)) { this.#stop(); this.#set({ status: 'idle' }) }
    return this.#state
  }
  async close(): Promise<void> { this.#closed = true; this.#stop(); await this.#save?.catch(() => {}) }
  #current(generation: number): boolean { return !this.#closed && generation === this.#generation }
  #stop(): void { this.#generation++; this.#abort?.abort(); this.#abort = null; clearTimeout(this.#pollTimer); clearTimeout(this.#expiryTimer) }
  #set(state: AccountLinkState): void { this.#state = state; this.options.changed(state) }
  #finish(state: AccountLinkState): void { this.#stop(); this.#set(state) }
  async #post(path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(`${this.#base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]), redirect: 'error' })
    if (!response.ok) { await response.body?.cancel(); throw new ServiceError(response.status) }
    return response.json()
  }
  async #persist(state: Extract<AccountLinkState, { status: 'linked' }>): Promise<void> {
    const file = join(this.options.home, 'account-link.json'), temp = `${file}.tmp`
    await writeFile(temp, JSON.stringify({ v: 1, service: this.#base, deskId: state.deskId, linkedAt: state.linkedAt }), { mode: 0o600 })
    await rename(temp, file)
  }
}
