import { loadAccountPicture, isAccountPictureDataUrl } from './account-picture.js'
import { mkdir, readFile, rename, writeFile, unlink, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { hostname } from 'node:os'
import { join } from 'node:path'
import {
  DeskAccountResponse, DeskChallengeResponse, DeskSessionResponse, DeviceId, Name, Ok,
  PollDeskLinkResponse, RenameDeskResponse, StartDeskLinkResponse,
} from '@harnessdesk/contract'
import {
  b64u, fromB64u, generateSigningIdentity, idFromPub, signingIdentityFromPkcs8,
  webDeskLinkProofMessage, webDeskProofMessage, type SigningIdentity,
} from '@harnessdesk/crypto'
import type { HarnessDeskAccountStatus } from '@harnessdesk/protocol'
import type { CredentialCipher } from './credentials.js'
import type { StateStore } from './state.js'

interface Session { token: string; expiresAt: number }
interface Secrets { version: 1; origin: string; key: string; pending?: Pending; session?: Session; cached?: ReturnType<typeof DeskAccountResponse.parse>; picture?: { source: string; data: string } }
interface Pending { userCode: string; pollSecret: string; verifyUrl: string; expiresAt: number; intervalSeconds: number }
interface Options {
  state: StateStore
  readPicture?: (url: string) => Promise<string | undefined>
  cipher?: CredentialCipher
  cloudUrl?: string
  openExternal?: (url: string) => Promise<void>
  changed: (status: HarnessDeskAccountStatus) => void
  fetch?: typeof fetch
  now?: () => number
  setTimer?: (fn: () => Promise<void>, ms: number) => unknown
  clearTimer?: (timer: unknown) => void
}
class CloudUnreachableError extends Error {
  readonly wireCode = 'accountCloudUnreachable'
  constructor() { super('HarnessDesk could not reach your account. Try again.') }
}
class CloudError extends Error {
  constructor(readonly status: number) { super('HarnessDesk could not reach your account. Try again.') }
}

/** Host-only account lifecycle. Nothing here depends on a runtime or gives a secret to a renderer. */
export class HarnessDeskAccount {
  readonly #options: Options
  readonly #base: URL
  readonly #fetch: typeof fetch
  readonly #file: string
  #storageBlocked: string | undefined
  #loaded: Promise<void> | undefined
  #identity: SigningIdentity | undefined
  #secrets: Secrets | undefined
  #pictureSource: string | undefined
  #pending: Pending | undefined
  #snapshot: HarnessDeskAccountStatus
  #timer: unknown
  #generation = 0
  #closed = false
  #writes: Promise<void> = Promise.resolve()
  #mutations: Promise<unknown> = Promise.resolve()

  constructor(options: Options) {
    this.#options = options
    this.#base = new URL(options.cloudUrl ?? process.env['HARNESSDESK_CLOUD_URL'] ?? 'https://app.harnessdesk.app')
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(this.#base.hostname)
    if ((this.#base.protocol !== 'https:' && !(loopback && this.#base.protocol === 'http:')) || this.#base.username || this.#base.password || this.#base.pathname !== '/' || this.#base.search || this.#base.hash) {
      throw new Error('HARNESSDESK_CLOUD_URL must be an HTTPS origin (HTTP loopback is allowed for local development).')
    }
    this.#file = join(options.state.directory, `account-${createHash('sha256').update(this.#base.origin).digest('hex')}.sealed`)
    this.#fetch = options.fetch ?? fetch
    this.#snapshot = this.#signedOut()
  }

  #desk() {
    const prefs = this.#options.state.state.preferences
    const savedName = Name.safeParse(prefs['accountDeskName'])
    return { name: savedName.success ? savedName.data : hostname().slice(0, 80) || 'This desk', reachable: prefs['accountReachable'] === true }
  }
  #signedOut(error?: string): HarnessDeskAccountStatus { return { status: 'signedOut', desk: this.#desk(), phones: [], ...(error ? { error } : {}) } }
  #emit(status: HarnessDeskAccountStatus) { this.#snapshot = status; if (!this.#closed) this.#options.changed(status) }
  #now() { return Math.floor((this.#options.now?.() ?? Date.now()) / 1000) }
  #encrypted() {
    const cipher = this.#options.cipher
    if (!cipher || cipher.protection === 'file permissions only') throw new Error('Sign in requires secure encrypted storage from the desktop app.')
    return cipher
  }
  async #persist() {
    const data = this.#secrets
    if (!data) return
    if (this.#storageBlocked) throw new Error(this.#storageBlocked)
    const blob = this.#encrypted().encrypt(JSON.stringify(data))
    const file = this.#file
    const writing = this.#writes.catch(() => {}).then(async () => {
      await mkdir(this.#options.state.directory, { recursive: true })
      await writeFile(`${file}.tmp`, blob, { mode: 0o600 })
      await rename(`${file}.tmp`, file)
    })
    this.#writes = writing
    await writing
  }
  #load(remote = true) {
    return this.#loaded ??= (async () => {
      await this.#options.state.load()
      this.#snapshot = this.#signedOut()
      // No plaintext fallback, and no attempt to decrypt a desktop secret in a standalone host.
      if (!this.#options.cipher || this.#options.cipher.protection === 'file permissions only') {
        for (const file of [this.#file, join(this.#options.state.directory, 'account.sealed')]) {
          try { await stat(file); this.#blockStorage(); break }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.#blockStorage(); break } }
        }
        return
      }
      let bytes: Buffer
      let legacy = false
      try { bytes = await readFile(this.#file) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { this.#blockStorage(); return }
        const ignored = this.#options.state.state.preferences['accountLegacyIgnoredOrigins']
        if (Array.isArray(ignored) && ignored.includes(this.#base.origin)) return
        try { bytes = await readFile(join(this.#options.state.directory, 'account.sealed')); legacy = true }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#blockStorage(); return }
      }
      try {
        const data = JSON.parse(this.#encrypted().decrypt(bytes)) as Secrets
        // A readable legacy identity belonging to another origin is left for that origin to migrate.
        if (legacy && typeof data?.origin === 'string' && data.origin !== this.#base.origin) return
        if (data.version !== 1 || data.origin !== this.#base.origin || typeof data.key !== 'string') throw new Error('invalid sealed identity')
        this.#identity = await signingIdentityFromPkcs8(fromB64u(data.key))
        this.#secrets = { version: 1, origin: data.origin, key: data.key,
          ...(data.session && typeof data.session.token === 'string' && Number.isSafeInteger(data.session.expiresAt) ? { session: data.session } : {}) }
        const pending = StartDeskLinkResponse.safeParse(data.pending)
        if (pending.success) this.#secrets.pending = pending.data
        const cached = DeskAccountResponse.safeParse(data.cached)
        if (cached.success) this.#secrets.cached = cached.data
        if (typeof data.picture?.source === 'string' && isAccountPictureDataUrl(data.picture.data)) {
          this.#secrets.picture = data.picture
          this.#pictureSource = data.picture.source
        }
        if (legacy) {
          // Only a validated, decryptable blob moves. Never replace an existing origin's file.
          await writeFile(this.#file, bytes, { flag: 'wx', mode: 0o600 })
          await unlink(join(this.#options.state.directory, 'account.sealed')).catch(() => {})
        }
      } catch { this.#identity = undefined; this.#secrets = undefined; this.#blockStorage(); return }
      if (!legacy) await this.#removeLegacyDuplicate()
      if (this.#secrets?.session) {
        const cached = this.#secrets.cached
        if (cached) this.#emit({ status: 'signedIn', account: this.#withPicture(cached.account), desk: this.#desk(), phones: cached.phones })
        if (!remote) return
        const generation = this.#generation
        try { await this.#refresh(generation) }
        catch {
          if (this.#current(generation) && this.#secrets?.session) {
            this.#emit({ ...this.#snapshot, error: 'Your account is unavailable. Retrying when connected.' })
            this.#schedule(() => this.#refreshQuietly(generation), 30)
          }
        }
      } else if (this.#identity && remote) {
        // A process can quit after browser approval and before saving its first session.
        // Old sealed files have no pending record; proof of the existing key is sufficient to clean them up too.
        const generation = this.#generation
        const cleaned = await this.#cleanupUnfinished(this.#secrets?.pending, generation)
        if (cleaned && this.#current(generation) && this.#secrets) { delete this.#secrets.pending; await this.#persist() }
      }
    })()
  }
  async #removeLegacyDuplicate() {
    if (!this.#secrets) return
    const file = join(this.#options.state.directory, 'account.sealed')
    let bytes: Buffer
    try { bytes = await readFile(file) }
    catch { return } // Legacy cleanup cannot disable a valid origin identity.
    let data: Partial<Secrets>
    try { data = JSON.parse(this.#encrypted().decrypt(bytes)) as Partial<Secrets> }
    catch { return } // Opaque bytes are kept. The origin's sign-out marker prevents restoring them later.
    if (data?.version === 1 && data.origin === this.#base.origin && data.key === this.#secrets.key) await unlink(file).catch(() => {})
  }
  #blockStorage() {
    this.#storageBlocked = 'Your encrypted account could not be opened. The saved file was kept; restore access to secure storage before signing in again.'
    this.#emit(this.#signedOut(this.#storageBlocked))
  }
  async status(): Promise<HarnessDeskAccountStatus> { await this.#load(); return this.#snapshot }
  #serialize<T>(fn: () => Promise<T>, remote = true): Promise<T> {
    const next = this.#mutations.catch(() => {}).then(async () => {
      if (this.#closed) throw new Error('This desk is closing.')
      await this.#load(remote)
      return fn()
    })
    this.#mutations = next
    return next
  }
  async #request(path: string, body: unknown | undefined, token?: string): Promise<unknown> {
    let response: Response
    try {
      response = await this.#fetch(new URL(`/v1${path}`, this.#base).href, {
        method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch { throw new CloudUnreachableError() }
    if (!response.ok) {
      if (path === '/desk-link/start' && response.status === 429) throw new Error('Too many attempts. Try again in a few minutes.')
      throw new CloudError(response.status)
    }
    try { return await response.json() } catch { throw new Error('HarnessDesk received an invalid account response.') }
  }
  #parse<T>(schema: { parse(value: unknown): T }, value: unknown): T {
    try { return schema.parse(value) }
    catch { throw new Error('HarnessDesk received an invalid account response.') }
  }
  #current(generation: number) { return !this.#closed && generation === this.#generation }
  #stopTimer() {
    if (this.#timer !== undefined) {
      if (this.#options.clearTimer) this.#options.clearTimer(this.#timer)
      else clearTimeout(this.#timer as ReturnType<typeof setTimeout>)
      this.#timer = undefined
    }
  }
  #schedule(fn: () => Promise<void>, seconds: number) {
    this.#stopTimer()
    if (this.#closed) return
    const safe = async () => {
      this.#timer = undefined
      if (this.#closed) return
      // Background metadata cannot overtake rename, unlink or sign out.
      await this.#serialize(fn).catch(() => {})
    }
    this.#timer = this.#options.setTimer ? this.#options.setTimer(safe, seconds * 1000) : setTimeout(() => { void safe() }, seconds * 1000)
    if (!this.#options.setTimer) (this.#timer as ReturnType<typeof setTimeout>).unref()
  }
  async #key() {
    if (this.#storageBlocked) throw new Error(this.#storageBlocked)
    this.#encrypted()
    if (!this.#identity) {
      this.#identity = await generateSigningIdentity()
      this.#secrets = { version: 1, origin: this.#base.origin, key: b64u(await this.#identity.exportPkcs8()) }
      await this.#persist()
    }
    return this.#identity
  }
  signIn(): Promise<HarnessDeskAccountStatus> {
    const requestedGeneration = this.#generation
    return this.#serialize(async () => {
      if (requestedGeneration !== this.#generation) return this.#snapshot
      if (this.#snapshot.status === 'signedIn' || this.#pending) return this.#snapshot
      if (!this.#options.openExternal) throw new Error('Sign in is available in the desktop app.')
      const generation = ++this.#generation
      const key = await this.#key()
      const deskId = await idFromPub(key.pub)
      if (!this.#current(generation)) return this.#snapshot
      const { challenge } = this.#parse(DeskChallengeResponse, await this.#request('/desk/challenge', {}))
      if (!this.#current(generation)) return this.#snapshot
      const started = this.#parse(StartDeskLinkResponse, await this.#request('/desk-link/start', {
        deskPub: b64u(key.pub), name: this.#desk().name, challenge, sig: b64u(await key.sign(webDeskLinkProofMessage(deskId, challenge))),
      }))
      const page = new URL(started.verifyUrl)
      if (page.origin !== this.#base.origin || page.pathname !== '/link' || page.username || page.password || new URLSearchParams(page.hash.slice(1)).get('code') !== started.userCode) throw new Error('HarnessDesk returned an unexpected verification page.')
      if (!this.#current(generation)) return this.#snapshot
      if (started.expiresAt <= this.#now()) throw new Error('The sign-in code expired. Try again.')
      this.#pending = started
      this.#secrets!.pending = started
      await this.#persist()
      if (!this.#current(generation)) return this.#snapshot
      this.#emit({ status: 'pending', desk: this.#desk(), phones: [], pending: { userCode: started.userCode, verifyUrl: page.href, expiresAt: started.expiresAt } })
      this.#schedule(() => this.#poll(generation), Math.min(30, Math.max(1, started.intervalSeconds)))
      try { await this.#options.openExternal(page.href) }
      catch { if (this.#current(generation)) this.#emit({ ...this.#snapshot, error: 'The browser could not be opened. Open the page again.' }) }
      return this.#snapshot
    })
  }
  openSignIn() { return this.#serialize(async () => {
    if (this.#pending && this.#options.openExternal) {
      try { await this.#options.openExternal(this.#pending.verifyUrl) }
      catch { throw new Error('The browser could not be opened. Try again.') }
    }
    return this.#snapshot
  }) }
  async #session(generation: number): Promise<Session | undefined> {
    if (this.#secrets?.session && this.#secrets.session.expiresAt > this.#now() + 60) return this.#secrets.session
    const key = await this.#key(); const deskId = await idFromPub(key.pub)
    const { challenge } = this.#parse(DeskChallengeResponse, await this.#request('/desk/challenge', {}))
    if (!this.#current(generation)) return
    const response = this.#parse(DeskSessionResponse, await this.#request('/desk/session', { deskPub: b64u(key.pub), challenge, sig: b64u(await key.sign(webDeskProofMessage(deskId, challenge))) }))
    if (!this.#current(generation)) return
    if (response.expiresAt <= this.#now()) throw new Error('The account session expired. Try again.')
    const session = { token: response.deskToken, expiresAt: response.expiresAt }
    return session
  }
  async #refresh(generation: number) {
    try {
      const session = await this.#session(generation)
      if (!session || !this.#current(generation)) return
      const response = this.#parse(DeskAccountResponse, await this.#request('/desk/account', undefined, session.token))
      if (!this.#current(generation)) return
      if (response.desk.deskId !== await idFromPub((await this.#key()).pub)) throw new Error('The account response did not match this desk.')
      if (!this.#current(generation)) return
      await this.#options.state.setPreferences({ accountDeskName: response.desk.name })
      if (!this.#current(generation)) return
      this.#secrets = { ...this.#secrets!, session, cached: response }
      delete this.#secrets.pending
      if (this.#secrets.picture?.source !== response.account.pictureUrl) delete this.#secrets.picture
      if (this.#pictureSource !== response.account.pictureUrl) this.#pictureSource = undefined
      await this.#persist()
      if (!this.#current(generation)) return
      this.#emit({ status: 'signedIn', account: this.#withPicture(response.account), desk: this.#desk(), phones: response.phones })
      if (response.account.pictureUrl) void this.#loadPicture(response.account.pictureUrl, generation)
      // Poll account metadata as well as token expiry, so a phone-side revocation reaches an open desk.
      this.#schedule(async () => {
        if (!this.#current(generation)) return
        try { await this.#refresh(generation) }
        catch { if (this.#current(generation) && this.#secrets?.session) this.#schedule(() => this.#refreshQuietly(generation), 30) }
      }, Math.max(1, Math.min(60, session.expiresAt - this.#now() - 60)))
    } catch (error) {
      if (this.#current(generation) && error instanceof CloudError && error.status === 401) {
        if (this.#secrets) { delete this.#secrets.session; delete this.#secrets.cached; delete this.#secrets.picture; this.#pictureSource = undefined; await this.#persist() }
        if (!this.#current(generation)) return
        this.#emit(this.#signedOut('This desk was signed out. Sign in again.'))
      }
      throw error
    }
  }
  #withPicture(account: NonNullable<HarnessDeskAccountStatus['account']>) {
    const picture = this.#secrets?.picture
    return { ...account, ...(picture?.source === account.pictureUrl ? { pictureDataUrl: picture.data } : {}) }
  }
  async #loadPicture(source: string, generation: number) {
    if (this.#pictureSource === source) return
    this.#pictureSource = source
    const data = await (this.#options.readPicture ?? loadAccountPicture)(source).catch(() => undefined)
    if (!isAccountPictureDataUrl(data)) {
      if (this.#current(generation) && this.#pictureSource === source) this.#pictureSource = undefined
      return
    }
    if (!this.#current(generation)) return
    await this.#serialize(async () => {
      if (!this.#current(generation) || this.#snapshot.status !== 'signedIn' || this.#snapshot.account?.pictureUrl !== source || !this.#secrets) return
      this.#secrets.picture = { source, data }
      await this.#persist()
      if (this.#current(generation) && this.#snapshot.account?.pictureUrl === source) this.#emit({ ...this.#snapshot, account: this.#withPicture(this.#snapshot.account) })
    }).catch(() => {})
  }
  async #refreshQuietly(generation: number) {
    try { await this.#refresh(generation) }
    catch { if (this.#current(generation) && this.#secrets?.session) this.#schedule(() => this.#refreshQuietly(generation), 30) }
  }
  async #poll(generation: number) {
    const pending = this.#pending
    if (!pending || !this.#current(generation)) return
    const expired = pending.expiresAt <= this.#now()
    try {
      const result = this.#parse(PollDeskLinkResponse, await this.#request('/desk-link/poll', { pollSecret: pending.pollSecret }))
      if (!this.#current(generation)) return
      if (result.status === 'denied') { await this.#endPending(generation, 'The sign-in request was declined.'); return }
      if (result.status === 'approved') {
        const deskId = await idFromPub((await this.#key()).pub)
        if (!this.#current(generation)) return
        if (result.deskId !== deskId) { await this.#endPending(generation, 'The approved desk did not match this desk.'); return }
        await this.#refresh(generation)
        if (this.#current(generation)) this.#pending = undefined
        return
      }
    } catch (error) {
      if (!this.#current(generation)) return
      if (error instanceof CloudError && [401, 404, 410].includes(error.status)) {
        await this.#endPending(generation, 'The sign-in code is no longer valid. Try again.'); return
      }
      this.#emit({ ...this.#snapshot, error: 'Waiting for your account. Check your connection.' })
    }
    if (expired) { await this.#endPending(generation, 'The sign-in code expired. Try again.'); return }
    if (this.#current(generation)) this.#schedule(() => this.#poll(generation), Math.min(30, Math.max(1, pending.intervalSeconds)))
  }
  async #endPending(generation: number, error: string) {
    if (!this.#current(generation)) return
    this.#pending = undefined
    if (this.#secrets) { delete this.#secrets.pending; await this.#persist() }
    if (this.#current(generation)) this.#emit(this.#signedOut(error))
  }
  /** Best effort, host-only cleanup: approval is never promoted to a local sign-in here. */
  async #cleanupUnfinished(pending: Pending | undefined, generation: number): Promise<boolean> {
    if (!this.#identity || !this.#current(generation)) return false
    try {
      if (pending) {
        try {
          const result = this.#parse(PollDeskLinkResponse, await this.#request('/desk-link/poll', { pollSecret: pending.pollSecret }))
          if (!this.#current(generation)) return false
          if (result.status === 'pending') return false
          if (result.status === 'denied') return true
          if (result.deskId !== await idFromPub(this.#identity.pub)) return false
        } catch (error) {
          // A link record may have expired out of storage while its approved desk still exists.
          if (!(error instanceof CloudError && [401, 404, 410].includes(error.status))) return false
        }
      }
      if (!this.#current(generation)) return false
      const session = await this.#session(generation)
      if (!session || !this.#current(generation)) return false
      this.#parse(Ok, await this.#request('/desks/revoke', { deskId: await idFromPub(this.#identity.pub) }, session.token))
      return this.#current(generation)
    } catch (error) {
      return error instanceof CloudError && [401, 404].includes(error.status)
    }
  }
  /** Fence in-flight polls immediately; the cleanup joins the mutation queue before a new sign-in. */
  cancel(): Promise<HarnessDeskAccountStatus> {
    if (this.#snapshot.status === 'signedIn' && !this.#pending) return Promise.resolve(this.#snapshot)
    const generation = ++this.#generation
    const pending = this.#pending
    this.#pending = undefined; this.#stopTimer()
    return this.#serialize(async () => {
      if (!this.#current(generation)) return this.#snapshot
      const cleaned = await this.#cleanupUnfinished(pending ?? this.#secrets?.pending, generation)
      if (!this.#current(generation)) return this.#snapshot
      if (this.#secrets) {
        delete this.#secrets.session; delete this.#secrets.cached; delete this.#secrets.picture
        this.#pictureSource = undefined
        if (cleaned) delete this.#secrets.pending
        await this.#persist()
      }
      if (this.#current(generation)) this.#emit(this.#signedOut(this.#storageBlocked))
      return this.#snapshot
    })
  }
  async #authorized() {
    if (!this.#secrets?.session || this.#snapshot.status !== 'signedIn') throw new Error('Sign in to HarnessDesk first.')
    const session = await this.#session(this.#generation)
    if (!session) throw new Error('Sign in to HarnessDesk first.')
    return { token: session.token, deskId: await idFromPub((await this.#key()).pub) }
  }
  renameDesk(name: string) { return this.#serialize(async () => {
    const trimmed = Name.parse(name)
    if (this.#snapshot.status === 'signedIn') {
      const { token } = await this.#authorized()
      this.#parse(RenameDeskResponse, await this.#request('/desk/rename', { name: trimmed }, token))
    }
    await this.#options.state.setPreferences({ accountDeskName: trimmed })
    this.#emit({ ...this.#snapshot, desk: this.#desk() }); return this.#snapshot
  }) }
  setReachable(reachable: boolean) { return this.#serialize(async () => {
    await this.#options.state.setPreferences({ accountReachable: reachable })
    this.#emit({ ...this.#snapshot, desk: this.#desk() }); return this.#snapshot
  }) }
  unlinkPhone(deviceId: string) { return this.#serialize(async () => {
    DeviceId.parse(deviceId)
    const { token, deskId } = await this.#authorized()
    this.#parse(Ok, await this.#request('/links/revoke', { deskId, deviceId }, token))
    await this.#refresh(this.#generation); return this.#snapshot
  }) }
  async #clearLocal() {
    ++this.#generation; this.#stopTimer(); this.#pending = undefined
    await this.#writes.catch(() => {})
    // An opaque file cannot safely be interpreted or replaced, even by a new sign-in.
    if (!this.#storageBlocked && this.#options.cipher && this.#options.cipher.protection !== 'file permissions only') {
      const ignored = this.#options.state.state.preferences['accountLegacyIgnoredOrigins']
      const origins = Array.isArray(ignored) ? ignored.filter((origin): origin is string => typeof origin === 'string') : []
      await this.#options.state.setPreferences({ accountLegacyIgnoredOrigins: [...new Set([...origins, this.#base.origin])] })
      await this.#removeLegacyDuplicate()
      try { await unlink(this.#file) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('HarnessDesk could not clear its encrypted account storage.') }
    }
    this.#identity = undefined; this.#secrets = undefined; this.#pictureSource = undefined
    this.#emit(this.#signedOut(this.#storageBlocked))
    return this.#snapshot
  }
  signOut(localOnly = false) { return this.#serialize(async () => {
    if (!localOnly && this.#identity) {
      try {
        const session = await this.#session(this.#generation)
        if (session) this.#parse(Ok, await this.#request('/desks/revoke', { deskId: await idFromPub(this.#identity.pub) }, session.token))
      } catch (error) {
        if (!(error instanceof CloudError && [401, 404].includes(error.status))) {
          if (error instanceof CloudError && error.status >= 500) throw new CloudUnreachableError()
          throw error
        }
      }
    }
    return this.#clearLocal()
  }, !localOnly) }
  close() { this.#closed = true; ++this.#generation; this.#stopTimer() }
}
