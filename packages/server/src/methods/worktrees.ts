import { confine } from '../workspace.js'
import { confineToOpenRepository } from '../worktree.js'
import type { MethodsUnder } from './context.js'

/**
 * The managed worktrees a conversation can run in — the session plane's
 * worktrees, kept in the state directory. The git client's own worktree verbs
 * (`git/worktree*`) live with the rest of git.
 */
export const worktreeMethods = {
  'worktree/list': (ctx, params) => ctx.worktrees.list(params.root),

  'worktree/create': (ctx, params) => {
    confine(params.root, ctx.workspaces.openRoots())
    return ctx.worktrees.create(params.root, {
      name: params.name,
      ...(params.base ? { base: params.base } : {}),
    })
  },

  'worktree/changes': (ctx, params) => ctx.worktrees.changes(params.path),

  // The two verbs that change a repository are held to the repositories the
  // window has open, as `worktree/create` is to its open roots.
  'worktree/remove': async (ctx, params) => {
    await confineToOpenRepository(params.path, ctx.workspaces.openRoots())
    return ctx.worktrees.remove(params.path, { ...(params.force ? { force: true } : {}) })
  },

  'worktree/bringHome': async (ctx, params) => {
    await confineToOpenRepository(params.path, ctx.workspaces.openRoots())
    return ctx.worktrees.bringHome(params.path)
  },
} satisfies MethodsUnder<'worktree/'>
