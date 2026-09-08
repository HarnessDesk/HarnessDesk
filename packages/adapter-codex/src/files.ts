import { randomUUID } from 'node:crypto'

import type { CodexAppServer, CodexProtocol } from '@harnessdesk/codex'
import type {
  FileEntry,
  FileMatch,
  FileMetadata,
  RuntimeFiles,
  Unsubscribe,
} from '@harnessdesk/protocol'

/**
 * Codex's filesystem view — `fuzzyFileSearch` and `fs/*` — behind the
 * protocol's `RuntimeFiles`.
 *
 * Why delegate at all, given that these calls are not sandboxed: because the
 * ranking is then the one Codex's own clients use, and because where Codex is
 * driving a remote environment these read the filesystem the agent is
 * actually working in. Confinement to the open workspace is the host's job.
 *
 * Observed on 0.135.0 and relied on here: paths must be absolute (a relative
 * one is a deserialisation error); `fs/watch` is not recursive and reports a
 * top-level change within a few hundred milliseconds; an empty search query
 * returns no files.
 */
export class CodexFiles implements RuntimeFiles {
  readonly #watchers = new Map<string, (changedPaths: readonly string[]) => void>()

  constructor(private readonly server: CodexAppServer) {}

  async search(roots: readonly string[], query: string, limit: number): Promise<readonly FileMatch[]> {
    if (query.trim().length === 0 || roots.length === 0) return []
    const response = await this.server.request('fuzzyFileSearch', {
      query,
      roots: [...roots],
      cancellationToken: null,
    })
    return response.files.slice(0, limit).map((file) => ({
      path: `${file.root.replace(/\/$/, '')}/${file.path}`,
      relativePath: file.path,
      score: file.score,
      kind: file.match_type,
      ...(file.indices ? { indices: file.indices } : {}),
    }))
  }

  async read(path: string): Promise<Uint8Array> {
    const response = await this.server.request('fs/readFile', { path })
    return Buffer.from(response.dataBase64, 'base64')
  }

  async write(path: string, data: Uint8Array): Promise<void> {
    await this.server.request('fs/writeFile', {
      path,
      dataBase64: Buffer.from(data).toString('base64'),
    })
  }

  async list(path: string): Promise<readonly FileEntry[]> {
    const response = await this.server.request('fs/readDirectory', { path })
    return response.entries.map((entry) => ({
      name: entry.fileName,
      kind: entry.isDirectory ? 'directory' : entry.isFile ? 'file' : 'other',
    }))
  }

  async stat(path: string): Promise<FileMetadata> {
    const response = await this.server.request('fs/getMetadata', { path })
    return {
      kind: response.isDirectory ? 'directory' : response.isFile ? 'file' : 'other',
      isSymlink: response.isSymlink,
      modifiedAt: response.modifiedAtMs > 0 ? response.modifiedAtMs : null,
    }
  }

  async watch(
    path: string,
    listener: (changedPaths: readonly string[]) => void,
  ): Promise<Unsubscribe> {
    const watchId = randomUUID()
    // Registered before the request so a change that lands between the
    // response and the next line is not dropped.
    this.#watchers.set(watchId, listener)
    try {
      await this.server.request('fs/watch', { watchId, path })
    } catch (error) {
      this.#watchers.delete(watchId)
      throw error
    }
    return () => {
      if (!this.#watchers.delete(watchId)) return
      // Best effort: a dead app-server has nothing to unwatch, and the
      // listener is already gone on this side.
      void this.server.request('fs/unwatch', { watchId }).catch(() => {})
    }
  }

  /** Called by the runtime for every `fs/changed`; unknown ids are stale unwatches. */
  dispatch(notification: CodexProtocol.v2.FsChangedNotification): void {
    this.#watchers.get(notification.watchId)?.(notification.changedPaths)
  }

  /** Drops every listener without calling Codex — the process is going away. */
  abandon(): void {
    this.#watchers.clear()
  }
}
