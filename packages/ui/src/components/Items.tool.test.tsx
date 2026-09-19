import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentItem, ToolCallItem, ToolResultContent } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { ItemView } from './Items'

/**
 * An opened tool step.
 *
 * The rule the box has to keep: it shows what the row could not, never what
 * the row already said. Everything an adapter hands us arrives shaped for a
 * markdown renderer that a transcript row is not — backticked names, JSON
 * encoding around plain output — and none of that spelling belongs on screen.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  delete window.harnessdesk
})

const call = (fields: {
  tool: string
  args?: unknown
  result?: readonly ToolResultContent[]
}): ToolCallItem =>
  ({
    id: 't1',
    type: 'toolCall',
    source: { kind: 'builtin' },
    status: 'completed',
    args: fields.args ?? {},
    result: fields.result,
    tool: fields.tool,
  }) as unknown as ToolCallItem

// useSyncExternalStore compares snapshots by identity, so this has to be the
// same object every read or the render never settles.
const snapshot = emptySnapshot()

/** Render the step and open it, the way a reader would. */
const open = (item: AgentItem): void => {
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ItemView item={item} root="/w" />
      </StoreProvider>,
    )
  })
  const header = container.querySelector('button')
  if (!header) throw new Error('no step header')
  act(() => {
    header.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

// CSS module class names arrive hashed here exactly as they do in a real
// build, so the few screen-owned structures are matched rather than compared.
const byClass = (name: string): Element[] => [
  ...container.querySelectorAll(`[class*="_${name}_"]`),
]

const title = (): string => container.querySelector('button')?.textContent ?? ''
const wire = (): string | null => byClass('wireName')[0]?.textContent ?? null
const outputs = (): string[] => [
  ...container.querySelectorAll('[data-slot="code-block-body"]'),
].map((el) => el.textContent ?? '')
const json = (): string[] => byClass('json').map((el) => el.textContent ?? '')

describe('an opened tool step', () => {
  it('shows the command without the backticks the adapter wrapped it in', () => {
    open(call({ tool: '`ps -p 511 -o pid,ppid,etime`' }))
    expect(title()).toContain('ps -p 511 -o pid,ppid,etime')
    expect(title()).not.toContain('`')
  })

  it('holds a shell command and its output in one code block', () => {
    open(call({
      tool: 'Bash',
      args: { command: 'pnpm test' },
      result: [{ type: 'text', text: 'Tests 12 passed' }],
    }))

    const blocks = container.querySelectorAll('[data-slot="code-block"]')
    expect(blocks).toHaveLength(1)
    expect(blocks[0]?.querySelector('[data-slot="code-block-command"]')?.textContent).toContain('$pnpm test')
    expect(blocks[0]?.querySelector('[data-slot="code-block-body"]')?.textContent).toBe('Tests 12 passed')
  })

  it('does not draw an empty output body for a shell call with no result parts', () => {
    open(call({ tool: 'Bash', args: { command: 'pnpm test' }, result: [] }))

    expect(container.querySelectorAll('[data-slot="code-block"]')).toHaveLength(1)
    expect(container.querySelector('[data-slot="code-block-body"]')).toBeNull()
  })

  it('does not repeat the title as a wire name', () => {
    open(call({ tool: '`ps -p 511 -o pid,ppid,etime`', args: { description: 'Inspect 511' } }))
    expect(wire()).toBe(null)
  })

  it('still names the tool when the name is one a permission rule can match', () => {
    open(call({ tool: 'search_files' }))
    expect(title()).toContain('Search files')
    expect(wire()).toBe('search_files')
  })

  it('reads a JSON string result as output, not as its own source code', () => {
    const shell = 'PID  TIME\n511  "01:20"\n'
    open(call({ tool: 'Bash', result: [{ type: 'json', value: shell }] }))
    expect(outputs()).toEqual([shell])
    expect(json()).toEqual([])
  })

  it('leaves a JSON object a document', () => {
    open(call({ tool: 'Bash', result: [{ type: 'json', value: { ok: true } }] }))
    expect(json()).toEqual(['{\n  "ok": true\n}'])
  })

  it('names a result part it cannot draw as an image, instead of drawing a broken one', () => {
    // #79: a PDF went into an <img>.
    open(call({ tool: 'browser_page', result: [{ type: 'image', url: 'data:application/pdf;base64,JVBERi0xLjcK', mimeType: 'application/pdf' }] }))
    expect(container.querySelectorAll('img[src^="data:application/pdf"]').length).toBe(0)
    expect(outputs()).toEqual(["application/pdf, 1 KB: can't be shown here."])
  })

  it('names a link that declares a type an <img> cannot draw, whatever the link', () => {
    // Round 1 of #187: an https link went into an <img> whatever its declared type.
    open(call({ tool: 'browser_page', result: [{ type: 'image', url: 'https://example.test/report.pdf', mimeType: 'application/pdf' }] }))
    expect(container.querySelectorAll('img[src="https://example.test/report.pdf"]').length).toBe(0)
    expect(outputs()).toEqual(["application/pdf: can't be shown here."])
  })

  it('names an image that fails to draw, rather than leaving a broken one (review of #187, round 2)', () => {
    open(call({ tool: 'browser_page', result: [{ type: 'image', url: 'https://example.test/gone.png' }] }))
    const img = container.querySelector<HTMLImageElement>('img[src="https://example.test/gone.png"]')
    expect(img).not.toBeNull()
    act(() => {
      img!.dispatchEvent(new Event('error'))
    })
    expect(container.querySelectorAll('img[src="https://example.test/gone.png"]').length).toBe(0)
    expect(outputs()).toEqual(["A file: can't be shown here."])
  })

  it('draws a result part that is an image', () => {
    open(call({ tool: 'browser_screenshot', result: [{ type: 'image', url: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png' }] }))
    expect(container.querySelectorAll('img[src="data:image/png;base64,iVBORw0KGgo="]').length).toBe(1)
  })
})

/** Render without opening anything — a user bubble has nothing to open. */
const render = (item: AgentItem): void => {
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ItemView item={item} root="/w" />
      </StoreProvider>,
    )
  })
}

describe('a user bubble', () => {
  const said = (text: string): AgentItem =>
    ({ id: 'u1', type: 'userMessage', content: [{ type: 'text', text }] }) as unknown as AgentItem

  const bubble = (): string => byClass('bubble')[0]?.textContent ?? ''

  /** One rule for a quotation: every markdown mark stays exactly as written. */
  it('leaves markdown and line breaks exactly as typed', () => {
    const typed = '# not a heading\n- run `echo hi`\n**not bold**'
    render(said(typed))
    expect(bubble()).toBe(typed)
    expect(container.querySelector('h1')).toBeNull()
    expect(byClass('bubbleCode')).toEqual([])
    expect(container.textContent).not.toContain('Show all')
  })

  it('makes an https URL an external link named by its host and path', () => {
    const opened = vi.fn()
    window.harnessdesk = { openExternal: opened } as unknown as NonNullable<Window['harnessdesk']>
    const url = 'https://docs.example.com/guides/setup?mode=desktop#install'

    render(said(`Read ${url} before changing it.`))

    const link = container.querySelector<HTMLAnchorElement>('a')
    expect(link?.textContent).toBe('docs.example.com/guides/setup')
    expect(link?.getAttribute('href')).toBe(url)
    act(() => link?.click())
    expect(opened).toHaveBeenCalledWith(url)
  })

  it('offers expansion only when twelve rendered lines do not hold the message', () => {
    const scrollHeight = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(300)
    const clientHeight = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(252)
    try {
      render(said(Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join('\n')))
      expect(container.querySelector('button')?.textContent).toBe('Show all')
      act(() => container.querySelector('button')?.click())
      expect(container.querySelector('button')?.textContent).toBe('Show less')
    } finally {
      scrollHeight.mockRestore()
      clientHeight.mockRestore()
    }
  })
})

/**
 * A failed dynamic tool call.
 *
 * The step draws a call's error *in place of* its result, so what reaches the
 * screen is whatever the adapter put in `error`. #241 made that the reason the
 * call came with rather than the constant "Tool reported failure"; the mapping
 * is pinned in `packages/adapter-codex`, and this is the same claim at the
 * layer a person actually reads it (#273). The row marks the failure; the
 * full output stays behind the person's click.
 */
describe('a failed dynamic tool call', () => {
  const failed = (fields: { error?: string; result?: readonly ToolResultContent[] }): ToolCallItem =>
    ({
      id: 't2',
      type: 'toolCall',
      source: { kind: 'dynamic', namespace: 'reports' },
      status: 'failed',
      args: { url: 'http://reports.test/q4' },
      tool: 'browser_open',
      ...fields,
    }) as unknown as ToolCallItem

  const reason = 'The browser could not open http://reports.test/q4: the host did not answer.'

  it('marks the failed step on one closed line and opens its output only on click', () => {
    render(failed({ error: reason }))
    expect(title()).toContain('failed')
    expect(outputs()).toEqual([])

    act(() => container.querySelector('button')?.click())
    expect(outputs()).toEqual([reason])
  })

  it('shows the reason it came with, not the constant', () => {
    open(failed({ error: reason, result: [{ type: 'text', text: reason }] }))
    expect(outputs()).toEqual([reason])
    expect(container.textContent).not.toContain('Tool reported failure')
    // The controls, true whatever the box says: the step is the failed call it
    // was, named by the tool a permission rule would match, with one body block.
    expect(wire()).toBe('browser_open')
    expect(outputs()).toHaveLength(1)
  })

  it('keeps a reason that arrived in several parts on the several lines it was joined into', () => {
    // What `failureOf` produces from a failure whose reason came as two text parts (#245).
    const joined = 'The hook refused this call.\nEdit the hook to allow it.'
    open(failed({ error: joined }))
    expect(outputs()).toEqual([joined])
  })

  it('draws the reason in place of the result, not beside it', () => {
    open(failed({ error: reason, result: [{ type: 'text', text: 'half the page' }] }))
    expect(outputs()).toEqual([reason])
    expect(container.textContent).not.toContain('half the page')
  })
})
