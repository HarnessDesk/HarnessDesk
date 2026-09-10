import type { HarnessContext, HarnessPlugin } from '@harnessdesk/cordis-host'

/**
 * Search across the workspace.
 *
 * DeepSeek Harness ships this as `dsh-tool-fs-search`, and it earns its place:
 * an agent that can only read named files has to guess names. Prefers ripgrep
 * when it is installed — it respects `.gitignore`, which a naive walk does not,
 * and the difference on a real repository is the difference between a useful
 * answer and a page of `node_modules`.
 */

interface Config {
  readonly maxResults?: number
  readonly maxLineLength?: number
}

const DEFAULT_MAX_RESULTS = 80
const DEFAULT_MAX_LINE = 300

export const searchPlugin: HarnessPlugin = {
  manifest: {
    id: 'search',
    name: 'Search',
    description: 'Find text and files across the open workspace.',
    permissions: { workspace: { read: true, write: false }, shell: true },
    configSchema: {
      type: 'object',
      properties: {
        maxResults: { type: 'number', title: 'Maximum matches returned' },
        maxLineLength: { type: 'number', title: 'Longest line returned' },
      },
    },
  },
  plugin: {
    name: 'search',
    inject: ['tools', 'shell', 'workspace'],
    apply(ctx: HarnessContext, config: Config) {
      const maxResults = Math.min(Math.max(config?.maxResults ?? DEFAULT_MAX_RESULTS, 1), 500)
      const maxLine = Math.max(config?.maxLineLength ?? DEFAULT_MAX_LINE, 40)

      const requireRoot = (): string => {
        const root = ctx.workspace.root
        if (!root) throw new Error('No workspace is open.')
        return root
      }

      /** Long lines are usually minified files; truncating keeps the result readable. */
      const clip = (line: string): string =>
        line.length > maxLine ? `${line.slice(0, maxLine)}…` : line

      const hasRipgrep = async (): Promise<boolean> => {
        const probe = await ctx.shell.run('which', ['rg'])
        return probe.exitCode === 0 && probe.stdout.trim().length > 0
      }

      ctx.tools.register({
        name: 'search_text',
        description:
          'Search the workspace for a regular expression and return matching lines with their file and line number.',
        inputSchema: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Regular expression to search for.' },
            glob: { type: 'string', description: 'Restrict to paths matching this glob, e.g. "*.ts".' },
            ignoreCase: { type: 'boolean' },
          },
          required: ['pattern'],
        },
        execute: async (args: { pattern: string; glob?: string; ignoreCase?: boolean }) => {
          requireRoot()
          if (!(await hasRipgrep())) {
            return 'ripgrep (`rg`) is not installed, so workspace search is unavailable. Install it with `brew install ripgrep`.'
          }
          /* `--max-count` is ripgrep's cap *per file*, not in total. At 20, a
             file with more matches than that was cut at twenty however high
             the caller's limit was, and whether or not anything else matched
             (#53). A file may now give as many as the result can show, and
             the total is still cut to `maxResults` below. */
          const argv = ['--line-number', '--no-heading', '--color', 'never', '--max-count', String(maxResults)]
          if (args.ignoreCase) argv.push('--ignore-case')
          if (args.glob) argv.push('--glob', args.glob)
          argv.push('--regexp', args.pattern)
          // Explicit search path. Without one, ripgrep reads *stdin* whenever
          // stdin is not a TTY — which it never is for a spawned process — so
          // every search silently returned nothing.
          argv.push('.')

          const result = await ctx.shell.run('rg', argv)
          // ripgrep exits 1 for "no matches", which is an answer, not a failure.
          if (result.exitCode !== 0 && result.stdout.trim().length === 0) {
            const stderr = result.stderr.trim()
            return stderr.length > 0 ? `Search failed: ${stderr}` : 'No matches.'
          }
          const lines = result.stdout.split('\n').filter(Boolean)
          const shown = lines.slice(0, maxResults).map(clip)
          return lines.length > maxResults
            ? // "At least": a file past the per-file cap above counts only up to it.
              `${shown.join('\n')}\n\n[at least ${lines.length - maxResults} more matches not shown — narrow the pattern]`
            : shown.join('\n') || 'No matches.'
        },
      })

      ctx.tools.register({
        name: 'find_files',
        description: 'Find files in the workspace whose path matches a glob.',
        inputSchema: {
          type: 'object',
          properties: {
            glob: { type: 'string', description: 'Glob such as "**/*.test.ts".' },
          },
          required: ['glob'],
        },
        execute: async (args: { glob: string }) => {
          requireRoot()
          if (!(await hasRipgrep())) {
            return 'ripgrep (`rg`) is not installed, so file search is unavailable. Install it with `brew install ripgrep`.'
          }
          const result = await ctx.shell.run('rg', ['--files', '--glob', args.glob, '.'])
          /* ripgrep exits 1 for "no files", which is an answer, and 2 for an
             error — a glob it cannot parse, a path it cannot read — which is
             not. Both read as "No files match.", so an agent that wrote `[`
             for a bracket was told the workspace had nothing of the kind
             (#54). The reading search_text already had. */
          if (result.exitCode !== 0 && result.stdout.trim().length === 0) {
            const stderr = result.stderr.trim()
            return stderr.length > 0 ? `File search failed: ${stderr}` : 'No files match.'
          }
          const files = result.stdout.split('\n').filter(Boolean)
          if (files.length === 0) return 'No files match.'
          return files.length > maxResults
            ? `${files.slice(0, maxResults).join('\n')}\n\n[${files.length - maxResults} more]`
            : files.join('\n')
        },
      })
    },
  },
}
