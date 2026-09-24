import { admitMemoryRoot, listMemoryFiles } from '../memory/git.js'
import { projectOf } from './agents.js'
import type { MethodsUnder } from './context.js'

/**
 * Task 6's read-only front door onto Task 2's retention: every committed
 * `.harnessdesk/memory/*.md` file at one exact revision, and one citation's
 * retained bytes with truthful missing-source labels. Neither handler
 * accepts a path that was not confined to a project this desk actually has
 * open — `projectOf` is the exact confinement `agent/ceiling/*` already
 * trusts, and `admitMemoryRoot` is Task 2's own git-specific check on top of
 * it (an ordinary checkout, no external object alternates).
 */
export const memoryMethods = {
  'memory/list': async (ctx, params) => {
    await projectOf(ctx, params.root) // throws unless root is within a project this desk has open
    const root = await admitMemoryRoot(params.root)
    const files = await listMemoryFiles(root, params.at)
    return files.map((one) => ({ path: one.path, at: params.at, problem: one.problem }))
  },

  'memory/read': async (ctx, params) => {
    // Checked against the caller's own raw `root` — never against a
    // realpath'd or otherwise re-derived value, which a project reached
    // through a symlink could make differ from the exact string
    // `GoalPlane.cite` bound into the citation at the moment it was made.
    // This is the one check that keeps an archive key or source path scoped
    // to the project that made it (decision 1); the two calls below are
    // ordinary "is this an open, ordinary checkout" validity checks, not
    // part of that boundary.
    if (params.citation.project !== params.root) {
      throw new Error('This citation does not belong to the selected project.')
    }
    await projectOf(ctx, params.root)
    await admitMemoryRoot(params.root)
    return ctx.goals.resolveMemory(params.citation)
  },
} satisfies MethodsUnder<'memory/'>
