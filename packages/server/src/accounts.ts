import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { runtimeId, type RuntimeId } from '@harnessdesk/protocol'

/**
 * More than one account of the same agent, on a machine whose agent keeps one.
 *
 * Codex holds exactly one credential in `$CODEX_HOME/auth.json`, so a second
 * sign-in overwrites the first — which is the bug this exists to fix. The only
 * lever the CLI offers is `CODEX_HOME`, and pointing a second process at an
 * empty directory would separate the credentials *and* the session history,
 * losing threads the user expects every Codex account to be able to open.
 *
 * So a slot's home is a **symlink farm**: one link per entry of the agent's
 * real home, for every entry except the credential. The account is private;
 * the sessions, the state database, the config, the skills and the plugins are
 * the same files on disk. Measured against Codex 0.149.0: two app-servers, one
 * signed in and one not, list the same threads with the same titles, and the
 * shared SQLite passes `pragma quick_check` afterwards — Codex already expects
 * its CLI and its desktop app to share a home, and this is the same shape.
 */

export interface AccountSlot {
  /** The runtime id this slot is registered under, e.g. `codex-7f3a91`. */
  readonly id: RuntimeId
  /** The runtime whose account this is another of — the primary's id. */
  readonly agent: RuntimeId
  /** This slot's `CODEX_HOME`: the symlink farm. */
  readonly home: string
  readonly createdAt: number
  /**
   * Set when this account pays its own way.
   *
   * A **plan account** signs into the vendor and keeps the credential in
   * `auth.json`. A **gateway account** never signs in at all: it reaches the
   * same agent and the same models through an endpoint of the user's own, and
   * what authorises it is a key in the credential broker, named here only by
   * reference. `endpoint` is the upstream the user typed — the agent is given
   * a loopback address instead, never this one.
   */
  readonly gateway?: {
    readonly name: string
    readonly endpoint: string
    readonly credentialRef: string
  }
}

/**
 * The provider name a gateway account's config defines. Deliberately not a
 * name any user would choose, because the whole file is ours to rewrite.
 */
const GATEWAY_PROVIDER = 'harnessdesk_gateway'

/**
 * What never gets a link.
 *
 * `auth.json` is the whole point. The rest are per-process by nature: `ipc`
 * carries the app-server daemon's sockets, and two homes sharing one socket
 * directory would have each process answering for the other's home.
 */
const PRIVATE_ENTRIES = new Set(['auth.json', 'ipc', 'tmp', '.tmp', '.DS_Store'])

/**
 * Directories that must be shared even before the agent has made them.
 *
 * A link can only be made to something that exists, and these do not exist
 * until the agent first needs them — which on a home that has never opened a
 * conversation is after the slot was farmed. Left alone, each account then
 * makes its *own* copy, and the whole point of the directory is lost.
 *
 * `thread-writer-locks` is where Codex keeps one `flock` per conversation so
 * that exactly one process is ever writing a thread's rollout. Two accounts
 * holding separate lock directories are two processes appending to one file,
 * each certain it is alone. That is worse than the refusal the sharing
 * causes: a refusal is a sentence, and this is a damaged transcript. Measured
 * on 0.149.0: farmed before the directory existed, both accounts took a lock
 * and both resumed the same thread.
 *
 * `mcp-oauth-locks` is here by the same structural argument rather than by
 * measurement: Codex names it in `rmcp-client/src/oauth/store_lock.rs` and
 * waits on it "for another process to finish updating MCP OAuth store state",
 * which is a lock over the token store the accounts already share. Two
 * private copies of a lock over one shared store is the same mistake; what
 * has not been reproduced here is what it costs.
 *
 * So the entries are created in the agent's own home in order to be linked.
 * They are directories the agent makes for itself the moment it needs them —
 * making them early costs nothing and is not a change to the user's data.
 */
const SHARED_ON_DEMAND = ['thread-writer-locks', 'mcp-oauth-locks']

/** Where a slot's home lives, given the directory HarnessDesk persists into. */
export const slotHome = (stateDir: string, id: RuntimeId): string =>
  join(stateDir, 'accounts', id)

/** The agent's own home — the one the slots are farmed from. */
export const codexPrimaryHome = (override?: string | null): string =>
  override ?? process.env['CODEX_HOME'] ?? join(homedir(), '.codex')

/**
 * Makes `slot` a mirror of `primary` in symlinks, minus the credential.
 *
 * Idempotent, and run on every start rather than only at creation: the agent
 * adds files to its home over time, and a file the agent rewrites atomically
 * lands as a real file where the link was — replacing it here is what keeps a
 * slot from quietly drifting into a private copy. Returns the entries linked.
 */
export const linkHome = (
  primary: string,
  slot: string,
  /**
   * Entries this slot keeps to itself on top of the usual ones. A gateway
   * account passes `config.toml`, because that file is how it is told which
   * endpoint to use — and a symlink there would mean writing the gateway
   * provider *into the user's own Codex config*, which is the one thing this
   * whole design exists to avoid.
   */
  alsoPrivate: ReadonlySet<string> = new Set(),
): readonly string[] => {
  mkdirSync(slot, { recursive: true })
  const linked: string[] = []
  let entries: readonly string[]
  try {
    entries = readdirSync(primary)
  } catch {
    return linked // No agent home yet: the slot is an empty directory, which is legal.
  }
  for (const entry of SHARED_ON_DEMAND) {
    if (entries.includes(entry) || alsoPrivate.has(entry)) continue
    try {
      mkdirSync(join(primary, entry), { recursive: true })
      entries = [...entries, entry]
    } catch {
      // A directory we cannot make is one the agent will make itself, and the
      // next start links it. Never a reason to fail a sign-in.
    }
  }
  const wanted = new Set<string>()
  for (const entry of entries) {
    if (PRIVATE_ENTRIES.has(entry) || alsoPrivate.has(entry)) continue
    wanted.add(entry)
    const target = join(primary, entry)
    const link = join(slot, entry)
    const current = readLink(link)
    if (current === target) {
      linked.push(entry)
      continue
    }
    if (current !== null || existsSync(link)) rmSync(link, { recursive: true, force: true })
    try {
      symlinkSync(target, link)
      linked.push(entry)
    } catch {
      // A link we cannot make is one entry the slot does without, not a
      // failed sign-in: the credential is what the slot is really for.
    }
  }
  // Links to entries the agent no longer has would resolve to nothing, and a
  // dangling `config.toml` reads worse than an absent one.
  for (const entry of readdirSync(slot)) {
    if (wanted.has(entry) || PRIVATE_ENTRIES.has(entry) || alsoPrivate.has(entry)) continue
    if (readLink(join(slot, entry)) === null) continue
    rmSync(join(slot, entry), { force: true })
  }
  return linked
}

/** What a gateway slot keeps to itself, over and above `PRIVATE_ENTRIES`. */
export const gatewayPrivateEntries: ReadonlySet<string> = new Set(['config.toml'])

/**
 * Points a gateway account's Codex at its loopback address.
 *
 * Called on every start rather than only at creation, because `endpoint` is a
 * loopback port that a restart changes. `wire_api = "responses"` is the only
 * value Codex accepts, and the provider is keyless on purpose: the gateway
 * token rides in the path of `endpoint`, so the real key stays in the broker
 * and no part of it appears in this file, in `ps`, or in the agent's
 * environment.
 *
 * The file is written whole, and any symlink found at that path is removed
 * first — a slot promoted from an older roster could still have one pointing
 * at the user's own config, and writing through it would edit their Codex.
 */
export const writeGatewayConfig = (home: string, name: string, endpoint: string): void => {
  mkdirSync(home, { recursive: true })
  const path = join(home, 'config.toml')
  if (readLink(path) !== null) rmSync(path, { force: true })
  const body = [
    '# Written by HarnessDesk on every start; edits here are lost.',
    '# This is a gateway account: it reaches the model through the endpoint',
    '# below, and its key lives in HarnessDesk, not in this file.',
    `model_provider = "${GATEWAY_PROVIDER}"`,
    '',
    `[model_providers.${GATEWAY_PROVIDER}]`,
    `name = ${JSON.stringify(name)}`,
    `base_url = ${JSON.stringify(endpoint)}`,
    'wire_api = "responses"',
    '',
  ].join('\n')
  writeFileSync(path, body, 'utf8')
}

const readLink = (path: string): string | null => {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : null
  } catch {
    return null
  }
}

/** Whether a slot has been signed in — the one file the farm never links. */
export const slotHasCredential = (home: string): boolean => existsSync(join(home, 'auth.json'))

/**
 * Who a credential home is signed in as, as an opaque string to compare.
 *
 * Two accounts of one agent are two credentials, and two credentials naming
 * the same identity are not two accounts — they are one account signed in
 * twice, with two rows, two quotas that are really one, and two app-servers
 * competing for the same threads. The agent cannot tell us: Codex's
 * `account/read` answers an email and a plan, and an email is not an identity,
 * because one person can hold two ChatGPT workspaces and those *are* two
 * accounts, with separate limits, worth separate rows.
 *
 * The credential says it exactly. `auth.json` carries an OIDC id token whose
 * `sub` is the person and whose `chatgpt_account_id` is the workspace, so the
 * pair is the identity. The token is read, never verified — this is comparing
 * two files the user already has, not admitting anyone — and its claims are
 * never surfaced, only hashed into a comparison.
 *
 * Null means "cannot tell", which is deliberately not "the same": an
 * unreadable, absent, or unrecognised credential is never folded into another.
 * A gateway account has no `auth.json` at all and answers null for that reason.
 *
 * **Both halves are required, and a missing workspace is null rather than an
 * empty one.** Codex documents the claim as optional — "this may be `null`
 * when the prior auth state did not include a workspace identifier
 * (`chatgpt_account_id`)", `ChatgptAuthTokensRefreshParams` — so a token shape
 * that drops it is a real possibility, not a hypothetical. Fingerprinting
 * `sub` with an empty workspace would make every workspace of one person hash
 * alike, and the two accounts this whole function exists to keep apart would
 * be folded into one. The two failures are not symmetrical: folding wrongly
 * deletes an account the user has, while declining to fold leaves a duplicate
 * row, which is only the bug this change fixes still being visible. So the
 * uncertain case takes the visible failure.
 */
export const accountIdentity = (home: string): string | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(home, 'auth.json'), 'utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const auth = parsed as { tokens?: unknown; OPENAI_API_KEY?: unknown }
  const tokens = typeof auth.tokens === 'object' && auth.tokens !== null ? (auth.tokens as Record<string, unknown>) : null
  const claims = tokens && typeof tokens['id_token'] === 'string' ? jwtClaims(tokens['id_token']) : null
  if (claims) {
    const subject = text(claims['sub'])
    // Codex copies the claim to `tokens.account_id` when it writes the file,
    // so either source is the same workspace; a credential carrying neither
    // is one this cannot answer for.
    const scoped = claims['https://api.openai.com/auth']
    const workspace =
      text(
        typeof scoped === 'object' && scoped !== null
          ? (scoped as Record<string, unknown>)['chatgpt_account_id']
          : undefined,
      ) ?? text(tokens?.['account_id'])
    if (subject !== null && workspace !== null) {
      return `chatgpt:${fingerprint(`${subject}:${workspace}`)}`
    }
  }
  // An API-key home has no token to read; the key itself is the identity, and
  // is hashed rather than held so that nothing above this line can leak it.
  const key = text(auth.OPENAI_API_KEY)
  if (key !== null) return `apiKey:${fingerprint(key)}`
  return null
}

/** A non-empty string, or null — the only shape worth putting in an identity. */
const text = (value: unknown): string | null =>
  typeof value === 'string' && value !== '' ? value : null

/** The claims of an unverified JWT, or null if it is not one. */
const jwtClaims = (token: string): Record<string, unknown> | null => {
  const payload = token.split('.')[1]
  if (payload === undefined) return null
  try {
    const decoded: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return typeof decoded === 'object' && decoded !== null ? (decoded as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Short, stable, and one-way: identities are compared, never read back. */
const fingerprint = (value: string): string =>
  createHash('sha256').update(value).digest('hex').slice(0, 32)

/**
 * Whether a slot is finished, by whichever route it authorises.
 *
 * A gateway account is complete the moment it is made: the key was given up
 * front and is already in the broker, and there is no sign-in still to do. It
 * will never have an `auth.json`, so asking `slotHasCredential` about one is
 * asking the wrong question — and answering it would delete the account.
 */
export const slotConfigured = (slot: AccountSlot): boolean =>
  slot.gateway !== undefined || slotHasCredential(slot.home)

/**
 * The roster, on disk beside the agent registry.
 *
 * A plain file read synchronously for the same reason `agents.json` is: the
 * host is wired up before anything is awaited, and a slot that arrived one
 * tick late would be a runtime the first `sync` did not mention.
 */
export class AccountSlots {
  #slots: AccountSlot[]

  constructor(
    private readonly file: string,
    private readonly log?: (message: string, details?: unknown) => void,
  ) {
    this.#slots = readRoster(file)
  }

  list(): readonly AccountSlot[] {
    return this.#slots
  }

  find(id: RuntimeId): AccountSlot | null {
    return this.#slots.find((slot) => slot.id === id) ?? null
  }

  of(agent: RuntimeId): readonly AccountSlot[] {
    return this.#slots.filter((slot) => slot.agent === agent)
  }

  /**
   * Allocates one more account of `agent` and builds its home.
   *
   * The id carries a random suffix rather than a counter: session keys are
   * runtime-scoped, so a recycled `codex-2` would inherit the deleted
   * account's rows the moment anything cached them.
   */
  add(
    agent: RuntimeId,
    primary: string,
    stateDir: string,
    gateway?: AccountSlot['gateway'],
  ): AccountSlot {
    const id = runtimeId(`${agent}-${randomBytes(3).toString('hex')}`)
    const home = slotHome(stateDir, id)
    const linked = linkHome(primary, home, gateway ? gatewayPrivateEntries : undefined)
    const slot: AccountSlot = { id, agent, home, createdAt: Date.now(), ...(gateway ? { gateway } : {}) }
    this.#slots = [...this.#slots, slot]
    this.#write()
    this.log?.('account slot created', {
      runtime: id,
      home,
      linked: linked.length,
      ...(gateway ? { gateway: gateway.name } : {}),
    })
    return slot
  }

  /** Forgets a slot. Its home is deleted only when `purge` is set. */
  remove(id: RuntimeId, purge = true): AccountSlot | null {
    const slot = this.find(id)
    if (!slot) return null
    this.#slots = this.#slots.filter((entry) => entry.id !== id)
    this.#write()
    if (purge) {
      // Only ever the farm: every shared entry inside it is a symlink, and
      // `rm` of a symlink removes the link, never what it points at.
      try {
        rmSync(slot.home, { recursive: true, force: true })
      } catch (error) {
        this.log?.('account slot home could not be removed', { home: slot.home, error: String(error) })
      }
    }
    return slot
  }

  /** Re-mirrors every slot of `agent`. Called on start, before the runtimes come up. */
  relink(agent: RuntimeId, primary: string): void {
    for (const slot of this.of(agent)) {
      linkHome(primary, slot.home, slot.gateway ? gatewayPrivateEntries : undefined)
    }
  }

  /**
   * Drops slots that never got a credential.
   *
   * A slot is made before the sign-in that fills it, so one abandoned halfway
   * leaves a home holding nothing but symlinks and a row saying "Not
   * connected". Keeping it across a restart would let those pile up, one per
   * change of mind; a start is late enough that anything still empty is
   * abandoned rather than in flight.
   */
  pruneEmpty(agent: RuntimeId): readonly RuntimeId[] {
    const empty = this.of(agent).filter((slot) => !slotConfigured(slot))
    for (const slot of empty) this.remove(slot.id)
    if (empty.length > 0) this.log?.('abandoned account slots removed', { count: empty.length })
    return empty.map((slot) => slot.id)
  }

  /**
   * Drops slots signed in as somebody an earlier account already is.
   *
   * A second sign-in that lands on the same identity has not added an account
   * — it has made a copy of one, and the copy is worse than useless: it shows
   * a second row for one person, halves nothing and doubles nothing, and puts
   * a second app-server on the same threads so that opening one can be refused
   * by the other. Codex cannot refuse it, because at the point the browser
   * comes back there is nothing left to refuse; the roster is where it is
   * visible, so this is where it is undone.
   *
   * The agent's own account always wins, then the oldest slot: whoever was
   * here first keeps the row, so a fold never moves the account a user has
   * already named, tinted and been running turns as.
   *
   * Only the farm is deleted, never a sign-out. The identity being dropped is
   * one another account still holds, and revoking it there would sign the user
   * out of the account they kept — the opposite of the repair.
   */
  pruneDuplicates(agent: RuntimeId, primary: string): readonly RuntimeId[] {
    const seen = new Set<string>()
    const own = accountIdentity(primary)
    if (own !== null) seen.add(own)
    const folded: RuntimeId[] = []
    for (const slot of this.of(agent)) {
      const identity = accountIdentity(slot.home)
      if (identity === null) continue // Cannot tell is never the same.
      if (seen.has(identity)) folded.push(slot.id)
      else seen.add(identity)
    }
    for (const id of folded) this.remove(id)
    if (folded.length > 0) {
      this.log?.('duplicate account slots removed', { count: folded.length, slots: folded })
    }
    return folded
  }

  #write(): void {
    const body = `${JSON.stringify({ accounts: this.#slots }, null, 2)}\n`
    try {
      mkdirSync(join(this.file, '..'), { recursive: true })
      const temporary = `${this.file}.tmp-${process.pid}`
      writeFileSync(temporary, body, 'utf8')
      renameSync(temporary, this.file)
    } catch (error) {
      this.log?.('the account roster could not be written', { file: this.file, error: String(error) })
    }
  }
}

/** Absent is legal; present and malformed is not. */
const isGateway = (value: AccountSlot['gateway']): boolean =>
  value === undefined ||
  (typeof value === 'object' &&
    value !== null &&
    typeof value.name === 'string' &&
    typeof value.endpoint === 'string' &&
    typeof value.credentialRef === 'string')

const readRoster = (file: string): AccountSlot[] => {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return [] // No extra accounts is the common case, not an error.
  }
  try {
    const parsed = JSON.parse(raw) as { accounts?: unknown }
    const list = Array.isArray(parsed.accounts) ? parsed.accounts : []
    return list.filter(
      (entry): entry is AccountSlot =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as AccountSlot).id === 'string' &&
        typeof (entry as AccountSlot).agent === 'string' &&
        typeof (entry as AccountSlot).home === 'string' &&
        // A half-written gateway is worse than none: the slot would be kept
        // through `pruneEmpty` as a gateway account and then have no endpoint
        // to reach. Dropping it here makes it an ordinary abandoned slot.
        isGateway((entry as AccountSlot).gateway),
    )
  } catch {
    return []
  }
}
