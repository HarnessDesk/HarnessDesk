import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * HarnessDesk-side persistence.
 *
 * Deliberately small. Codex owns thread history in `~/.codex`, and shadowing it
 * would mean two stores that can disagree. What lives here is only what Codex
 * has no opinion about: which workspaces the user opened, and UI preferences.
 *
 * The file is versioned and its objects carry stable opaque ids — the
 * installation and each workspace get one on first sight and keep it through
 * renames and edits. Nothing local uses the ids yet; they exist so that a
 * later phase attaching anything to "this install" or "this workspace" has a
 * name that survives a move, instead of a path that was never one. For the
 * same reason the store refuses to open a file stamped by a newer format:
 * proceeding would rewrite tomorrow's schema as today's, which is a quiet way
 * to destroy exactly the state a downgrade was supposed to keep.
 */

export interface WorkspaceRecord {
  readonly path: string
  readonly name: string
  readonly lastOpenedAt: number
  /** Opaque and minted once; survives renames, moves and schema migrations. */
  readonly id?: string
}

export interface AppState {
  workspaces: WorkspaceRecord[]
  preferences: Record<string, unknown>
}

/** Bumped only when an older build could no longer read the file truthfully. */
const FORMAT = 1

const EMPTY: AppState = { workspaces: [], preferences: {} }

export const defaultStateDir = (): string =>
  process.env['HARNESSDESK_HOME'] ?? join(homedir(), '.harnessdesk')

export class StateStore {
  #state: AppState = { workspaces: [], preferences: {} }
  #installId: string | null = null
  #loaded = false
  #refused = false
  #writes: Promise<void> = Promise.resolve()

  constructor(private readonly file: string = join(defaultStateDir(), 'state.json')) {}

  /** The directory everything HarnessDesk persists lives under — worktrees included. */
  get directory(): string {
    return dirname(this.file)
  }

  /** This installation's opaque name, minted on first load and then permanent. */
  get installId(): string {
    if (!this.#installId) throw new Error('The state store has not been loaded yet.')
    return this.#installId
  }

  async load(): Promise<AppState> {
    if (this.#loaded) return this.#state
    let minted = false
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as Partial<AppState> & {
        version?: unknown
        installId?: unknown
      }
      if (typeof parsed.version === 'number' && parsed.version > FORMAT) {
        // Refusing is the point: opening would rewrite tomorrow's schema as
        // today's on the next persist. The file is left exactly as it is.
        this.#refused = true
        throw new Error(
          `${this.file} was written by a newer HarnessDesk (format ${parsed.version}; this build reads ${FORMAT}). ` +
            'Update HarnessDesk, or move the file aside to start fresh — opening it here would rewrite it as the older format.',
        )
      }
      this.#installId = typeof parsed.installId === 'string' && parsed.installId !== '' ? parsed.installId : null
      this.#state = {
        workspaces: Array.isArray(parsed.workspaces) ? parsed.workspaces : [],
        preferences:
          typeof parsed.preferences === 'object' && parsed.preferences !== null
            ? (parsed.preferences as Record<string, unknown>)
            : {},
      }
    } catch (error) {
      if (this.#refused) throw error
      // A missing or corrupt state file is not an error worth failing startup
      // over — the user loses preferences, not work.
      this.#state = { ...EMPTY, workspaces: [], preferences: {} }
    }
    if (!this.#installId) {
      this.#installId = randomUUID()
      minted = true
    }
    // Entries from before ids existed get theirs on first load.
    if (this.#state.workspaces.some((entry) => typeof entry.id !== 'string' || entry.id === '')) {
      this.#state = {
        ...this.#state,
        workspaces: this.#state.workspaces.map((entry) =>
          typeof entry.id === 'string' && entry.id !== '' ? entry : { ...entry, id: randomUUID() },
        ),
      }
      minted = true
    }
    this.#loaded = true
    // One write makes every minted id durable; without it each launch would
    // mint anew, which is the opposite of an identity.
    if (minted) await this.#persist()
    return this.#state
  }

  get state(): AppState {
    return this.#state
  }

  async setPreferences(patch: Record<string, unknown>): Promise<void> {
    this.#state = { ...this.#state, preferences: { ...this.#state.preferences, ...patch } }
    await this.#persist()
  }

  /**
   * Records a workspace as most-recently-opened, keeping the list deduped.
   * The entry's id outlives the touch: a re-opened folder keeps the identity
   * it was first given, whatever else about the record changed.
   */
  async touchWorkspace(record: WorkspaceRecord): Promise<WorkspaceRecord[]> {
    const existing = this.#state.workspaces.find((entry) => entry.path === record.path)
    const id = record.id ?? existing?.id ?? randomUUID()
    const others = this.#state.workspaces.filter((entry) => entry.path !== record.path)
    this.#state = { ...this.#state, workspaces: [{ ...record, id }, ...others].slice(0, 50) }
    await this.#persist()
    return this.#state.workspaces
  }

  /** Drops a folder from the opened list. The folder itself is untouched. */
  async forgetWorkspace(path: string): Promise<WorkspaceRecord[]> {
    this.#state = {
      ...this.#state,
      workspaces: this.#state.workspaces.filter((entry) => entry.path !== path),
    }
    await this.#persist()
    return this.#state.workspaces
  }

  async #persist(): Promise<void> {
    if (this.#refused) throw new Error('The state file was refused at load and will not be written.')
    const snapshot = JSON.stringify(
      { version: FORMAT, installId: this.#installId, ...this.#state },
      null,
      2,
    )
    this.#writes = this.#writes
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true })
        // Write-then-rename so a crash mid-write cannot truncate the file.
        const temp = `${this.file}.${process.pid}.tmp`
        await writeFile(temp, `${snapshot}\n`)
        await rename(temp, this.file)
      })
      .catch(() => {})
    await this.#writes
  }
}
