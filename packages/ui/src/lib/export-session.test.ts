import { Marked } from 'marked'
import { describe, expect, it } from 'vitest'

import type { AgentItem, Session } from '@harnessdesk/protocol'

import { sessionToMarkdown } from './export-session'

/**
 * Exporting a transcript as Markdown.
 *
 * Every value on these lines came off a wire: a tool's name, a command, the
 * reason a call failed. Markdown gives such a value two ways out of the span it
 * was put in — a newline and a backtick — and either takes the rest of the
 * document with it. So the assertions here parse the export with the same
 * parser the app renders Markdown with, rather than trusting that a line that
 * looks right is read the way it looks (#273).
 */
const markdown = new Marked({ gfm: true, breaks: false, async: false })
const html = (source: string): string => markdown.parse(source) as string

const session = (items: readonly AgentItem[]): Session =>
  ({
    id: 's1',
    runtime: 'codex',
    title: 'Open the quarterly report',
    cwd: '/w',
    status: 'idle',
    createdAt: 0,
    updatedAt: 0,
    itemsLoaded: true,
    turns: [{ id: 't1', items, status: 'completed' }],
  }) as unknown as Session

const failedCall = (error: string, tool = 'browser_open'): AgentItem =>
  ({
    id: 'c1',
    type: 'toolCall',
    tool,
    source: { kind: 'dynamic', namespace: 'reports' },
    status: 'failed',
    args: {},
    error,
  }) as unknown as AgentItem

describe('a failed tool call in an export', () => {
  it('puts the reason in a block of its own, not in the rest of the line (#273)', () => {
    // What a hook's refusal looks like since #245: several parts, joined with newlines.
    const reason = 'The hook refused this call.\nEdit `hooks.toml` to allow it.'
    const out = sessionToMarkdown(session([failedCall(reason)]))
    expect(out).toContain('**Tool** `browser_open` — failed:')
    expect(html(out)).toContain(
      '<pre><code>The hook refused this call.\nEdit `hooks.toml` to allow it.\n</code></pre>',
    )
    /* Inlined after the em dash, the second line left the item and was read as
       Markdown of its own, and the lone backticks opened a span that never
       closed. Neither happens to a fenced block. */
    expect(html(out)).not.toMatch(/<p>[^<]*Edit/)
  })

  it('opens a fence longer than any run of backticks in what it wraps (#273)', () => {
    const reason = 'The tool printed:\n```\nnot the end of the transcript\n```\nand then gave up.'
    const out = sessionToMarkdown(session([failedCall(reason)]))
    expect(out).toContain('````\nThe tool printed:')
    const rendered = html(out)
    // One block, with its inner fence still inside it — not a block that closed early.
    expect(rendered.match(/<pre>/g) ?? []).toHaveLength(1)
    expect(rendered).toContain('not the end of the transcript')
    expect(rendered).not.toMatch(/<p>[^<]*and then gave up/)
  })

  it('cannot be made to open a code span that never closes (#273)', () => {
    // A dynamic tool's name comes off the wire too, on the same line.
    const out = sessionToMarkdown(session([failedCall('it broke', 'browser`open')]))
    expect(html(out)).toContain('<code>browser`open</code>')
  })
})

describe('an ordinary transcript', () => {
  /** The control: nothing above changes any of this. */
  it('exports as it always did', () => {
    const out = sessionToMarkdown(
      session([
        { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Open the report.' }] },
        {
          id: 'k1',
          type: 'command',
          command: 'ls -la',
          cwd: '/w',
          origin: 'agent',
          status: 'completed',
          actions: [],
          output: 'README.md\n',
          exitCode: 0,
        },
        { id: 'c2', type: 'toolCall', tool: 'browser_open', source: { kind: 'builtin' }, status: 'completed', args: {} },
      ] as unknown as AgentItem[]),
    )
    expect(out).toContain('- **Workspace:** `/w`')
    expect(out).toContain('**You:** Open the report.')
    expect(out).toContain('**Ran** `ls -la`')
    expect(out).toContain('\n```\nREADME.md\n```\n')
    // A call that did not fail is still one line, with no block under it.
    expect(out).toContain('**Tool** `browser_open`')
    expect(out).not.toContain('failed')
  })
})
