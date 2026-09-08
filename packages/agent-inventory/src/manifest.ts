import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { LibraryKind } from '@harnessdesk/protocol'

/**
 * Provenance as a manifest, not a symlink.
 *
 * One JSON file records every copy the write path has ever produced: the
 * path it wrote, and the digest of the definition as written. That pair is
 * the whole overwrite policy — digest equal means the copy is still ours and
 * may be updated or removed; digest unequal means a person edited it since,
 * and the install path must stand back. **Nothing without an entry here is
 * ever written over by an install.** The explicit resolve and remove flows
 * may replace foreign copies, and they carry a backup precisely because this
 * file cannot vouch for what they replace.
 *
 * No symlinks, no Windows junctions, and nothing breaks when an agent
 * rewrites its own directory — the manifest just stops matching, which *is*
 * the signal.
 */

export interface ManifestEntry {
  readonly kind: LibraryKind
  readonly name: string
  /** The bundle directory or flat file; for MCP, the configuration file. */
  readonly path: string
  /** Digest of the definition as this app last wrote it. */
  readonly digest: string
  readonly at: number
  /** Where the content came from, for the audit trail's benefit. */
  readonly source?: string
}

interface ManifestFile {
  readonly version: 1
  readonly entries: readonly ManifestEntry[]
}

/** MCP entries share a file, so the name is part of the identity; skills' path is unique. */
const keyOf = (kind: LibraryKind, path: string, name: string): string =>
  // A JSON tuple, not a delimiter-joined string: it cannot collide (the
  // encoder escapes), and unlike a NUL separator it keeps this source a
  // text file that git can diff and review.
  kind === 'mcp' ? JSON.stringify(['mcp', path, name]) : JSON.stringify(['skill', path])

export class LibraryManifest {
  readonly #file: string
  readonly #entries = new Map<string, ManifestEntry>()

  private constructor(file: string) {
    this.#file = file
  }

  static async load(directory: string): Promise<LibraryManifest> {
    const manifest = new LibraryManifest(join(directory, 'manifest.json'))
    let raw: string
    try {
      raw = await readFile(manifest.#file, 'utf8')
    } catch {
      return manifest
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ManifestFile>
      for (const entry of parsed.entries ?? []) {
        if (typeof entry?.path === 'string' && typeof entry?.digest === 'string') {
          manifest.#entries.set(keyOf(entry.kind, entry.path, entry.name), entry)
        }
      }
    } catch {
      // A manifest that cannot be parsed vouches for nothing — which is safe:
      // every copy then reads as foreign and the install path stands back.
    }
    return manifest
  }

  find(kind: LibraryKind, path: string, name: string): ManifestEntry | undefined {
    return this.#entries.get(keyOf(kind, path, name))
  }

  record(entry: ManifestEntry): void {
    this.#entries.set(keyOf(entry.kind, entry.path, entry.name), entry)
  }

  forget(kind: LibraryKind, path: string, name: string): void {
    this.#entries.delete(keyOf(kind, path, name))
  }

  /** Written atomically: a torn manifest vouches for copies it never saw. */
  async save(): Promise<void> {
    const body: ManifestFile = {
      version: 1,
      entries: [...this.#entries.values()].sort((a, b) => a.path.localeCompare(b.path)),
    }
    await mkdir(dirname(this.#file), { recursive: true })
    const tmp = `${this.#file}.tmp`
    await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`)
    await rename(tmp, this.#file)
  }
}
