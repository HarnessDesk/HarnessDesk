import type { HarnessContext, HarnessPlugin } from '@harnessdesk/cordis-host'

import type { ScopeQuery } from '@harnessdesk/protocol'

import { PerSession } from './session-state.js'

/**
 * Structured test running, for every agent and every stack.
 *
 * The value over "the agent shells out" is structure: the framework is
 * detected once, the invocation is right the first time, and the answer
 * leads with the verdict and the failing file:lines instead of making the
 * model dig them out of scrollback. Detection is by artifact, not by guess,
 * and saying "no framework detected" beats inventing a command.
 */

interface Framework {
  readonly name: string
  readonly command: string
  readonly args: readonly string[]
  /** Appends a filter argument in the framework's own dialect. */
  readonly filter?: (value: string) => readonly string[]
}

const NODE_RUNNERS: readonly { readonly marker: RegExp; readonly make: (runner: string) => Framework }[] = [
  {
    marker: /\bvitest\b/,
    make: () => ({ name: 'vitest', command: 'npx', args: ['vitest', 'run'], filter: (v) => [v] }),
  },
  {
    marker: /\bjest\b/,
    make: () => ({ name: 'jest', command: 'npx', args: ['jest'], filter: (v) => [v] }),
  },
]

export const detectFramework = async (
  exists: (path: string) => Promise<boolean>,
  read: (path: string) => Promise<string>,
): Promise<Framework | null> => {
  if (await exists('package.json')) {
    const raw = await read('package.json').catch(() => '{}')
    for (const runner of NODE_RUNNERS) {
      if (runner.marker.test(raw)) return runner.make(raw)
    }
    try {
      const parsed = JSON.parse(raw) as { scripts?: Record<string, string> }
      if (parsed.scripts?.['test'] && !/no test specified/.test(parsed.scripts['test'])) {
        return { name: 'npm test', command: 'npm', args: ['test', '--silent'] }
      }
    } catch {
      // fall through
    }
  }
  if ((await exists('pytest.ini')) || (await exists('setup.cfg')) || (await exists('pyproject.toml'))) {
    const marker = (await exists('pyproject.toml')) ? await read('pyproject.toml').catch(() => '') : 'pytest'
    if (/pytest/.test(marker) || (await exists('pytest.ini'))) {
      return { name: 'pytest', command: 'python3', args: ['-m', 'pytest', '-q'], filter: (v) => ['-k', v] }
    }
  }
  if (await exists('go.mod')) {
    return { name: 'go test', command: 'go', args: ['test', './...'], filter: (v) => ['-run', v] }
  }
  if (await exists('Cargo.toml')) {
    return { name: 'cargo test', command: 'cargo', args: ['test'], filter: (v) => [v] }
  }
  if ((await exists('build.gradle')) || (await exists('build.gradle.kts'))) {
    return { name: 'gradle test', command: './gradlew', args: ['test'], filter: (v) => ['--tests', v] }
  }
  if (await exists('Package.swift')) {
    return { name: 'swift test', command: 'swift', args: ['test'], filter: (v) => ['--filter', v] }
  }
  return null
}

/** The failing file:line pairs a stack trace or reporter line gives away. */
export const extractFailures = (output: string): readonly string[] => {
  const found = new Set<string>()
  // A runner that forces colour wraps the keyword in escape codes, and a `FAIL` behind one never matched (#174).
  const plain = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
  /* Each pattern says what its entry is. One ternary served both, and for a
     reporter's own failure line it put the keyword where the file goes
     whenever the description held a digit: `FAIL src/auth.test.ts (15ms)`
     came out `FAIL:src/auth.test.ts (15ms)` (#55). */
  const patterns: readonly (readonly [RegExp, (match: RegExpMatchArray) => string])[] = [
    // A file and a line, from a stack or a summary.
    [/(?:^|\s|\()([\w./-]+\.(?:ts|tsx|js|jsx|mjs|py|go|rs|swift|kt|java)):(\d+)/gm, (match) => `${match[1]}:${match[2]}`],
    // A reporter's failure line: what follows the keyword.
    [/^\s*(FAIL|FAILED|✗|✖|not ok)\s+(.+)$/gm, (match) => (match[2] ?? '').trim()],
  ]
  for (const [pattern, entryOf] of patterns) {
    for (const match of plain.matchAll(pattern)) {
      const entry = entryOf(match)
      if (entry && !entry.includes('node_modules')) found.add(entry.slice(0, 160))
      if (found.size >= 20) return [...found]
    }
  }
  return [...found]
}

export const testsPlugin: HarnessPlugin = {
  manifest: {
    id: 'tests',
    name: 'Tests',
    description:
      'Detects the test framework (vitest, jest, pytest, go, cargo, gradle, swift) and runs it with a structured verdict: pass or fail, and the failing file:lines first.',
    permissions: { workspace: { read: true, write: false }, shell: true },
  },
  plugin: {
    name: 'tests',
    inject: ['tools', 'commands', 'context', 'shell', 'fs', 'workspace'],
    apply(ctx: HarnessContext) {
      // The most recent verdict, for the "Last test run" chip. In-memory on
      // purpose: a report that survives a host restart would describe a tree
      // that may no longer exist.
      /* Per conversation: the kernel is one instance for the whole
         application, so a single `lastRun` meant the "Last test run" chip
         served one conversation's report to another that had run nothing. */
      const sessions = new PerSession<{ last: { readonly report: string; readonly at: number } | null }>(
        () => ({ last: null }),
      )
      const run = async (scope: ScopeQuery | undefined, filter?: string): Promise<string> => {
        const framework = await detectFramework(
          (path) => ctx.fs.exists(path),
          (path) => ctx.fs.read(path),
        )
        if (!framework) {
          return 'No test framework was detected in this workspace (looked for vitest/jest, pytest, go, cargo, gradle, swift).'
        }
        const args = [...framework.args, ...(filter && framework.filter ? framework.filter(filter) : [])]
        const result = await ctx.shell.run(framework.command, args, { timeoutMs: 300_000 })
        const output = `${result.stdout}\n${result.stderr}`.trim()
        const tail = output.split('\n').slice(-30).join('\n')
        let report: string
        if (result.exitCode === 0) {
          report = `PASS — ${framework.name} exited 0.\n\n${tail}`
        } else {
          const failures = extractFailures(output)
          report = [
            `FAIL — ${framework.name} exited ${result.exitCode}.`,
            failures.length > 0 ? `\nFailing locations:\n${failures.map((f) => `  ${f}`).join('\n')}` : '',
            `\nOutput tail:\n${tail}`,
          ].join('\n')
        }
        sessions.get(scope).last = { report, at: Date.now() }
        return report
      }

      ctx.tools.register({
        name: 'run_tests',
        description:
          'Run the workspace test suite with the detected framework. Optional filter narrows to matching tests. The answer leads with PASS/FAIL and failing file:lines.',
        inputSchema: {
          type: 'object',
          properties: {
            filter: { type: 'string', description: 'Only tests matching this pattern.' },
          },
        },
        execute: (args: { filter?: string }, scope: ScopeQuery) =>
          run(scope, args.filter ? String(args.filter) : undefined),
      })

      // "Failures in, fix out": the chip carries the verdict the suite
      // already produced, and never re-runs it — a suite can take minutes,
      // and a send should not.
      ctx.context.register({
        label: 'Last test run',
        form: 'resource',
        chip: { description: 'The most recent verdict and its failing file:lines.' },
        resolve: (scope: ScopeQuery) => {
          const lastRun = sessions.get(scope).last
          if (!lastRun) {
            throw new Error('No test run recorded yet — run /test or the run_tests tool first.')
          }
          const minutes = Math.round((Date.now() - lastRun.at) / 60_000)
          const when = minutes <= 1 ? 'just now' : `${minutes} minutes ago`
          return `Test run from ${when}:\n${lastRun.report}`
        },
      })

      ctx.commands.register({
        name: 'test',
        description: 'Run the workspace test suite',
        argumentHint: '[filter]',
        run: async (argument: string, scope: ScopeQuery) => {
          const report = await run(scope, argument.trim() || undefined)
          // A command has no return channel; a failure thrown here surfaces
          // to the user as `/test failed: …` with the verdict up front.
          if (!report.startsWith('PASS')) throw new Error(report.split('\n').slice(0, 8).join('\n'))
          ctx.harness.log('info', report.split('\n')[0] ?? 'PASS')
        },
      })
    },
  },
}
