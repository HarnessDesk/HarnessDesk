import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { CapabilityContribution, UiBlock } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { installPanelComponent } from './PanelBlocks'
import { resolveComponent } from './registry'

/**
 * The block vocabulary, through the DOM.
 *
 * What these hold is the boundary, not the pixels. A plugin hands over JSON
 * and gets back a rendered panel; the things that must stay true are that no
 * part of that JSON can become behaviour, that every interaction leaves as a
 * *named command* through the store, and that a plugin sending something
 * slightly wrong — a row missing a cell, a decoration past the end of the
 * file, `editable` with nothing to save to — degrades instead of throwing
 * inside the render tree.
 *
 * The code block's editor is deliberately not exercised here: it is
 * `lazy()`, so it resolves a chunk asynchronously and what a synchronous
 * render sees is the Suspense fallback. That fallback carrying the text is
 * itself worth asserting — a panel whose editor chunk is still in flight
 * must still show the code.
 */

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

const runCommand = vi.fn()

beforeEach(() => {
  // jsdom has no media queries, and both `markdown` and `code` reach the
  // theme to pick their highlighting. The OS is light here; which face is
  // chosen is `theme.test.tsx`'s subject, not this file's.
  ;(window as { matchMedia?: unknown }).matchMedia = (query: string) =>
    ({
      media: query,
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  runCommand.mockReset()
  setListPrefs.mockReset()
  installPanelComponent()
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

const setListPrefs = vi.fn()

const mount = (
  blocks: readonly UiBlock[],
  title?: string,
  options: { owner?: string; label?: string; id?: string; collapsed?: string[] } = {},
): void => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    listPrefs: { ...emptySnapshot().listPrefs, panelsCollapsed: options.collapsed ?? [] },
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    runCommand,
    setListPrefs,
  } as unknown as AppStore
  const contribution = {
    kind: 'ui',
    id: options.id ?? 'test',
    owner: options.owner ?? 'test',
    pluginId: 'test',
    slot: 'sidebar.panel',
    label: options.label ?? 'Test',
    order: 0,
    component: 'hd.panel',
    data: { ...(title ? { title } : {}), blocks },
  } as unknown as CapabilityContribution
  const Panel = resolveComponent('hd.panel')
  if (!Panel) throw new Error('hd.panel was not published')
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <Panel contribution={contribution} />
      </StoreProvider>,
    )
  })
}

const click = (element: Element): void => {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

const text = (): string => container.textContent ?? ''

describe('table', () => {
  const columns = [
    { key: 'name', label: 'Name' },
    { key: 'count', label: 'Count', align: 'end' as const },
  ]

  it('places cells by key, so a missing one is empty and not the next column', () => {
    mount([
      {
        type: 'table',
        columns,
        // The second row has no `count`. Positional rendering would slide
        // nothing into its place and leave the column reading as if the row
        // had a value; keyed rendering leaves the cell blank.
        rows: [{ name: 'alpha', count: '12' }, { name: 'beta' }],
      },
    ])
    const rows = [...container.querySelectorAll('tbody tr')]
    expect(rows).toHaveLength(2)
    const cells = (row: Element): string[] => [...row.querySelectorAll('td')].map((cell) => cell.textContent ?? '')
    expect(cells(rows[0]!)).toEqual(['alpha', '12'])
    expect(cells(rows[1]!)).toEqual(['beta', ''])
  })

  it('gives every column a scoped header and keeps a caption', () => {
    mount([{ type: 'table', columns, rows: [], caption: 'Two of them' }])
    const headers = [...container.querySelectorAll('th')]
    expect(headers.map((header) => header.getAttribute('scope'))).toEqual(['col', 'col'])
    expect(container.querySelector('caption')?.textContent).toBe('Two of them')
  })

  it('renders an extra key the columns do not name as nothing at all', () => {
    mount([{ type: 'table', columns, rows: [{ name: 'alpha', count: '1', secret: 'leaked' }] }])
    expect(text()).not.toContain('leaked')
  })
})

describe('tree', () => {
  const nodes = [
    {
      label: 'src',
      children: [
        { label: 'index.ts', hint: '2 KB', action: { label: 'open', command: 'open', argument: 'src/index.ts' } },
      ],
    },
  ]

  it('starts closed unless the node says otherwise', () => {
    mount([{ type: 'tree', nodes }])
    expect(text()).toContain('src')
    expect(text()).not.toContain('index.ts')
  })

  it('opens on the twisty without running the row underneath it', () => {
    mount([{ type: 'tree', nodes }])
    const twisty = container.querySelector('[aria-expanded]')
    expect(twisty).not.toBeNull()
    click(twisty!)
    expect(text()).toContain('index.ts')
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('runs a leaf as a named command, with its argument', () => {
    mount([{ type: 'tree', nodes: [{ ...nodes[0]!, expanded: true }] }])
    const leaf = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('index.ts'),
    )
    expect(leaf).toBeDefined()
    click(leaf!)
    expect(runCommand).toHaveBeenCalledWith('open', 'src/index.ts')
  })

  it('renders a node with no action as a label rather than a control', () => {
    mount([{ type: 'tree', nodes: [{ label: 'read only' }] }])
    // The twisty is the only button a childless, actionless node could have,
    // and it has no children either — so there is nothing to press.
    expect(container.querySelectorAll('button')).toHaveLength(0)
    expect(text()).toContain('read only')
  })
})

describe('document', () => {
  const sections = [
    { heading: 'Finding', text: 'The build is slow.' },
    { heading: 'Evidence', text: 'Numbers here.', collapsed: true },
  ]

  it('starts a collapsed section folded and the rest open', () => {
    mount([{ type: 'document', title: 'Report', sections }])
    expect(text()).toContain('Report')
    expect(text()).toContain('The build is slow.')
    expect(text()).not.toContain('Numbers here.')
  })

  it('folds and unfolds, and says which it is', () => {
    mount([{ type: 'document', sections }])
    const headings = [...container.querySelectorAll('[aria-expanded]')]
    expect(headings.map((heading) => heading.getAttribute('aria-expanded'))).toEqual(['true', 'false'])
    click(headings[1]!)
    expect(text()).toContain('Numbers here.')
    expect(headings[1]!.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('diff', () => {
  it('draws a patch, and names the file when it was given one', () => {
    mount([
      {
        type: 'diff',
        path: 'src/a.ts',
        patch: '@@ -1,2 +1,2 @@\n-const a = 1\n+const a = 2\n',
      },
    ])
    expect(text()).toContain('src/a.ts')
    expect(text()).toContain('const a = 2')
  })
})

describe('code', () => {
  it('shows its text before the editor chunk has resolved', () => {
    mount([{ type: 'code', text: 'const a = 1', language: 'typescript' }])
    expect(text()).toContain('const a = 1')
  })

  it('does not offer to edit when nothing would receive what was typed', () => {
    // `editable` with no `onSave` is a plugin bug. Reading it as read-only
    // loses nothing; honouring it would take the person's typing and drop it.
    mount([{ type: 'code', text: 'x', editable: true }])
    expect(text()).not.toContain('Unsaved')
  })
})

describe('the panel as a whole', () => {
  it('ignores a block type this build does not know', () => {
    mount([{ type: 'nonsense' } as unknown as UiBlock, { type: 'markdown', text: 'still here' }])
    expect(text()).toContain('still here')
  })

  it('renders nothing at all when the contribution carries no blocks', () => {
    const store = { subscribe: () => () => {}, getSnapshot: () => emptySnapshot(), runCommand } as unknown as AppStore
    const Panel = resolveComponent('hd.panel')!
    act(() => {
      root.render(
        <StoreProvider store={store}>
          <Panel contribution={{ kind: 'ui', data: { nope: true } } as unknown as CapabilityContribution} />
        </StoreProvider>,
      )
    })
    expect(container.querySelector('section')).toBeNull()
  })

  it('runs an action button as a command in the plugin host', () => {
    mount([{ type: 'actions', actions: [{ label: 'Go', command: 'go' }] }], undefined)
    click(container.querySelector('button')!)
    expect(runCommand).toHaveBeenCalledWith('go', '')
  })
})

describe('the section around a panel', () => {
  const blocks: readonly UiBlock[] = [{ type: 'markdown', text: 'the body' }]

  it('folds from its title, keyed on the plugin and the label', () => {
    // Never the contribution id: a plugin reissues that on every update it
    // makes, and a fold keyed on it springs open at the next tick.
    mount(blocks, 'Reading history', { owner: 'browser', label: 'History', id: 'c17' })
    const title = container.querySelector('button')!
    expect(title.getAttribute('aria-expanded')).toBe('true')
    click(title)
    expect(setListPrefs).toHaveBeenCalledWith({ panelsCollapsed: ['browser:History'] })
  })

  it('shows only the title once folded, and offers the way back', () => {
    mount(blocks, 'Reading history', { owner: 'browser', label: 'History', collapsed: ['browser:History'] })
    expect(text()).toContain('Reading history')
    expect(text()).not.toContain('the body')
    click(container.querySelector('button')!)
    expect(setListPrefs).toHaveBeenCalledWith({ panelsCollapsed: [] })
  })

  it('never folds a panel with no title, because nothing would unfold it', () => {
    mount(blocks)
    expect(text()).toContain('the body')
    expect(container.querySelector('section button')).toBeNull()
  })
})
