import { resolve, sep } from 'node:path'

import { isBusy } from '@harnessdesk/protocol'

import { confine } from '../workspace.js'
import { confineToOpenRepository, openRepositoryRoot } from '../worktree.js'
import type { MethodsUnder } from './context.js'

/**
 * The managed worktrees a conversation can run in — the session plane's
 * worktrees, kept in the state directory. The git client's own worktree verbs
 * (`git/worktree*`) live with the rest of git.
 */
export const worktreeMethods = {
  // Held to the repositories opened here, as the verbs below are, rather than
  // to open folders as `git/worktrees` is: after a refused bring-back the store
  // lists the main checkout, which that dialog also reads through
  // `worktree/changes`, and which is outside every open folder when the one
  // open is a linked worktree. A folder in no repository answers an empty
  // list, not a refusal: the store asks this of every folder it opens.
  'worktree/list': async (ctx, params) => {
    const main = await openRepositoryRoot(params.root, ctx.workspaces.openRoots())
    return main === null ? [] : ctx.worktrees.list(main)
  },

  'worktree/create': (ctx, params) => {
    confine(params.root, ctx.workspaces.openRoots())
    return ctx.worktrees.create(params.root, {
      name: params.name,
      ...(params.base ? { base: params.base } : {}),
    })
  },

  // The verbs that change a repository, and the read their dialogs make
  // first, are held to repositories opened here (the projects the desk
  // remembers, the folders of live conversations, and what sits inside or
  // around them), as `worktree/create` is to its open roots.
  'worktree/changes': async (ctx, params) => {
    await confineToOpenRepository(params.path, ctx.workspaces.openRoots())
    return ctx.worktrees.changes(params.path)
  },

  'worktree/remove': async (ctx, params) => {
    await confineToOpenRepository(params.path, ctx.workspaces.openRoots())
    // A conversation mid-turn in the worktree would lose whatever it writes after
    // the folder goes, so the removal is held while any session in it is working.
    const target = resolve(params.path)
    const working = ctx.registry.snapshot().find((session) => {
      const cwd = resolve(session.cwd)
      return (cwd === target || cwd.startsWith(target + sep)) && isBusy(session)
    })
    if (working) throw new Error(`A conversation in ${params.path} is still working. Remove it once its turn ends.`)
    return ctx.worktrees.remove(params.path, { ...(params.force ? { force: true } : {}) })
  },

  'worktree/bringHome': async (ctx, params) => {
    await confineToOpenRepository(params.path, ctx.workspaces.openRoots())
    // The dialog holds the move while a conversation in the worktree is
    // working, but a turn can start between the dialog and this request. The
    // registry is the host's own record of every live session, so the move
    // is held here as well; a turn that starts after this is what it cannot see.
    const target = resolve(params.path)
    const working = ctx.registry.snapshot().find((session) => {
      const cwd = resolve(session.cwd)
      return (cwd === target || cwd.startsWith(target + sep)) && isBusy(session)
    })
    if (working) throw new Error(`A conversation in ${params.path} is still working. Bring it back once its turn ends.`)
    return ctx.worktrees.bringHome(params.path)
  },
} satisfies MethodsUnder<'worktree/'>
