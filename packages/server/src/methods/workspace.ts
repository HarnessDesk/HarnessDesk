import * as gitService from '../git.js'
import { asText, browseDirectories, confine, sha256 } from '../workspace.js'
import type { MethodsUnder } from './context.js'

/**
 * Folders and files. Every path the renderer names is confined to an open
 * workspace before anything reads it; a runtime's filesystem view is a view,
 * not a sandbox, and the confinement here is what makes that safe.
 */
export const workspaceMethods = {
  'workspace/recent': async (ctx) => {
    // The most recent workspace is the one the renderer selects at
    // startup, so it alone carries git info: one status call, not one
    // per folder ever opened.
    const [latest, ...rest] = ctx.state.state.workspaces
    if (!latest) return []
    const [git, repo] = await Promise.all([
      gitService.status(latest.path).catch(() => null),
      ctx.workspaces.repoOf(latest.path),
    ])
    return [
      { ...latest, git: git ? { branch: git.branch } : null, repo },
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
    const path = confine(params.path, ctx.workspaces.openRoots())
    const bytes = await ctx.runtimes.files(params.runtime).read(path)
    const hash = sha256(bytes)
    if (params.encoding === 'base64') {
      return { content: Buffer.from(bytes).toString('base64'), truncated: false, hash }
    }
    return { ...asText(bytes, params.maxBytes), hash }
  },

  'workspace/stat': (ctx, params) =>
    ctx.runtimes.files(params.runtime).stat(confine(params.path, ctx.workspaces.openRoots())),

  'preview/ticket': (ctx, params) => {
    // Confinement is checked at issue time and again at redemption, so a
    // workspace being closed between the two closes the window as well.
    confine(params.path, ctx.workspaces.openRoots())
    return { ticket: ctx.workspaces.issuePreviewTicket(params.path, params.runtime) }
  },

  'file/save': async (ctx, params) => {
    const path = confine(params.path, ctx.workspaces.openRoots())
    const files = ctx.runtimes.files(params.runtime)
    if (!files.write) throw new Error('This runtime cannot write files from the interface.')
    // Compare before writing. Not atomic — no filesystem offers that
    // through these calls — but the window is the write itself, and the
    // alternative is overwriting whatever an agent just saved.
    const current = await files.read(path).catch(() => null)
    const hash = current ? sha256(current) : ''
    if (current && hash !== params.expectedHash) {
      return { saved: false, conflict: { content: asText(current).content, hash } }
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
