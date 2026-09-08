import * as gitService from '../git.js'
import * as gitOps from '../git-ops.js'
import * as gitHistory from '../git-history.js'
import * as gitActions from '../git-actions.js'
import * as gitWorktree from '../git-worktree.js'
import type { MethodsUnder } from './context.js'

/**
 * The git client in the pane. Every verb starts by confining the root the
 * renderer named to an open workspace, made real through symlinks, so the
 * one line each handler adds is the git move itself.
 */
export const gitMethods = {
  'git/status': async (ctx, params) => gitService.status(await ctx.workspaces.confineGitRoot(params.root)),

  'git/branches': async (ctx, params) => gitOps.listBranches(await ctx.workspaces.confineGitRoot(params.root)),

  'git/checkout': async (ctx, params) => {
    const root = await ctx.workspaces.confineGitRoot(params.root)
    await gitOps.checkout(root, params.branch, { ...(params.create ? { create: true } : {}) })
    return { branch: params.branch }
  },

  'git/diff': async (ctx, params) => ({
    diff: await gitService.diff(await ctx.workspaces.confineGitRoot(params.root), {
      ...(params.path ? { path: params.path } : {}),
      ...(params.staged ? { staged: params.staged } : {}),
    }),
  }),

  'git/log': async (ctx, params) =>
    gitHistory.log(await ctx.workspaces.confineGitRoot(params.root), {
      ...(params.scope ? { scope: params.scope } : {}),
      ...(params.skip !== undefined ? { skip: params.skip } : {}),
      ...(params.limit !== undefined ? { limit: params.limit } : {}),
      ...(params.query ? { query: params.query } : {}),
      ...(params.search ? { search: params.search } : {}),
    }),

  'git/refs': async (ctx, params) => gitHistory.refs(await ctx.workspaces.confineGitRoot(params.root)),

  'git/commit': async (ctx, params) => gitHistory.commit(await ctx.workspaces.confineGitRoot(params.root), params.sha),

  'git/commitDiff': async (ctx, params) => ({
    diff: await gitHistory.commitDiff(await ctx.workspaces.confineGitRoot(params.root), params.sha, params.path),
  }),

  'git/createBranch': async (ctx, params) => {
    const root = await ctx.workspaces.confineGitRoot(params.root)
    // Creating and switching is two git moves. Anything the switch would
    // refuse — a dirty tree, a name its gate does not take — is asked
    // first, so a refusal leaves no half-made branch behind for the retry
    // to trip over.
    if (params.checkout) await gitOps.checkoutPreflight(root, params.name)
    await gitHistory.createBranch(root, params.name, params.at)
    // Switching to it is the same move a branch row's checkout is, with
    // the same dirty-tree refusal — the branch exists either way.
    if (params.checkout) await gitOps.checkout(root, params.name)
    return { branch: params.name }
  },

  'git/commitAll': async (ctx, params) =>
    gitActions.commitAll(
      await ctx.workspaces.confineGitRoot(params.root),
      params.message,
      params.paths ? [...params.paths] : undefined,
    ),

  'git/pull': async (ctx, params) => gitActions.pull(await ctx.workspaces.confineGitRoot(params.root)),

  'git/push': async (ctx, params) => gitActions.push(await ctx.workspaces.confineGitRoot(params.root)),

  'git/fetch': async (ctx, params) => gitActions.fetch(await ctx.workspaces.confineGitRoot(params.root)),

  'git/merge': async (ctx, params) => gitActions.merge(await ctx.workspaces.confineGitRoot(params.root), params.ref),

  'git/rebase': async (ctx, params) => gitActions.rebase(await ctx.workspaces.confineGitRoot(params.root), params.onto),

  'git/checkoutCommit': async (ctx, params) => {
    const root = await ctx.workspaces.confineGitRoot(params.root)
    // The same dirty-tree refusal every checkout gets: carrying edits
    // onto a detached head silently is the worse surprise.
    await gitOps.assertCleanTree(root)
    await gitActions.checkoutCommit(root, params.sha)
    return null
  },

  'git/renameBranch': async (ctx, params) => {
    await gitActions.renameBranch(await ctx.workspaces.confineGitRoot(params.root), params.from, params.to)
    return null
  },

  'git/deleteBranch': async (ctx, params) => {
    await gitActions.deleteBranch(await ctx.workspaces.confineGitRoot(params.root), params.name, params.force === true)
    return null
  },

  'git/createTag': async (ctx, params) => {
    await gitActions.createTag(await ctx.workspaces.confineGitRoot(params.root), params.name, params.at, params.message)
    return null
  },

  'git/deleteTag': async (ctx, params) => {
    await gitActions.deleteTag(await ctx.workspaces.confineGitRoot(params.root), params.name)
    return null
  },

  'git/reset': async (ctx, params) => {
    await gitActions.reset(await ctx.workspaces.confineGitRoot(params.root), params.to, params.mode)
    return null
  },

  'git/revert': async (ctx, params) =>
    gitActions.revertCommit(await ctx.workspaces.confineGitRoot(params.root), params.sha),

  'git/cherryPick': async (ctx, params) =>
    gitActions.cherryPick(await ctx.workspaces.confineGitRoot(params.root), params.sha),

  'git/stashSave': async (ctx, params) => {
    await gitActions.stashSave(await ctx.workspaces.confineGitRoot(params.root), params.message)
    return null
  },

  'git/stashApply': async (ctx, params) =>
    gitActions.stashApply(await ctx.workspaces.confineGitRoot(params.root), params.ref, params.pop === true),

  'git/stashDrop': async (ctx, params) => {
    await gitActions.stashDrop(await ctx.workspaces.confineGitRoot(params.root), params.ref)
    return null
  },

  'git/patch': async (ctx, params) => ({
    patch: await gitActions.patch(await ctx.workspaces.confineGitRoot(params.root), params.sha),
  }),

  'git/diffRange': async (ctx, params) => ({
    diff: await gitActions.diffRange(await ctx.workspaces.confineGitRoot(params.root), params.from, params.to),
  }),

  'git/pullRequestUrl': async (ctx, params) => ({
    url: await gitActions.pullRequestUrl(await ctx.workspaces.confineGitRoot(params.root), params.branch),
  }),

  // The worktree paths below are never confined against open roots: a
  // worktree lives outside the repository by design. What confines them
  // is stricter — the verb acts only on a path git itself reports as a
  // worktree of a repository the user has open, and a new one may only
  // land beside that repository.
  'git/worktrees': async (ctx, params) =>
    gitWorktree.list(await ctx.workspaces.confineGitRoot(params.root), ctx.state.directory),

  'git/worktreeAdd': async (ctx, params) =>
    gitWorktree.add(await ctx.workspaces.confineGitRoot(params.root), params.path, params.checkout, ctx.state.directory),

  'git/worktreeInventory': async (ctx, params) =>
    gitWorktree.inventoryOf(await ctx.workspaces.confineGitRoot(params.root), params.path, ctx.state.directory),

  'git/worktreeRemove': async (ctx, params) =>
    gitWorktree.remove(
      await ctx.workspaces.confineGitRoot(params.root),
      params.path,
      params.force === true,
      params.expect,
      ctx.state.directory,
    ),

  'git/worktreePrune': async (ctx, params) => gitWorktree.prune(await ctx.workspaces.confineGitRoot(params.root)),

  'git/worktreeLock': async (ctx, params) => {
    await gitWorktree.setLock(
      await ctx.workspaces.confineGitRoot(params.root),
      params.path,
      params.locked,
      params.reason,
      ctx.state.directory,
    )
    return null
  },

  'git/worktreeMove': async (ctx, params) =>
    gitWorktree.move(await ctx.workspaces.confineGitRoot(params.root), params.from, params.to, ctx.state.directory),
} satisfies MethodsUnder<'git/'>
