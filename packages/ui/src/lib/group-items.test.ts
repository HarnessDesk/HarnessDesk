import { describe, expect, test } from 'vitest'

import type { AgentItem } from '@harnessdesk/protocol'

import {
  condenseItems,
  describedTitle,
  describeGroup,
  editedPathOf,
  groupItems,
  isDescribed,
  isSilentReasoning,
  reasoningHeadline,
  shellCommandOf,
  toolCallVerb,
} from './group-items'

const item = (type: AgentItem['type'], id: string, status?: string): AgentItem =>
  ({ id, type, status, command: 'x', cwd: '/', origin: 'agent', actions: [], text: '', changes: [], tool: 't', source: { kind: 'builtin' }, args: {}, query: 'q', summary: [], content: [], path: '/x', action: 'spawn', members: [] }) as unknown as AgentItem

describe('groupItems', () => {
  test('prose is never grouped', () => {
    const nodes = groupItems([
      item('assistantMessage', 'a'),
      item('assistantMessage', 'b'),
      item('assistantMessage', 'c'),
      item('assistantMessage', 'd'),
    ])
    expect(nodes).toHaveLength(4)
    expect(nodes.every((node) => node.kind === 'item')).toBe(true)
  })

  test('a burst of steps collapses into one node', () => {
    const nodes = groupItems([
      item('assistantMessage', 'a'),
      item('command', 'c1'),
      item('command', 'c2'),
      item('toolCall', 't1'),
      item('assistantMessage', 'b'),
    ])
    expect(nodes.map((node) => node.kind)).toEqual(['item', 'group', 'item'])
    expect(nodes[1]?.kind === 'group' && nodes[1].items).toHaveLength(3)
  })

  test('a short run stays flat, because a group would cost more than it saves', () => {
    const nodes = groupItems([item('command', 'c1'), item('command', 'c2')])
    expect(nodes.map((node) => node.kind)).toEqual(['item', 'item'])
  })

  test('prose splits two bursts into separate groups', () => {
    const nodes = groupItems([
      item('command', 'c1'),
      item('command', 'c2'),
      item('command', 'c3'),
      item('assistantMessage', 'a'),
      item('command', 'c4'),
      item('command', 'c5'),
      item('command', 'c6'),
    ])
    expect(nodes.map((node) => node.kind)).toEqual(['group', 'item', 'group'])
  })

  test('a group with a running member is marked running', () => {
    const nodes = groupItems([
      item('command', 'c1', 'completed'),
      item('command', 'c2', 'inProgress'),
      item('command', 'c3', 'completed'),
    ])
    expect(nodes[0]?.kind === 'group' && nodes[0].running).toBe(true)
  })

  test('an empty transcript produces nothing', () => {
    expect(groupItems([])).toEqual([])
  })
})

describe('described steps', () => {
  const described = (id: string, description: string): AgentItem =>
    ({ ...item('toolCall', id), tool: 'Bash', args: { command: 'x', description } }) as AgentItem
  const bare = (id: string): AgentItem =>
    ({ ...item('toolCall', id), tool: 'Read', args: { file_path: '/a' } }) as AgentItem

  test('a step the agent described in its own words is one', () => {
    expect(isDescribed(described('d', 'Find every caller of take'))).toBe(true)
    expect(describedTitle(described('d', '  Find every caller of take '))).toBe('Find every caller of take')
    expect(isDescribed(bare('b'))).toBe(false)
    expect(isDescribed(item('command', 'c'))).toBe(false)
    expect(describedTitle(({ ...item('toolCall', 'e'), args: { description: '   ' } }) as AgentItem)).toBeNull()
  })

  test('never joins a batch: the sentence stands, the templated steps around it fold', () => {
    // Batching is what a transcript does to labels that carry nothing.
    // "Ran a command" seven times is noise; "Find every caller of take" is
    // the record, and a count would hide it.
    const nodes = groupItems([
      described('d1', 'Read the limiter'),
      bare('b1'),
      bare('b2'),
      bare('b3'),
      described('d2', 'Measure the refill rate'),
      bare('b4'),
      bare('b5'),
    ])
    expect(nodes.map((node) => (node.kind === 'group' ? `group:${node.items.length}` : node.item.id))).toEqual([
      'd1',
      'group:3',
      'd2',
      'b4',
      'b5',
    ])
  })

  test('three described steps in a row are three rows, not a group', () => {
    const nodes = groupItems([described('d1', 'One'), described('d2', 'Two'), described('d3', 'Three')])
    expect(nodes.every((node) => node.kind === 'item')).toBe(true)
  })
})

describe('describeGroup', () => {
  test('counts by kind, most frequent first', () => {
    expect(
      describeGroup([item('command', 'c1'), item('command', 'c2'), item('fileChange', 'f1')]),
    ).toBe('Ran 2 commands, edited 1 file')
  })

  test('singulars read correctly', () => {
    expect(describeGroup([item('toolCall', 't1')])).toBe('Called 1 tool')
  })

  test('a tool call is described by what it did, not its wire type', () => {
    const call = (id: string, tool: string, args: Record<string, unknown>): AgentItem =>
      ({ ...item('toolCall', id), tool, args }) as AgentItem
    expect(
      describeGroup([
        call('t1', 'pnpm verify > log', { command: 'pnpm verify > log', description: 'Run the gate' }),
        call('t2', 'Read File /src/a.ts', { file_path: '/src/a.ts' }),
        call('t3', 'Read File /src/b.ts', { file_path: '/src/b.ts' }),
        call('t4', 'grep -rn "foo"', { pattern: 'foo' }),
        call('t5', '/src/a.ts', { file_path: '/src/a.ts', old_string: 'x', new_string: 'y' }),
      ]),
    ).toBe('Read 2 files, ran 1 command, searched 1 time, edited 1 file')
  })
})

/**
 * One reader-facing rule, whichever model is answering.
 *
 * The defect these pin was measured in a live room running the same review
 * past three models on one runtime: Claude's reasoning rows read as sentences
 * and Gemini's rendered as nine consecutive rows titled "Thinking", because
 * Claude fills `summary` and Gemini fills `content`. Nothing about the
 * renderer differed. A reader should not be able to tell which vendor is
 * answering from how much the interface is willing to say.
 */
describe('the title of a reasoning row', () => {
  const reasoning = (fields: { summary?: string[]; content?: string[] }): AgentItem =>
    ({ ...item('reasoning', 'r'), summary: [], content: [], ...fields }) as AgentItem

  test('is the summary when the backend wrote one', () => {
    expect(reasoningHeadline(reasoning({ summary: ['Finding where worktrees are listed'] }))).toBe(
      'Finding where worktrees are listed',
    )
  })

  test('is the first sentence of the thinking when it did not', () => {
    expect(
      reasoningHeadline(
        reasoning({
          content: ['I need to read the diff first. Then I can check each file it touches.'],
        }),
      ),
    ).toBe('I need to read the diff first')
  })

  test("takes a bold lead-in as the title it is, markers off", () => {
    expect(reasoningHeadline(reasoning({ content: ['**Analyzing the diff**\n\nThe change…'] }))).toBe(
      'Analyzing the diff',
    )
  })

  test('strips a heading marker and a code span the same way', () => {
    expect(reasoningHeadline(reasoning({ content: ['## Checking `DockPanel.tsx`'] }))).toBe(
      'Checking DockPanel.tsx',
    )
  })

  test('cuts a long thought on a word boundary', () => {
    const title = reasoningHeadline(
      reasoning({
        content: [
          'The tab close button needs a drag guard because pointer events on the tab strip ' +
            'would otherwise start a window drag before the click lands',
        ],
      }),
    )
    expect(title.length).toBeLessThanOrEqual(73)
    expect(title.endsWith('…')).toBe(true)
    expect(title).not.toMatch(/\s…$/)
  })

  /* Both found by the three-model review of #93: Codex 5.3 pointed at the
     numbered lead-in and the identifier, Opus 4.6 at the identifier too. */
  test('a numbered lead-in is a list marker, not the first sentence', () => {
    expect(
      reasoningHeadline(reasoning({ content: ['1. Check each changed file before commenting.'] })),
    ).toBe('Check each changed file before commenting')
  })

  test('a terminator after a digit does not end the title', () => {
    expect(reasoningHeadline(reasoning({ content: ['Version 1.5 is out. Then upgrade.'] }))).toBe(
      'Version 1.5 is out',
    )
  })

  test('an identifier survives being a title', () => {
    expect(
      reasoningHeadline(reasoning({ content: ['Investigating `run_tests` result formatting'] })),
    ).toBe('Investigating run_tests result formatting')
    expect(reasoningHeadline(reasoning({ content: ['Grepping packages/**/*.css for the token'] }))).toBe(
      'Grepping packages/**/*.css for the token',
    )
  })

  test('an abbreviation is not a sentence end', () => {
    expect(
      reasoningHeadline(reasoning({ content: ['Analyzing e.g. the worktree layout'] })),
    ).toBe('Analyzing e.g. the worktree layout')
    expect(reasoningHeadline(reasoning({ content: ['Checking foo.ts and bar.ts'] }))).toBe(
      'Checking foo.ts and bar.ts',
    )
  })

  test('a question or an exclamation ends a title too', () => {
    expect(reasoningHeadline(reasoning({ content: ['Why is this broken? Let me check.'] }))).toBe(
      'Why is this broken?',
    )
    expect(reasoningHeadline(reasoning({ content: ['Found it! Now the fix.'] }))).toBe('Found it!')
  })

  test('falls back only when there is genuinely nothing to read', () => {
    expect(reasoningHeadline(reasoning({}))).toBe('Thinking')
    expect(reasoningHeadline(reasoning({ summary: ['  '], content: ['\n'] }))).toBe('Thinking')
  })

  /* The whole point, stated as a test: two models, one row vocabulary. */
  test('a Gemini-shaped item and a Claude-shaped one both get a sentence', () => {
    const claude = reasoning({ summary: ['Checking the tests first'] })
    const gemini = reasoning({ content: ['Checking the tests first. They cover the guard.'] })
    expect(reasoningHeadline(gemini)).toBe(reasoningHeadline(claude))
  })
})

describe('silent reasoning', () => {
  const silent = (id: string): AgentItem =>
    ({ ...item('reasoning', id), summary: [], content: [] }) as AgentItem
  const spoken = (id: string): AgentItem =>
    ({ ...item('reasoning', id), summary: ['Checking the tests first'], content: [] }) as AgentItem

  test('is reasoning with nothing to read', () => {
    expect(isSilentReasoning(silent('r'))).toBe(true)
    expect(isSilentReasoning(spoken('r'))).toBe(false)
    expect(isSilentReasoning(item('command', 'c'))).toBe(false)
  })

  test('a run of silent reasoning collapses to one line', () => {
    const kept = condenseItems([silent('r1'), silent('r2'), silent('r3'), item('command', 'c'), silent('r4')])
    expect(kept.map((entry) => entry.id)).toEqual(['r1', 'c', 'r4'])
  })

  test('does not split a burst of steps, and is not counted as one', () => {
    const nodes = groupItems([
      item('command', 'c1'),
      silent('r1'),
      item('command', 'c2'),
      silent('r2'),
      item('command', 'c3'),
    ])
    expect(nodes.map((node) => node.kind)).toEqual(['group'])
    expect(nodes[0]?.kind === 'group' && describeGroup(nodes[0].items)).toBe('Ran 3 commands')
  })

  test('two steps around a silent line are still too few to group', () => {
    const nodes = groupItems([item('command', 'c1'), silent('r1'), item('command', 'c2')])
    expect(nodes.map((node) => node.kind)).toEqual(['item', 'item', 'item'])
  })

  test('thought after a burst stays outside the group', () => {
    const nodes = groupItems([item('command', 'c1'), item('command', 'c2'), item('command', 'c3'), silent('r1')])
    expect(nodes.map((node) => node.kind)).toEqual(['group', 'item'])
    expect(nodes[0]?.kind === 'group' && nodes[0].items).toHaveLength(3)
  })

  test('spoken reasoning still breaks a burst, because it is prose', () => {
    const nodes = groupItems([
      item('command', 'c1'),
      item('command', 'c2'),
      item('command', 'c3'),
      spoken('r1'),
      item('command', 'c4'),
    ])
    expect(nodes.map((node) => node.kind)).toEqual(['group', 'item', 'item'])
  })
})

/**
 * What a tool call was, across the shapes the shipped agents really send.
 *
 * A three-vendor review of PR #51 found this narrow in three separate ways at
 * once: `editedPathOf` knew two of the six edit shapes, the verb regexes used
 * `\b` where the names are `read_file` and `grep_search`, and a shell tool
 * sending argv rather than a line fell through to the generic bucket while
 * `summariseTurn`, reading the same field, counted it as a command.
 */
describe('toolCallVerb across real agent shapes', () => {
  const call = (tool: string, args: Record<string, unknown>): AgentItem =>
    ({ id: 'x', type: 'toolCall', tool, source: { kind: 'builtin' }, status: 'completed', args }) as unknown as AgentItem

  test('an edit is an edit whichever agent wrote it', () => {
    const edits: Record<string, Record<string, unknown>> = {
      'claude Edit': { file_path: '/w/a.ts', old_string: 'a', content: 'b' },
      'cursor Edit': { path: '/w/a.ts', streamContent: 'x' },
      'claude MultiEdit': { file_path: '/w/a.ts', edits: [{ old_string: 'a', new_string: 'b' }] },
      'claude Write': { file_path: '/w/a.ts', content: 'x' },
      'a notebook': { notebook_path: '/w/x.ipynb', new_source: 'x' },
      'a target_file patch': { target_file: '/w/a.ts', code_edit: 'x' },
    }
    for (const [who, args] of Object.entries(edits)) {
      const one = call('Edit a.ts', args)
      expect(toolCallVerb(one as never), who).toBe('fileChange')
      expect(editedPathOf(one as never), who).not.toBeNull()
    }
  })

  test('a verb ends at a separator, not only at a space', () => {
    for (const tool of ['read_file', 'ReadFile', 'Read a.ts', 'read-file']) {
      expect(toolCallVerb(call(tool, { path: '/w/a.ts' }) as never), tool).toBe('read')
    }
    for (const tool of ['grep_search', 'glob_file_search', 'find_files', 'Grep for x']) {
      expect(toolCallVerb(call(tool, {}) as never), tool).toBe('search')
    }
  })

  test('a shell tool that sends argv still ran a command', () => {
    expect(shellCommandOf(call('shell', { command: ['bash', '-lc', 'pnpm test'] }) as never)).toBe('bash -lc pnpm test')
    expect(toolCallVerb(call('shell', { command: ['bash', '-lc', 'pnpm test'] }) as never)).toBe('command')
    // Named like a shell and carrying nothing readable: still a command, which
    // is what `summariseTurn` has always counted it as.
    expect(toolCallVerb(call('bash', {}) as never)).toBe('command')
  })
})
