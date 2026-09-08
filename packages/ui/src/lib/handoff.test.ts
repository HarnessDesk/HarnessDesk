import { describe, expect, it } from 'vitest'

import type { Session } from '@harnessdesk/protocol'

import { splitContext } from './context-envelope'
import { buildHandoff, lineageLine } from './handoff'

const session = (overrides: Partial<Session> = {}): Session =>
  ({
    id: 's1',
    runtime: 'claude-code',
    title: 'Build the pong game',
    cwd: '/Users/a/code/pong',
    status: 'idle',
    createdAt: 1,
    updatedAt: 2,
    git: { branch: 'main', sha: '85c477440d85efd6b2005d6827a8dfeee36af890', originUrl: 'x' },
    itemsLoaded: true,
    turns: [
      {
        id: 't1',
        status: 'completed',
        items: [
          { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Build pong in index.html' }] },
          {
            id: 'c1',
            type: 'toolCall',
            tool: 'TodoWrite',
            source: { kind: 'builtin' },
            status: 'completed',
            args: { todos: [{ content: 'Write the canvas', status: 'completed' }, { content: 'Add scoring', status: 'pending' }] },
          },
          {
            id: 'f1',
            type: 'fileChange',
            status: 'completed',
            changes: [{ path: 'index.html', kind: { type: 'add' }, diff: '+<html>\n+<canvas>' }],
          },
          { id: 'a1', type: 'assistantMessage', phase: 'commentary', text: 'Working on it.' },
          { id: 'a2', type: 'assistantMessage', phase: 'final', text: 'Pong is playable. Scoring is next.' },
        ],
      },
    ],
    ...overrides,
  }) as unknown as Session

const source = { agentName: 'Claude Code', session: session() }

describe('buildHandoff', () => {
  it('carries the goal, the state, the files, the open plan and the commit in a summary', () => {
    const packet = buildHandoff(source, 'summary')!
    expect(packet).toContain('<context source="Handed off from Claude Code — “Build the pong game”">')
    expect(packet).toContain('## Goal\nBuild pong in index.html')
    expect(packet).toContain('Claude Code answered: Pong is playable. Scoring is next.')
    expect(packet).not.toContain('Working on it.')
    expect(packet).toContain('- `index.html` — add (+2 −0)')
    expect(packet).toContain('- [x] Write the canvas')
    expect(packet).toContain('- [ ] Add scoring')
    expect(packet).toContain('Branch `main` at `85c477440d`')
  })

  it('carries the plan the sidebar is showing — the latest, not the first', () => {
    // The packet and the Tasks panel read the same function, so what the next
    // agent is told is still open is what the person handing over saw. A
    // conversation that replanned must hand over the replan.
    const replanned = session({
      turns: [
        {
          id: 't1',
          status: 'completed',
          items: [
            { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Build pong' }] },
            {
              id: 'c1',
              type: 'toolCall',
              tool: 'TodoWrite',
              source: { kind: 'builtin' },
              status: 'completed',
              args: { todos: [{ content: 'the abandoned plan', status: 'pending' }] },
            },
            {
              id: 'c2',
              type: 'toolCall',
              tool: 'CreatePlan',
              source: { kind: 'builtin' },
              status: 'completed',
              args: {
                plan: [
                  { title: 'draw the canvas', status: 'completed' },
                  { title: 'add scoring', status: 'pending' },
                ],
              },
            },
          ],
        },
      ],
    } as unknown as Partial<Session>)
    const packet = buildHandoff({ agentName: 'Cursor', session: replanned }, 'summary')!
    expect(packet).toContain('- [x] draw the canvas')
    expect(packet).toContain('- [ ] add scoring')
    expect(packet).not.toContain('the abandoned plan')
  })

  it('carries the person’s wording for a task they reworded', () => {
    // The panel's rule is that what the next agent is told is still open is
    // what the person was looking at — and an edit is exactly the part of that
    // the transcript cannot say. The receiving agent never heard the old
    // phrasing, so there is nothing for it to reconcile.
    const packet = buildHandoff(
      {
        agentName: 'Claude Code',
        session: session(),
        planEdits: [{ from: 'Add scoring', to: 'Add scoring, both players' }],
      },
      'summary',
    )!
    expect(packet).toContain('- [ ] Add scoring, both players')
    expect(packet).not.toContain('- [ ] Add scoring\n')
    // The task nobody touched is still the agent's own wording.
    expect(packet).toContain('- [x] Write the canvas')
  })

  it('writes every exchange in transcript mode and no narration', () => {
    const packet = buildHandoff(source, 'transcript')!
    expect(packet).toContain('## Conversation')
    expect(packet).toContain('**User:** Build pong in index.html')
    expect(packet).toContain('**Claude Code:** Pong is playable.')
    expect(packet).not.toContain('Where it stands')
  })

  it('keeps only goal, files and ground truth in files mode', () => {
    const packet = buildHandoff(source, 'files')!
    expect(packet).toContain('## Goal')
    expect(packet).toContain('## Files changed')
    expect(packet).not.toContain('## Open plan')
    expect(packet).not.toContain('Where it stands')
  })

  it('reads an ACP agent\'s Write and Edit tool calls as file changes, relative to the folder', () => {
    const acp = session({
      turns: [
        {
          id: 't1',
          status: 'completed',
          items: [
            { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Make it' }] },
            {
              id: 'w1',
              type: 'toolCall',
              tool: 'Write /Users/a/code/pong/tictactoe.html',
              source: { kind: 'builtin' },
              status: 'completed',
              args: { file_path: '/Users/a/code/pong/tictactoe.html', content: '<html>\n<body>\n</body>\n</html>' },
            },
            {
              id: 'e1',
              type: 'toolCall',
              tool: 'Edit',
              source: { kind: 'builtin' },
              status: 'completed',
              args: { file_path: '/Users/a/code/pong/index.html', old_string: 'a\nb', new_string: 'c' },
            },
            { id: 'r1', type: 'toolCall', tool: 'Read', source: { kind: 'builtin' }, status: 'completed', args: { file_path: '/x' } },
          ],
        },
      ],
    } as unknown as Partial<Session>)
    const packet = buildHandoff({ agentName: 'Claude Code', session: acp }, 'files')!
    expect(packet).toContain('- `tictactoe.html` — add (+4 −0)')
    expect(packet).toContain('- `index.html` — update (+1 −2)')
    expect(packet).not.toContain('`/x`')
  })

  it('reads a Cursor edit, whose new text is a stream rather than a content field', () => {
    const cursor = session({
      turns: [
        {
          id: 't1',
          status: 'completed',
          items: [
            { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Write the notes' }] },
            {
              id: 'e1',
              type: 'toolCall',
              tool: 'Edit notes.md',
              source: { kind: 'builtin' },
              status: 'completed',
              args: { path: '/Users/a/code/pong/notes.md', streamContent: 'one\ntwo' },
            },
          ],
        },
      ],
    } as unknown as Partial<Session>)
    expect(buildHandoff({ agentName: 'Cursor Agent', session: cursor }, 'files')).toContain(
      '- `notes.md` — add (+2 −0)',
    )
  })

  it('says how much of a long conversation the summary left out', () => {
    const many = session({
      turns: [
        {
          id: 't1',
          status: 'completed',
          items: Array.from({ length: 10 }, (_, index) => [
            { id: `u${index}`, type: 'userMessage', content: [{ type: 'text', text: `ask ${index}` }] },
            { id: `a${index}`, type: 'assistantMessage', phase: 'final', text: `answer ${index}` },
          ]).flat(),
        },
      ],
    } as unknown as Partial<Session>)
    const packet = buildHandoff({ agentName: 'Claude Code', session: many }, 'summary')!
    expect(packet).toContain('13 earlier exchanges are not included')
    expect(packet).toContain('ask 0') // the goal survives
    expect(packet).toContain('answer 9')
    expect(packet).not.toContain('ask 3')
  })

  it('keeps the tail of a transcript too heavy to carry whole, and says what fell off', () => {
    const heavy = session({
      turns: [
        {
          id: 't1',
          status: 'completed',
          items: Array.from({ length: 8 }, (_, index) => [
            { id: `u${index}`, type: 'userMessage', content: [{ type: 'text', text: `ask ${index} ${'x'.repeat(30_000)}` }] },
            { id: `a${index}`, type: 'assistantMessage', phase: 'final', text: `answer ${index}` },
          ]).flat(),
        },
      ],
    } as unknown as Partial<Session>)
    const packet = buildHandoff({ agentName: 'Claude Code', session: heavy }, 'transcript')!
    expect(packet.length).toBeLessThan(160_000)
    expect(packet).toContain('answer 7')
    expect(packet).not.toContain('ask 1 ')
    expect(packet).toMatch(/The first \d+ exchanges did not fit/)
    // The goal is its own section, so it survives however heavy the middle is.
    expect(packet).toContain('## Goal\nask 0')
  })

  it('answers "files changed only" with a sentence when nothing was changed', () => {
    const chat = session({
      turns: [
        {
          id: 't1',
          status: 'completed',
          items: [
            { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'What does splitTurn do?' }] },
            { id: 'a1', type: 'assistantMessage', phase: 'final', text: 'It separates the answer from the work.' },
          ],
        },
      ],
    } as unknown as Partial<Session>)
    const packet = buildHandoff({ agentName: 'Claude Code', session: chat }, 'files')!
    expect(packet).toContain('No files were changed in this conversation.')
    const summary = buildHandoff({ agentName: 'Claude Code', session: chat }, 'summary')!
    expect(summary).not.toContain('No files were changed')
  })

  it('counts changed files past the cap instead of listing them all', () => {
    const wide = session({
      turns: [
        {
          id: 't1',
          status: 'completed',
          items: [
            { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Rename everything' }] },
            {
              id: 'f1',
              type: 'fileChange',
              status: 'completed',
              changes: Array.from({ length: 230 }, (_, index) => ({
                path: `src/file-${index}.ts`,
                kind: { type: 'update' },
                diff: '+a\n-b',
              })),
            },
          ],
        },
      ],
    } as unknown as Partial<Session>)
    const packet = buildHandoff({ agentName: 'Codex', session: wide }, 'files')!
    expect(packet).toContain('`src/file-199.ts`')
    expect(packet).not.toContain('`src/file-200.ts`')
    expect(packet).toContain('…and 30 more; `git status` in the working folder has the full list.')
  })

  it('survives an answer that quotes the context envelope itself', () => {
    const meta = session({
      turns: [
        {
          id: 't1',
          status: 'completed',
          items: [
            { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'How does the desk mark injected context?' }] },
            {
              id: 'a1',
              type: 'assistantMessage',
              phase: 'final',
              text: 'It wraps it like this:\n<context source="Git">\non branch main\n</context>\nand strips it on render.',
            },
          ],
        },
      ],
    } as unknown as Partial<Session>)
    const packet = buildHandoff({ agentName: 'Claude Code', session: meta }, 'transcript')!
    // One envelope: the packet's own. The quoted close inside is escaped, so
    // the target renderer reads the whole packet as the hand-off, and the
    // quoted text comes back verbatim when it is split.
    const { injections, text } = splitContext(packet)
    expect(injections).toHaveLength(1)
    expect(injections[0]?.label).toContain('Handed off from Claude Code')
    expect(injections[0]?.text).toContain('<context source="Git">\non branch main\n</context>')
    expect(text).toBe('')
  })

  it('still points at the folder when the agent reports no git at all', () => {
    const noGit = session({ git: null })
    const packet = buildHandoff({ agentName: 'DeepSeek Harness', session: noGit }, 'summary')!
    expect(packet).toContain('Run `git status` and `git diff` there')
    expect(packet).not.toContain('when handed off')
  })

  it('quotes what the user typed, not the context the desk injected around it', () => {
    const withContext = session({
      turns: [
        {
          id: 't1',
          status: 'completed',
          items: [
            {
              id: 'u1',
              type: 'userMessage',
              content: [
                {
                  type: 'text',
                  text: '<context source="Git">\nThe workspace is on git branch `main`.\n</context>\nBuild pong',
                },
              ],
            },
          ],
        },
      ],
    } as unknown as Partial<Session>)
    const packet = buildHandoff({ agentName: 'Claude Code', session: withContext }, 'summary')!
    expect(packet).toContain('## Goal\nBuild pong')
    expect(packet).not.toContain('<context source="Git">')
  })

  it('a chain of hand-offs keeps the original goal, not the last instruction', () => {
    const chained = session({
      title: null,
      preview: 'Take it from here.',
      turns: [
        {
          id: 't1',
          status: 'completed',
          items: [
            {
              id: 'u1',
              type: 'userMessage',
              content: [
                {
                  type: 'text',
                  text: '<context source="Handed off from Codex — “Build the pong game”">\n## Goal\nBuild pong in index.html\n\n## Ground truth\nWorking folder: `/Users/a/code/pong`\n</context>\nTake it from here.',
                },
              ],
            },
            { id: 'a1', type: 'assistantMessage', phase: 'final', text: 'Pong now has scoring.' },
          ],
        },
      ],
    } as unknown as Partial<Session>)
    const packet = buildHandoff({ agentName: 'Claude Code', session: chained }, 'summary')!
    expect(packet).toContain('## Goal\nBuild pong in index.html')
    // The hop's own instruction still shows as part of the flow, once.
    expect(packet).toContain('Asked: Take it from here.')
    expect(packet).not.toContain('## Goal\nTake it from here.')
  })

  it('has nothing to hand off from an empty conversation', () => {
    expect(buildHandoff({ agentName: 'X', session: session({ turns: [] }) }, 'summary')).toBeNull()
  })

  it('names the lineage from the title, falling back to the preview', () => {
    expect(lineageLine(source)).toBe('Handed off from Claude Code — “Build the pong game”')
    expect(lineageLine({ agentName: 'X', session: session({ title: null, preview: 'hi there' }) })).toContain('“hi there”')
  })
})
