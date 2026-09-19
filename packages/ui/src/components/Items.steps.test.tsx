import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AgentItem } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { ItemView } from './Items'

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
})

const snapshot = emptySnapshot()

const render = (items: readonly AgentItem[]): void => {
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        {items.map((item) => (
          <ItemView key={item.id} item={item} root="/w" />
        ))}
      </StoreProvider>,
    )
  })
}

const titles = (): HTMLSpanElement[] => [
  ...container.querySelectorAll<HTMLSpanElement>('[class*="_rowTitle_"]'),
]

describe('step sentences', () => {
  it('renders reads, searches, edits, failures, and unknown tools as interface sentences', () => {
    const items = [
      {
        id: 'read',
        type: 'toolCall',
        tool: 'Read',
        source: { kind: 'builtin' },
        status: 'completed',
        args: { file_path: '/w/src/checkout/retry.ts' },
      },
      {
        id: 'search',
        type: 'toolCall',
        tool: 'Grep',
        source: { kind: 'builtin' },
        status: 'completed',
        args: { pattern: '50[0-9]', path: '/w/src/checkout' },
      },
      {
        id: 'edit',
        type: 'fileChange',
        status: 'completed',
        changes: [
          {
            path: '/w/src/checkout/retry.ts',
            kind: { type: 'update' },
            diff: '@@ -1,2 +1,8 @@\n-old one\n-old two\n+new one\n+new two\n+new three\n+new four\n+new five\n+new six\n+new seven\n+new eight\n',
          },
        ],
      },
      {
        id: 'command',
        type: 'command',
        command: `/bin/zsh -lc 'pnpm test'`,
        cwd: '/w',
        origin: 'agent',
        actions: [{ type: 'unknown', command: 'pnpm test' }],
        status: 'failed',
        exitCode: 1,
        output: 'failed',
      },
      {
        id: 'unknown',
        type: 'toolCall',
        tool: 'mcp__other__str_replace_based_edit_tool',
        source: { kind: 'mcp', server: 'other' },
        status: 'completed',
        args: {},
      },
      {
        id: 'fetch',
        type: 'toolCall',
        tool: 'fetch_page',
        source: { kind: 'builtin' },
        status: 'completed',
        args: { url: 'https://example.com/docs/retries' },
      },
      {
        id: 'titled-edit',
        type: 'toolCall',
        tool: 'Edit src/checkout/retry.ts',
        source: { kind: 'builtin' },
        status: 'completed',
        args: { path: 'src/checkout/retry.ts' },
      },
    ] as unknown as AgentItem[]

    render(items)

    expect(titles().map((title) => title.textContent)).toEqual([
      'Read retry.ts',
      'Searched for 50[0-9] in src/checkout',
      'Edited retry.ts',
      'Ran pnpm test',
      'other · Str replace based edit tool',
      'Fetch pagehttps://example.com/docs/retries',
      // Reported by its kind with only a file: still an edit, named once.
      'Edited retry.ts',
    ])
    expect(titles().every((title) => !title.textContent?.includes('mcp__'))).toBe(true)
    expect(titles().every((title) => !title.textContent?.includes('str_replace'))).toBe(true)

    const edit = titles()[2]?.closest('button')
    expect(edit?.textContent).toContain('+8')
    expect(edit?.textContent).toContain('−2')

    const failed = titles()[3]?.closest('button')
    expect(failed?.textContent).toContain('failed')
    expect(failed?.textContent).not.toContain('exit 1')
    expect(container.textContent).not.toContain('exit code 1')
    act(() => failed?.click())
    expect(container.textContent).toContain('exit code 1')

    expect(titles()[0]?.closest('button')?.title).toBe('src/checkout/retry.ts')
    expect(titles()[2]?.closest('button')?.title).toBe('src/checkout/retry.ts')
  })
})
