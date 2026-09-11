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

/**
 * A note for results ripgrep gave while also failing — a folder it could not
 * read beside files it could, or output cut off at the shell's limit — so a
 * partial answer is not read as a whole one (review, round one). Exit 1 is
 * "nothing found", which is an answer; 2 is an error, and -1 a search that
 * never finished (#161).
 */
const partial = (result: { readonly exitCode: number; readonly stderr: string }): string => {
  if (result.exitCode === 0 || result.exitCode === 1) return ''
  const said = result.stderr.trim().split('\n').filter(Boolean).at(-1)
  return `\n\n[ripgrep hit an error, so this may be incomplete${said ? `: ${said}` : ''}]`
}

/**
 * What an empty answer means. Exit 1 is "nothing found"; any other, 2 for an
 * error or -1 for a search that never finished, is a failure whether or not
 * ripgrep said why. Read by stderr alone, an exit 2 with nothing on it said
 * "No matches." (#161).
 */
const emptyAnswer = (result: { readonly exitCode: number; readonly stderr: string }, none: string, failed: string): string => {
  if (result.exitCode === 1) return none
  const said = result.stderr.trim()
  return `${failed}: ${said || `ripgrep exited ${result.exitCode} and said nothing`}`
}

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
      /* Whole: it is ripgrep's `--max-count` too now, and ripgrep refuses a
         fraction, so a setting of 10.5 failed every search (review, round
         two). And finite, for the same reason: JSON can't carry a NaN, but a
         caller that isn't JSON can (#161). */
      const finite = (value: number | undefined, fallback: number): number =>
        typeof value === 'number' && Number.isFinite(value) ? value : fallback
      const maxResults = Math.trunc(Math.min(Math.max(finite(config?.maxResults, DEFAULT_MAX_RESULTS), 1), 500))
      /* And at most 100,000 characters, since it is ripgrep's `--max-columns`
         too: ripgrep refuses a number past a u64 and reads `1e+21` as no
         number at all, so a large setting failed every search (review of #239,
         round 1). */
      const maxLine = Math.trunc(Math.min(Math.max(finite(config?.maxLineLength, DEFAULT_MAX_LINE), 40), 100_000))

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
             (#53). A file may now give one more than the result can show —
             the one more is what lets a file with too many matches still say
             so below, where a cap of exactly `maxResults` cut it there in
             silence (review, round one) — and the total is cut to
             `maxResults`. */
          /* And ripgrep cuts each line at the longest this shows. The shell keeps
             16 MB of output, and one minified bundle's line could fill it, so a
             broad pattern came back cut off (#161). The number of lines is
             still bounded only by `maxResults + 1` a file. */
          const argv = ['--line-number', '--no-heading', '--color', 'never', '--max-count', String(maxResults + 1)]
          argv.push('--max-columns', String(maxLine), '--max-columns-preview')
          if (args.ignoreCase) argv.push('--ignore-case')
          if (args.glob) argv.push('--glob', args.glob)
          argv.push('--regexp', args.pattern)
          // Explicit search path. Without one, ripgrep reads *stdin* whenever
          // stdin is not a TTY — which it never is for a spawned process — so
          // every search silently returned nothing.
          argv.push('.')

          const result = await ctx.shell.run('rg', argv)
          // ripgrep exits 1 for "no matches", which is an answer, not a failure.
          if (result.exitCode !== 0 && result.stdout.trim().length === 0) return emptyAnswer(result, 'No matches.', 'Search failed')
          const lines = result.stdout.split('\n').filter(Boolean)
          const shown = lines.slice(0, maxResults).map(clip)
          const more = lines.length - maxResults
          return more > 0
            ? // "At least": a file past the per-file cap above counts only up to it.
              `${shown.join('\n')}\n\n[at least ${more} more ${more === 1 ? 'match' : 'matches'} not shown — narrow the pattern]${partial(result)}`
            : `${shown.join('\n')}${partial(result)}` || 'No matches.'
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
          if (result.exitCode !== 0 && result.stdout.trim().length === 0) return emptyAnswer(result, 'No files match.', 'File search failed')
          const files = result.stdout.split('\n').filter(Boolean)
          if (files.length === 0) return 'No files match.'
          const more = files.length - maxResults
          return more > 0
            ? `${files.slice(0, maxResults).join('\n')}\n\n[${more} more ${more === 1 ? 'file' : 'files'}]${partial(result)}`
            : `${files.join('\n')}${partial(result)}`
        },
      })
    },
  },
}
