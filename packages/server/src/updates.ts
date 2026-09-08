import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

import type { RuntimeInfo, RuntimeUpdate } from '@harnessdesk/protocol'

/**
 * Is a newer build of a runtime published than the one running?
 *
 * The model list is whatever the running agent declares, and an agent that is
 * behind its vendor declares less — Codex 0.135.0 cannot read a catalogue
 * that names GPT-5.6's reasoning levels and silently falls back to its
 * compiled-in presets. The only honest fix for that is a newer agent; the
 * least HarnessDesk can do is say so next to the list that stopped growing.
 *
 * A runtime opts in by naming its npm package (`presentation.install.package`).
 * The registry's `latest` dist-tag is read at most once a day per package and
 * remembered in the state directory, so a machine that is offline, or a
 * registry that is slow, costs nothing but a log line. Advisory only: nothing
 * is installed, nothing is blocked, and `HARNESSDESK_NO_UPDATE_CHECK=1` turns
 * the check off entirely.
 */

export interface UpdateCheckerOptions {
  /** Where the last answers are kept between runs. */
  readonly cachePath: string
  /** Injected so tests never touch the network. */
  readonly fetch?: (url: string, signal: AbortSignal) => Promise<{ ok: boolean; json(): Promise<unknown> }>
  readonly now?: () => number
  readonly ttlMs?: number
  readonly timeoutMs?: number
  readonly log?: (message: string, details?: unknown) => void
}

interface CacheEntry {
  readonly latest: string
  readonly checkedAt: number
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_TIMEOUT_MS = 5_000

export const parseSemver = (raw: string): readonly [number, number, number] | null => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(raw)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/** True when `latest` is a strictly newer release than `running`. Unparseable input is never newer. */
export const isNewer = (latest: string, running: string | null | undefined): boolean => {
  if (!running) return false
  const a = parseSemver(latest)
  const b = parseSemver(running)
  if (!a || !b) return false
  return (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) > 0
}

export class UpdateChecker {
  #cache: Record<string, CacheEntry> | null = null
  readonly #inflight = new Map<string, Promise<string | null>>()

  constructor(private readonly options: UpdateCheckerOptions) {}

  /**
   * The update that applies to this runtime, or null: none published, none
   * knowable, or none newer. Resolves from the cache without a network round
   * trip when the last answer is fresh enough.
   */
  async updateFor(info: RuntimeInfo): Promise<RuntimeUpdate | null> {
    const pkg = info.presentation.install?.package
    if (!pkg || !info.version) return null
    const latest = await this.latestOf(pkg)
    if (!latest || !isNewer(latest, info.version)) return null
    const install = info.presentation.install
    return {
      version: latest,
      ...(install?.command ? { command: upgradeCommand(install.command) } : {}),
      ...(install?.url ? { url: install.url } : {}),
    }
  }

  /** The registry's `latest` for a package, from cache when fresh. */
  async latestOf(pkg: string): Promise<string | null> {
    const cache = await this.#load()
    const now = (this.options.now ?? Date.now)()
    const entry = cache[pkg]
    if (entry && now - entry.checkedAt < (this.options.ttlMs ?? DEFAULT_TTL_MS)) return entry.latest
    let pending = this.#inflight.get(pkg)
    if (!pending) {
      pending = this.#fetchLatest(pkg).finally(() => this.#inflight.delete(pkg))
      this.#inflight.set(pkg, pending)
    }
    const latest = await pending
    if (latest) {
      cache[pkg] = { latest, checkedAt: now }
      await this.#save(cache)
    }
    return latest ?? entry?.latest ?? null
  }

  async #fetchLatest(pkg: string): Promise<string | null> {
    const url = `https://registry.npmjs.org/-/package/${encodeURIComponent(pkg).replace('%40', '@')}/dist-tags`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    try {
      const fetchImpl = this.options.fetch ?? defaultFetch
      const response = await fetchImpl(url, controller.signal)
      if (!response.ok) return null
      const body = (await response.json()) as { latest?: unknown }
      return typeof body.latest === 'string' ? body.latest : null
    } catch (error) {
      this.options.log?.('update check failed', { package: pkg, error: String(error) })
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  async #load(): Promise<Record<string, CacheEntry>> {
    if (this.#cache) return this.#cache
    try {
      const parsed = JSON.parse(await readFile(this.options.cachePath, 'utf8')) as unknown
      this.#cache =
        typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, CacheEntry>) : {}
    } catch {
      this.#cache = {}
    }
    return this.#cache
  }

  async #save(cache: Record<string, CacheEntry>): Promise<void> {
    try {
      await mkdir(dirname(this.options.cachePath), { recursive: true })
      await writeFile(this.options.cachePath, JSON.stringify(cache, null, 2))
    } catch (error) {
      this.options.log?.('update cache not written', { error: String(error) })
    }
  }
}

const defaultFetch: NonNullable<UpdateCheckerOptions['fetch']> = (url, signal) =>
  fetch(url, { signal, headers: { accept: 'application/json' } })

/**
 * The install command, phrased as an upgrade where the package manager has
 * a distinct verb for it: `brew install x` → `brew upgrade x`; `npm i -g x`
 * → `npm i -g x@latest`. Anything else is returned as written.
 */
export const upgradeCommand = (install: string): string => {
  const brew = /^brew install (\S+)$/.exec(install)
  if (brew) return `brew upgrade ${brew[1]}`
  const npm = /^(npm (?:i|install) -g|pnpm add -g|bun (?:add|install) -g) (\S+)$/.exec(install)
  if (npm && !npm[2]!.includes('@', 1)) return `${npm[1]} ${npm[2]}@latest`
  return install
}
