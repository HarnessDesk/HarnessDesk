import type { HarnessContext, HarnessPlugin } from '@harnessdesk/cordis-host'

import type { ScopeQuery } from '@harnessdesk/protocol'

import { PerSession } from './session-state.js'

/**
 * A safety net before the agent changes anything.
 *
 * DeepSeek Harness has `dsh-session-checkpoint-policy`. The value is simple: an
 * agent that edits ten files is much easier to let run when the previous state
 * is one command away.
 *
 * Uses `git stash create`, which builds a commit object from the working tree
 * without touching the tree, the index, or the stash list. Nothing the user
 * sees changes — no stray commits, no branch moves, no `git stash pop` waiting
 * to surprise them later.
 *
 * It deliberately does **not** restore. A plugin that can roll the working tree
 * back is a plugin that can destroy work; recording the sha and telling the user
 * the exact command is the honest division of labour.
 */

export interface Checkpoint {
  readonly sha: string
  readonly at: number
  readonly note: string
}

/** The command a user runs to inspect or recover a checkpoint. */
export const recoveryHint = (sha: string): string =>
  `git diff ${sha} — to see what changed since, or \`git restore --source ${sha} -- .\` to put it back.`

export const checkpointPlugin: HarnessPlugin = {
  manifest: {
    id: 'checkpoint',
    name: 'Checkpoints',
    description:
      'Records a recoverable snapshot of the working tree before the agent starts changing files.',
    permissions: { workspace: { read: true, write: false }, shell: true },
  },
  plugin: {
    name: 'checkpoint',
    inject: ['tools', 'hooks', 'context', 'shell', 'workspace'],
    apply(ctx: HarnessContext) {
      /* Per conversation: the kernel is one instance for the whole
         application, so a shared list meant `list_checkpoints` — documented as
         "taken during this session" — answered with every session's, and one
         conversation starting a turn cleared another's `takenThisTurn`,
         suppressing the checkpoint it was about to take. */
      const sessions = new PerSession(() => ({
        checkpoints: [] as Checkpoint[],
        takenThisTurn: false,
      }))

      const git = async (args: readonly string[]): Promise<string | null> => {
        if (!ctx.workspace.root) return null
        const result = await ctx.shell.run('git', args)
        return result.exitCode === 0 ? result.stdout.trim() : null
      }

      const take = async (scope: ScopeQuery | undefined, note: string): Promise<Checkpoint | null> => {
        // `stash create` returns empty on a clean tree — there is nothing to
        // recover to that HEAD does not already describe.
        const sha = (await git(['stash', 'create'])) || (await git(['rev-parse', 'HEAD']))
        if (!sha) return null
        const checkpoint = { sha: sha.slice(0, 12), at: Date.now(), note }
        sessions.get(scope).checkpoints.push(checkpoint)
        return checkpoint
      }

      ctx.hooks.register({
        event: 'preTurn',
        handle: (invocation) => void (sessions.get(invocation.scope).takenThisTurn = false),
      })

      ctx.hooks.register({
        event: 'preToolUse',
        // Runs before anything that might deny, so a checkpoint exists even for
        // an operation the user goes on to refuse.
        priority: 10,
        handle: async (invocation) => {
          const state = sessions.get(invocation.scope)
          if (state.takenThisTurn) return
          const name = invocation.toolName ?? ''
          // Only for tools that can change the tree; a search does not need one.
          if (!/write|edit|patch|apply|replace|delete|move|shell|bash|exec/i.test(name)) return
          state.takenThisTurn = true
          await take(invocation.scope, `before ${name}`)
          return
        },
      })

      ctx.tools.register({
        name: 'create_checkpoint',
        description:
          'Record a recoverable snapshot of the working tree. Useful before a risky change.',
        inputSchema: {
          type: 'object',
          properties: { note: { type: 'string', description: 'What you are about to do.' } },
        },
        execute: async (args: { note?: string }, scope: ScopeQuery) => {
          const checkpoint = await take(scope, args?.note?.trim() || 'manual')
          if (!checkpoint) return 'This workspace is not a git repository, so no checkpoint was taken.'
          return `Checkpoint ${checkpoint.sha} recorded. ${recoveryHint(checkpoint.sha)}`
        },
      })

      ctx.tools.register({
        name: 'list_checkpoints',
        description: 'List the recoverable snapshots taken during this session.',
        inputSchema: { type: 'object', properties: {} },
        execute: (_args: unknown, scope: ScopeQuery) => {
          const { checkpoints } = sessions.get(scope)
          return checkpoints.length === 0
            ? 'No checkpoints have been taken.'
            : checkpoints
                .map(
                  (entry) =>
                    `${entry.sha}  ${new Date(entry.at).toLocaleTimeString()}  ${entry.note}`,
                )
                .join('\n')
        },
      })

      ctx.context.register({
        label: 'Checkpoints',
        resolve: (scope: ScopeQuery) => {
          const { checkpoints } = sessions.get(scope)
          const latest = checkpoints[checkpoints.length - 1]
          return latest
            ? `A recoverable snapshot of the working tree was taken at ${latest.sha}. If a change goes wrong, tell the user: ${recoveryHint(latest.sha)}`
            : ''
        },
      })
    },
  },
}
