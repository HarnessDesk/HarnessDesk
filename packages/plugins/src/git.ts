import type { HarnessContext, HarnessPlugin } from '@harnessdesk/cordis-host'

/**
 * Git tools, available to every agent.
 *
 * Written against the same API a third-party plugin uses — no privileged path.
 * It declares `shell` because it genuinely spawns `git`; routing that through
 * `ctx.shell` rather than importing `child_process` is what keeps the
 * permission model honest for HarnessDesk's own code too.
 */

/** Context is for reading, not for flooding a turn: past this, the tail is the agent's to fetch. */
const CONTEXT_LIMIT = 24_000

const cap = (text: string): string =>
  text.length > CONTEXT_LIMIT
    ? `${text.slice(0, CONTEXT_LIMIT)}\n\n[… ${text.length - CONTEXT_LIMIT} more characters; use the git tools for the rest]`
    : text

export const gitPlugin: HarnessPlugin = {
  manifest: {
    id: 'git',
    name: 'Git',
    description: 'Read-only git tools: status, diff, log, and branch context.',
    permissions: { workspace: { read: true, write: false }, shell: true },
    configSchema: {
      type: 'object',
      properties: {
        branchContext: {
          type: 'boolean',
          title: 'Tell the agent the current branch',
          description: 'Adds the branch name to every turn as context.',
        },
        logLimit: {
          type: 'number',
          title: 'Commits to show by default',
        },
      },
    },
  },
  plugin: {
    name: 'git',
    inject: ['tools', 'context', 'shell', 'workspace'],
    apply(ctx: HarnessContext, config: { branchContext?: boolean; logLimit?: number }) {
      const git = async (args: readonly string[]): Promise<string> => {
        if (!ctx.workspace.root) throw new Error('No workspace is open.')
        const result = await ctx.shell.run('git', args)
        if (result.exitCode !== 0 && !result.stdout) {
          throw new Error(result.stderr.trim() || `git ${args[0]} failed`)
        }
        return result.stdout.trim()
      }

      ctx.tools.register({
        name: 'git_status',
        description: 'Show the working tree status of the open workspace.',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => (await git(['status', '--short', '--branch'])) || 'clean',
      })

      ctx.tools.register({
        name: 'git_diff',
        description: 'Show uncommitted changes, optionally limited to one path.',
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Limit the diff to this path.' },
            staged: { type: 'boolean', description: 'Show staged changes instead.' },
          },
        },
        execute: async (args: { path?: string; staged?: boolean }) => {
          const argv = ['diff', '--no-color']
          if (args?.staged) argv.push('--cached')
          if (args?.path) argv.push('--', args.path)
          return (await git(argv)) || 'no changes'
        },
      })

      ctx.tools.register({
        name: 'git_log',
        description: 'Show recent commits.',
        inputSchema: {
          type: 'object',
          properties: { limit: { type: 'number', description: 'How many commits (default 20).' } },
        },
        execute: async (args: { limit?: number }) => {
          const limit = Math.min(Math.max(args?.limit ?? config?.logLimit ?? 20, 1), 200)
          return git(['log', `-${limit}`, '--oneline', '--no-color'])
        },
      })

      // Chips: context the user attaches on purpose (docs/extending.md).
      // "Write the commit message", "review what I did", "why does this fail"
      // all start with the working tree; pasting it was the chore.
      ctx.context.register({
        label: 'Uncommitted changes',
        form: 'resource',
        chip: { description: 'The working tree: status, unstaged and staged diffs.' },
        resolve: async () => {
          const status = await git(['status', '--short', '--branch'])
          const unstaged = await git(['diff', '--no-color'])
          const staged = await git(['diff', '--no-color', '--cached'])
          const parts = [`Status:\n${status || 'clean'}`]
          if (unstaged) parts.push(`Unstaged changes:\n${unstaged}`)
          if (staged) parts.push(`Staged changes:\n${staged}`)
          return cap(parts.join('\n\n'))
        },
      })

      // "Do this issue" and "review this PR" are the two most common ways a
      // task starts. gh uses the user's own login; HarnessDesk holds no token.
      ctx.context.register({
        label: 'GitHub issue or PR',
        form: 'resource',
        chip: {
          description: 'Title, body and discussion of an issue or pull request, through gh.',
          prompt: 'Issue or PR URL, or #123',
          match: String.raw`https?://github\.com/[^/\s]+/[^/\s]+/(?:issues|pull)/\d+`,
        },
        resolve: async (_scope, ref) => {
          const target = (ref ?? '').trim()
          if (!target) throw new Error('Which issue or pull request? Give a URL or a number.')
          const gh = async (args: readonly string[]): Promise<string> => {
            const result = await ctx.shell.run('gh', args)
            if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `gh ${args[0]} failed`)
            return result.stdout.trim()
          }
          const kinds = target.includes('/pull/') ? ['pr'] : target.includes('/issues/') ? ['issue'] : ['issue', 'pr']
          let lastError: unknown = null
          for (const kind of kinds) {
            try {
              const number = target.replace(/^#/, '')
              // `view` gives the item — title, state, author, body; `--comments`
              // gives only the discussion. Both, in that order, capped as one.
              const item = await gh([kind, 'view', number])
              let comments = ''
              try {
                comments = await gh([kind, 'view', number, '--comments'])
              } catch {
                // A discussion that will not load is not a reason to lose the item.
              }
              const sections = [`${kind === 'pr' ? 'Pull request' : 'Issue'} ${target}`, item]
              if (comments.trim()) sections.push(`Discussion:\n${comments}`)
              return cap(sections.join('\n\n'))
            } catch (error) {
              lastError = error
            }
          }
          throw lastError instanceof Error ? lastError : new Error(`Could not read ${target}.`)
        },
      })

      // The branch is small, stable, and almost always relevant, so it is
      // context rather than something the agent must spend a tool call on.
      if (config?.branchContext === false) return

      ctx.context.register({
        label: 'Git',
        resolve: async () => {
          if (!ctx.workspace.root) return ''
          try {
            return `The workspace is on git branch \`${await git(['rev-parse', '--abbrev-ref', 'HEAD'])}\`.`
          } catch {
            return ''
          }
        },
      })
    },
  },
}
