import {
  RuntimeFileTooLargeError,
  WORKSPACE_BINARY_LIMIT_BYTES,
  WORKSPACE_TEXT_LIMIT_BYTES,
} from '@harnessdesk/protocol'

import { within, type Within } from '../seat-reads.js'
import { asText, browseDirectories, confine, isBinaryFile, isMissingWorkspaceFileError, sha256 } from '../workspace.js'
import type { MethodsUnder } from './context.js'

/**
 * Folders and files. Every path the renderer names is confined to an open
 * workspace before anything reads it; a runtime's filesystem view is a view,
 * not a sandbox, and the confinement here is what makes that safe.
 */

/**
 * How long any one of the most recent workspace's four live reads — its git
 * status, its `repoOf`, its `topLevel`, and its `realpath` — may take before
 * a saved or empty answer stands in instead (#939, #948). Each shells out or
 * hits the filesystem on `latest.path` alone, so a stalled mount under any
 * one of them must cost that one row, at most, never the whole list.
 */
export const RECENT_LATEST_READ_TIMEOUT_MS = 1_000

/**
 * `within`, plus killing the process a read shells out to the moment the
 * bound fires — never leaving it running for its own much longer timeout
 * (`git`'s own 20s) after nobody is waiting on it here any more (#948). Only
 * for a read this handler owns outright: `repoOf` is deliberately left on
 * plain `within` below, because its result is cached in the host keyed by
 * folder (`#repoOf`, `host.ts`) and shared with whichever other caller asks
 * about the same folder while it is in flight — aborting it on this caller's
 * behalf would cut off every other caller sharing that same promise too.
 */
const withinKillable = <T>(read: (signal: AbortSignal) => Promise<T>, ms: number): Promise<Within<T>> => {
  const controller = new AbortController()
  return within(() => read(controller.signal), ms).then((result) => {
    if (result.settled === 'late') controller.abort()
    return result
  })
}

export const workspaceMethods = {
  'workspace/recent': async (ctx) => {
    // The most recent workspace is the one the renderer selects at
    // startup, so it alone carries git info and a live `realPath`: one
    // status call and one `realpath`, not one of each per folder ever
    // opened.
    //
    // Every other entry's `realPath` is read straight off the stored record
    // instead — `#openWorkspace` (host.ts) puts one there the moment a
    // folder is opened — rather than resolved again here. Up to 50 entries
    // are remembered, and a live resolve for every one of them, unbounded,
    // let a single stale mount hold up the whole list; a comparison key that
    // is a reload or two behind costs nothing worse than an extra row until
    // the folder is opened again (#943). An entry from before this field
    // existed simply has none yet, which is the same "no comparison key"
    // state `ownPathOf` already tolerates.
    //
    // The latest entry's own four live reads — git status, `repoOf`,
    // `topLevel` and `realPath` — are each bound the same way
    // (`RECENT_LATEST_READ_TIMEOUT_MS`), and each answers with a saved or
    // empty stand-in the moment its own bound is reached: a stalled mount
    // must not hold up the list it heads, and freshness here is a nicety a
    // slow filesystem forfeits, never something worth blocking on (#939,
    // #948).
    const [latest, ...rest] = ctx.state.state.workspaces
    if (!latest) return []
    const [git, repo, checkoutRoot, resolved] = await Promise.all([
      withinKillable((signal) => ctx.workspaces.gitStatus(latest.path, signal), RECENT_LATEST_READ_TIMEOUT_MS),
      within(() => ctx.workspaces.repoOf(latest.path), RECENT_LATEST_READ_TIMEOUT_MS),
      withinKillable((signal) => ctx.workspaces.topLevel(latest.path, signal), RECENT_LATEST_READ_TIMEOUT_MS),
      within(() => ctx.workspaces.realPath(latest.path), RECENT_LATEST_READ_TIMEOUT_MS),
    ])
    const latestGit = git.settled === 'value' ? git.value : null
    const latestRepo = repo.settled === 'value' ? repo.value : null
    const latestCheckoutRoot = checkoutRoot.settled === 'value' ? checkoutRoot.value : null
    const latestReal = resolved.settled === 'value' ? resolved.value : (latest.realPath ?? latest.path)
    return [
      {
        ...latest,
        git: latestGit ? { branch: latestGit.branch } : null,
        repo: latestRepo,
        checkoutRoot: latestCheckoutRoot,
        realPath: latestReal,
      },
      ...rest.map((entry) => ({ ...entry, git: null })),
    ]
  },

  'workspace/open': (ctx, params) => ctx.workspaces.open(params.path),

  'workspace/forget': async (ctx, params) => {
    await ctx.state.forgetWorkspace(params.path)
    ctx.workspaces.forgetBoardRoots()
    return null
  },

  'workspace/reveal': async (ctx, params) => {
    if (!ctx.options.revealPath) {
      throw new Error('Showing a folder in the file browser needs the desktop app.')
    }
    // Confined like every other path the renderer names: only an opened
    // workspace, or something inside one, can be revealed.
    await ctx.options.revealPath(confine(params.path, ctx.workspaces.openRoots()))
    return null
  },

  'workspace/pick': async (ctx) => {
    if (!ctx.options.pickDirectory) {
      throw new Error('A native directory picker is not available in this build.')
    }
    const picked = await ctx.options.pickDirectory()
    return picked ? ctx.workspaces.open(picked) : null
  },

  'workspace/files': (ctx, params) => {
    const root = confine(params.root, ctx.workspaces.openRoots())
    return ctx.runtimes.files(params.runtime).search([root], params.query, params.limit ?? 40)
  },

  'workspace/browse': (ctx, params) => browseDirectories(ctx.runtimes.files(params.runtime), params.path),

  'workspace/readFile': async (ctx, params) => {
    const path = confine(params.path, ctx.workspaces.fileRoots('read'))
    const files = ctx.runtimes.files(params.runtime)
    let metadata
    try {
      metadata = await files.stat(path)
    } catch (thrown) {
      if (isMissingWorkspaceFileError(thrown)) return { kind: 'missing' as const }
      return { kind: 'unreadable' as const, message: thrown instanceof Error ? thrown.message : String(thrown) }
    }

    if (metadata.size !== undefined && metadata.size > WORKSPACE_BINARY_LIMIT_BYTES) {
      return { kind: 'tooLarge' as const, size: metadata.size }
    }
    const readLimit = params.encoding === 'base64' ? WORKSPACE_BINARY_LIMIT_BYTES : WORKSPACE_TEXT_LIMIT_BYTES
    let bytes: Uint8Array
    try {
      // Read one byte over the applicable limit so a service without size
      // metadata can still distinguish an exact-limit file from an oversized one.
      bytes = await files.read(path, readLimit + 1)
    } catch (thrown) {
      if (thrown instanceof RuntimeFileTooLargeError) return { kind: 'tooLarge' as const, size: thrown.size }
      if (isMissingWorkspaceFileError(thrown)) return { kind: 'missing' as const }
      return { kind: 'unreadable' as const, message: thrown instanceof Error ? thrown.message : String(thrown) }
    }
    const size = metadata.size ?? bytes.byteLength
    if (bytes.byteLength > WORKSPACE_BINARY_LIMIT_BYTES) {
      return { kind: 'tooLarge' as const, size: Math.max(size, bytes.byteLength) }
    }
    if (params.encoding === 'base64') {
      return { kind: 'binary' as const, content: Buffer.from(bytes).toString('base64'), size, hash: sha256(bytes) }
    }
    if (isBinaryFile(bytes)) {
      return {
        kind: 'binary' as const,
        size,
        ...(bytes.byteLength <= WORKSPACE_TEXT_LIMIT_BYTES && size <= WORKSPACE_TEXT_LIMIT_BYTES ? { hash: sha256(bytes) } : {}),
      }
    }
    if (bytes.byteLength > WORKSPACE_TEXT_LIMIT_BYTES || size > WORKSPACE_TEXT_LIMIT_BYTES) {
      return { kind: 'tooLarge' as const, size: Math.max(size, bytes.byteLength) }
    }
    const maxBytes = Math.min(params.maxBytes ?? WORKSPACE_TEXT_LIMIT_BYTES, WORKSPACE_TEXT_LIMIT_BYTES)
    return { kind: 'text' as const, ...asText(bytes, maxBytes), hash: sha256(bytes) }
  },

  'workspace/stat': (ctx, params) =>
    ctx.runtimes.files(params.runtime).stat(confine(params.path, ctx.workspaces.fileRoots('read'))),

  'preview/ticket': (ctx, params) => {
    // Confinement is checked at issue time and again at redemption, so a
    // workspace being closed between the two closes the window as well.
    confine(params.path, ctx.workspaces.fileRoots('read'))
    return { ticket: ctx.workspaces.issuePreviewTicket(params.path, params.runtime) }
  },

  'file/save': async (ctx, params) => {
    const path = confine(params.path, ctx.workspaces.fileRoots('write'))
    const files = ctx.runtimes.files(params.runtime)
    if (!files.write) throw new Error('This runtime cannot write files from the interface.')
    // A failed stat/read is not permission to create over a file the host
    // could not inspect. Only ENOENT is the empty-hash creation case.
    let metadata
    try {
      metadata = await files.stat(path)
    } catch (thrown) {
      if (!isMissingWorkspaceFileError(thrown)) throw thrown
      if (params.expectedHash !== '') throw new Error('This file no longer exists; refusing to recreate it.')
      metadata = null
    }
    if (metadata?.size !== undefined && metadata.size > WORKSPACE_BINARY_LIMIT_BYTES) {
      return { saved: false as const, reason: 'tooLarge' as const, size: metadata.size }
    }

    // Compare before writing. Not atomic — no filesystem offers that
    // through these calls — but the window is the write itself, and the
    // alternative is overwriting whatever an agent just saved.
    let current: Uint8Array | null = null
    if (metadata !== null) {
      try {
        current = await files.read(path, WORKSPACE_TEXT_LIMIT_BYTES + 1)
      } catch (thrown) {
        if (thrown instanceof RuntimeFileTooLargeError) {
          return { saved: false as const, reason: 'tooLarge' as const, size: thrown.size }
        }
        if (!isMissingWorkspaceFileError(thrown)) throw thrown
        if (params.expectedHash !== '') throw new Error('This file no longer exists; refusing to recreate it.')
      }
    }
    if (current) {
      if (current.byteLength > WORKSPACE_BINARY_LIMIT_BYTES) {
        return { saved: false as const, reason: 'tooLarge' as const, size: current.byteLength }
      }
      const size = metadata?.size ?? current.byteLength
      if (isBinaryFile(current)) return { saved: false as const, reason: 'binary' as const, size }
      if (current.byteLength > WORKSPACE_TEXT_LIMIT_BYTES || size > WORKSPACE_TEXT_LIMIT_BYTES) {
        return { saved: false as const, reason: 'tooLarge' as const, size: Math.max(size, current.byteLength) }
      }
      const hash = sha256(current)
      if (hash !== params.expectedHash) {
        return { saved: false as const, conflict: { content: asText(current).content, hash } }
      }
    }
    const bytes = Buffer.from(params.content, 'utf8')
    await files.write(path, bytes)
    return { saved: true, hash: sha256(bytes) }
  },

  'editor/report': (ctx, params) => {
    // Answered without doing anything that can fail. A window reporting a
    // keystroke must never be made to wait, and there is nothing here for
    // it to recover from if it were.
    ctx.editor.report(params.event)
    return null
  },
} satisfies MethodsUnder<'workspace/' | 'preview/' | 'file/' | 'editor/'>
