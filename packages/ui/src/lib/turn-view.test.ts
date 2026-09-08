import { describe, expect, test } from 'vitest'

import { turnId, type AgentItem, type Turn } from '@harnessdesk/protocol'

import {
  activityLabel,
  describeTurnWork,
  elapsedOf,
  formatElapsed,
  liveActivity,
  splitTurn,
  totalsByFile,
} from './turn-view'
import { describeGroup } from './group-items'

const item = (type: AgentItem['type'], id: string, extra: Record<string, unknown> = {}): AgentItem =>
  ({ id, type, text: 't', content: [], summary: [], command: 'ls', cwd: '/', origin: 'agent', actions: [], changes: [], tool: 'x', source: { kind: 'builtin' }, args: {}, query: 'q', ...extra }) as unknown as AgentItem

const turn = (items: AgentItem[], extra: Partial<Turn> = {}): Turn => ({ id: turnId('t'), items, status: 'completed', ...extra })

describe('splitTurn', () => {
  test('prompt, then the work, then the final answer', () => {
    const view = splitTurn(
      turn([
        item('userMessage', 'u'),
        item('reasoning', 'r'),
        item('assistantMessage', 'n', { phase: 'commentary' }),
        item('command', 'c'),
        item('fileChange', 'f', { changes: [{ path: '/p/a.txt', kind: { type: 'add' }, diff: 'x\ny\n' }] }),
        item('assistantMessage', 'a', { phase: 'final' }),
        item('error', 'e'),
      ]),
    )
    expect(view.prompt.map((entry) => entry.id)).toEqual(['u'])
    expect(view.work.map((entry) => entry.id)).toEqual(['r', 'n', 'c', 'f'])
    expect(view.answer.map((entry) => entry.id)).toEqual(['a'])
    expect(view.trailing.map((entry) => entry.id)).toEqual(['e'])
    expect(view.changes).toHaveLength(1)
  })

  test('a message without a phase is an answer, so runtimes that do not narrate still answer', () => {
    const view = splitTurn(turn([item('userMessage', 'u'), item('assistantMessage', 'a')]))
    expect(view.work).toEqual([])
    expect(view.answer.map((entry) => entry.id)).toEqual(['a'])
  })

  test('a notice opens its turn, so a turn that is only a notice still shows one', () => {
    const view = splitTurn(turn([item('notice', 'n', { text: 'Set model to Opus 5' })]))
    expect(view.prompt.map((entry) => entry.id)).toEqual(['n'])
    expect(view.work).toEqual([])
  })

  test('a notice before the answer it drew out stands above the work fold', () => {
    const view = splitTurn(turn([item('notice', 'n'), item('command', 'c'), item('assistantMessage', 'a')]))
    expect(view.prompt.map((entry) => entry.id)).toEqual(['n'])
    expect(view.work.map((entry) => entry.id)).toEqual(['c'])
    expect(view.answer.map((entry) => entry.id)).toEqual(['a'])
  })

  test('a user message after work began is not the prompt', () => {
    const view = splitTurn(turn([item('userMessage', 'u'), item('command', 'c'), item('userMessage', 'steer')]))
    expect(view.prompt.map((entry) => entry.id)).toEqual(['u'])
    expect(view.work.map((entry) => entry.id)).toEqual(['c', 'steer'])
  })
})

describe('totalsByFile', () => {
  test('adds up per path, counting whole files for adds and deletes', () => {
    const totals = totalsByFile([
      { path: '/p/index.html', kind: { type: 'add' }, diff: 'a\nb\nc\n' },
      { path: '/p/index.html', kind: { type: 'update' }, diff: '@@ -1,2 +1,3 @@\n a\n+z\n b\n' },
      { path: '/p/old.txt', kind: { type: 'delete' }, diff: 'one\ntwo\n' },
    ])
    expect(totals).toEqual([
      { path: '/p/index.html', kind: 'update', added: 4, removed: 0 },
      { path: '/p/old.txt', kind: 'delete', added: 0, removed: 2 },
    ])
  })

  test('a file created and deleted in the same turn is not listed', () => {
    const totals = totalsByFile([
      { path: '/p/scratch.cjs', kind: { type: 'add' }, diff: 'x\n' },
      { path: '/p/scratch.cjs', kind: { type: 'delete' }, diff: 'x\n' },
      { path: '/p/kept.txt', kind: { type: 'add' }, diff: 'y\n' },
    ])
    expect(totals.map((file) => file.path)).toEqual(['/p/kept.txt'])
  })
})

describe('live activity', () => {
  test('names the step in progress, else the thought being had', () => {
    expect(liveActivity([item('command', 'c', { status: 'inProgress', actions: [{ type: 'read', command: 'cat', name: 'SKILL.md', path: '/x' }] })])).toBe(
      'Reading SKILL.md',
    )
    expect(liveActivity([item('command', 'c', { status: 'completed' }), item('reasoning', 'r')])).toBe('Thinking')
    expect(liveActivity([item('reasoning', 'r', { summary: ['Planning the board'] })])).toBe('Planning the board')
    expect(liveActivity([item('command', 'c', { status: 'completed' })])).toBeNull()
    expect(activityLabel(item('command', 'c', { command: "/bin/zsh -lc 'npm test'" }))).toBe('Running npm test')
    expect(activityLabel(item('toolCall', 't', { tool: 'browser_click' }))).toBe('browser_click')
  })
})

describe('elapsed', () => {
  test('formats like a person says it', () => {
    expect(formatElapsed(39_000)).toBe('39s')
    expect(formatElapsed(74_000)).toBe('1m 14s')
    expect(formatElapsed(822_000)).toBe('13m 42s')
    expect(formatElapsed(3_780_000)).toBe('1h 3m')
  })

  test('measures a running turn from its start, and trusts the runtime once done', () => {
    const started = Date.UTC(2026, 7, 24, 5, 0, 0)
    expect(elapsedOf(turn([], { status: 'inProgress', startedAt: started }), started + 12_000)).toBe(12_000)
    expect(
      elapsedOf(
        turn([], { status: 'completed', startedAt: started, completedAt: started + 4000, durationMs: 3900 }),
        started + 99_000,
      ),
    ).toBe(3900)
    expect(
      elapsedOf(turn([], { status: 'completed', startedAt: started, completedAt: started + 4000 }), started + 99_000),
    ).toBe(4000)
    expect(elapsedOf(turn([], { status: 'completed' }), started)).toBeNull()
  })

  test('a stamp that is not a clock reading buys no duration', () => {
    const now = Date.UTC(2026, 7, 24, 5, 0, 0)
    // A fixture's sentinel: "Working for 496541h 26m" was this, times a thousand.
    expect(elapsedOf(turn([], { status: 'inProgress', startedAt: 1 }), now)).toBeNull()
    // Seconds where milliseconds were expected — the same 56 years, from a real runtime.
    expect(elapsedOf(turn([], { status: 'inProgress', startedAt: Math.floor(now / 1000) }), now)).toBeNull()
    // Milliseconds multiplied a second time land in the year 58000.
    expect(elapsedOf(turn([], { status: 'inProgress', startedAt: now * 1000 }), now)).toBeNull()
    // A completed turn whose end is nonsense still measures from a good start.
    expect(elapsedOf(turn([], { status: 'completed', startedAt: now - 5000, completedAt: 6 }), now)).toBe(5000)
  })
})

describe('describeTurnWork', () => {
  const started = Date.UTC(2026, 7, 24, 5, 0, 0)
  const done = (items: AgentItem[], extra: Partial<Turn> = {}): Turn =>
    turn(items, { status: 'completed', startedAt: started, durationMs: 25_000, ...extra })

  test('a folded turn keeps what it did, not only how long it took', () => {
    const work = [
      item('command', 'r1', { actions: [{ type: 'read', command: 'sed', name: 'a.ts', path: '/p/a.ts' }] }),
      item('command', 'r2', { actions: [{ type: 'read', command: 'sed', name: 'b.ts', path: '/p/b.ts' }] }),
      item('command', 'c1', { actions: [{ type: 'unknown', command: 'pnpm test' }] }),
      item('fileChange', 'f', { changes: [{ path: '/p/a.ts', kind: { type: 'update' }, diff: '' }] }),
    ]
    const described = describeTurnWork(done(work), work, started)
    expect(described.head).toBe('Worked for 25s')
    expect(described.receipt).toBe('edited 1 file, ran 1 command, read 2 files')
    expect(described.trouble).toBe(false)
  })

  test('a read dressed as a shell command is a read, not a command', () => {
    const work = [
      item('command', 'a', { actions: [{ type: 'read', command: 'sed', name: 'a', path: '/a' }] }),
      item('command', 'b', { actions: [{ type: 'search', command: 'rg', query: 'x' }] }),
      item('command', 'c', { actions: [{ type: 'listFiles', command: 'ls' }] }),
    ]
    expect(describeTurnWork(done(work), work, started).receipt).toBe('ran 1 command, read 1 file, searched 1 time')
  })

  /* Three of the four agents HarnessDesk ships speak ACP, which flattens
     every step to `toolCall`. Counting by item type alone, the folded line
     said "called 47 tools" over a body that said "ran 44 commands, read 3
     files" — the header contradicting the thing it heads.
     No `description` on the fixture: a call that carries one is *described*
     now — the sentence the agent wrote stands in the receipt rather than
     being tallied — which is its own, separately pinned path just above and
     below this test. This one is about the templated remainder, so it stays
     templated. */
  test("an ACP turn's fold line says what its own body says", () => {
    const bash = (id: string, command: string) =>
      item('toolCall', id, { tool: `\`${command}\``, args: { command } })
    const work = [
      bash('b1', 'pnpm test'),
      bash('b2', 'git status'),
      item('toolCall', 'r', { tool: 'Read src/a.ts', args: { file_path: '/p/a.ts' } }),
      item('toolCall', 'g', { tool: 'Grep for x', args: { pattern: 'x' } }),
      item('toolCall', 'e', { tool: 'Edit src/b.ts', args: { file_path: '/p/b.ts', old_string: 'a', content: 'b' } }),
      item('toolCall', 't', { tool: 'mcp__chrome__navigate', args: { url: 'https://x' } }),
    ]
    const described = describeTurnWork(done(work), work, started)
    expect(described.receipt).toBe('edited 1 file, ran 2 commands, read 1 file, searched 1 time, called 1 tool')
    /* The body of that same turn. It orders by weight rather than by kind, so
       what is pinned is the agreement: every phrase the fold line uses is a
       phrase the body uses, and neither calls a command a tool. */
    const body = describeGroup(work).toLowerCase()
    for (const phrase of described.receipt.split(', ')) expect(body).toContain(phrase)
  })

  /* Reviewed by Opus 5, GPT-5.6 Sol and Gemini 3.8 Flash, who all found the
     same thing: the fix above made the receipt count files by path and left
     the group header counting calls, so the two disagreed in both directions
     at once — the exact defect this branch exists to remove, reintroduced one
     function away from where it was removed. */
  test('the fold line and its body count files the same way, both directions', () => {
    const twice = [
      item('toolCall', 'e1', { tool: 'Edit a.ts', args: { file_path: '/p/a.ts', old_string: 'a', content: 'b' } }),
      item('toolCall', 'e2', { tool: 'Edit a.ts', args: { file_path: '/p/a.ts', old_string: 'b', content: 'c' } }),
    ]
    expect(describeTurnWork(done(twice), twice, started).receipt).toBe('edited 1 file')
    expect(describeGroup(twice)).toBe('Edited 1 file')

    const three = [
      item('fileChange', 'f', { changes: [
        { path: '/p/a.ts', kind: { type: 'update' }, diff: '' },
        { path: '/p/b.ts', kind: { type: 'update' }, diff: '' },
        { path: '/p/c.ts', kind: { type: 'update' }, diff: '' },
      ] }),
    ]
    expect(describeTurnWork(done(three), three, started).receipt).toBe('edited 3 files')
    expect(describeGroup(three)).toBe('Edited 3 files')
  })

  test('a step still running is not yet something the turn did', () => {
    // `runsOf` in turn-summary.ts has always skipped one. Counting it here
    // put "ran 1 command" over a summary row that had nothing to show.
    const running = item('toolCall', 'p', { tool: '`sleep 9`', args: { command: 'sleep 9' }, status: 'inProgress' })
    expect(describeTurnWork(done([running], { status: 'interrupted' }), [running], started).receipt).toBe(
      'nothing was written',
    )
  })

  test('a command that exits non-zero is trouble, whatever its status says', () => {
    // summariseTurn counts this as a failure; the fold line above it used to
    // stay untinted and fold a turn whose tests had just gone red.
    const work = [item('command', 'c', { command: 'pnpm test', status: 'completed', exitCode: 1, actions: [] })]
    const line = describeTurnWork(done(work), work, started)
    expect(line.trouble).toBe(true)
    expect(line.receipt).toContain('1 step failed')
  })

  test('the same file edited twice is one file', () => {
    const work = [
      item('fileChange', 'f1', { changes: [{ path: '/p/a.ts', kind: { type: 'update' }, diff: '' }] }),
      item('fileChange', 'f2', { changes: [{ path: '/p/a.ts', kind: { type: 'update' }, diff: '' }] }),
      item('fileChange', 'f3', { changes: [{ path: '/p/b.ts', kind: { type: 'update' }, diff: '' }] }),
    ]
    expect(describeTurnWork(done(work), work, started).receipt).toBe('edited 2 files')
  })

  test('a declined or failed step tints the line and holds the work open', () => {
    const work = [
      item('command', 'a', { status: 'declined', actions: [{ type: 'unknown', command: 'curl' }] }),
      item('toolCall', 'b', { status: 'completed', error: 'no network' }),
    ]
    const line = describeTurnWork(done(work), work, started)
    expect(line.trouble).toBe(true)
    expect(line.receipt).toBe('ran 1 command, called 1 tool, 1 step declined, 1 step failed')
  })

  test('a failed turn is trouble even when every step it took went fine', () => {
    const work = [item('command', 'a', { status: 'completed', actions: [{ type: 'unknown', command: 'ls' }] })]
    expect(describeTurnWork(done(work, { status: 'failed' }), work, started).trouble).toBe(true)
  })

  test('an interrupted turn says so, and says whether anything was written', () => {
    const bare = describeTurnWork(done([], { status: 'interrupted', durationMs: 12_000 }), [], started)
    expect(bare.head).toBe('Stopped after 12s')
    expect(bare.receipt).toBe('nothing was written')

    const work = [item('fileChange', 'f', { changes: [{ path: '/p/a.ts', kind: { type: 'update' }, diff: '' }] })]
    const wrote = describeTurnWork(done(work, { status: 'interrupted', durationMs: 12_000 }), work, started)
    expect(wrote.receipt).toBe('edited 1 file')
  })

  test('a turn of described steps reads back as the sentences, and stands rather than folds', () => {
    // Claude Code's shell calls carry the sentence the agent wrote for them,
    // and for a research turn those sentences are the record. Codex folds a
    // two-minute turn to a duration and a count; this line keeps the words,
    // and the flag says the rows stay on screen.
    const shell = (id: string, description: string): AgentItem =>
      item('toolCall', id, { tool: 'Bash', args: { command: 'x', description } })
    const work = [
      shell('a', 'Read the limiter and its refill arithmetic'),
      item('toolCall', 'r1', { tool: 'Read', args: { file_path: '/p/a.ts' } }),
      item('toolCall', 'r2', { tool: 'Read', args: { file_path: '/p/b.ts' } }),
      shell('b', 'Measure the refill rate over one millisecond'),
    ]
    const line = describeTurnWork(done(work), work, started)
    expect(line.informative).toBe(true)
    expect(line.receipt).toBe(
      'Read the limiter and its refill arithmetic · Measure the refill rate over one millisecond · read 2 files',
    )
  })

  test('a turn of templated steps is not informative, and its tool calls count by what they did', () => {
    // ACP flattens every step to a tool call; "called 5 tools" is a shrug
    // where the arguments already say three were commands and two were reads.
    const work = [
      item('toolCall', 'c1', { tool: 'shell', args: { command: 'ls' } }),
      item('toolCall', 'c2', { tool: 'shell', args: { command: 'pwd' } }),
      item('toolCall', 'r1', { tool: 'Read', args: { file_path: '/p/a.ts' } }),
      item('toolCall', 'e1', { tool: '/p/a.ts', args: { file_path: '/p/a.ts', old_string: 'x', new_string: 'y' } }),
      item('toolCall', 'g1', { tool: 'grep', args: { pattern: 'foo' } }),
    ]
    const line = describeTurnWork(done(work), work, started)
    expect(line.informative).toBe(false)
    expect(line.receipt).toBe('edited 1 file, ran 2 commands, read 1 file, searched 1 time')
  })

  test('a running turn counts nothing: the live line already says what is happening', () => {
    const work = [item('command', 'a', { status: 'inProgress', actions: [{ type: 'unknown', command: 'ls' }] })]
    const line = describeTurnWork(turn(work, { status: 'inProgress', startedAt: started }), work, started + 18_000)
    expect(line.head).toBe('Working for 18s')
    expect(line.receipt).toBe('')
    expect(line.trouble).toBe(false)
  })
})
