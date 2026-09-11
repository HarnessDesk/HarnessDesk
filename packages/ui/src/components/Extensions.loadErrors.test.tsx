import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { RuntimeCatalog, RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ExtensionsSection } from './Extensions'

/**
 * Marketplaces that failed to load, each in its own row with its own words
 * (#105): one row counted them and showed the first message, so with two
 * failures the second reason was never seen.
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
})

const runtime = {
  id: 'codex',
  name: 'codex',
  capabilities: { extensionStore: true, mcp: true },
  presentation: { name: 'Codex' },
} as unknown as RuntimeInfo

const mount = (loadErrors: RuntimeCatalog['loadErrors'], home: string | null = null) => {
  const catalog: RuntimeCatalog = { plugins: [], marketplaces: ['openai'], loadErrors, featured: [] }
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtime.id,
    runtimes: [runtime],
    home,
  } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    loadCatalog: vi.fn().mockResolvedValue(catalog),
    setRuntimePluginInstalled: vi.fn().mockResolvedValue(undefined),
    searchApps: vi.fn().mockResolvedValue({ apps: [] }),
    loadMcpServers: vi.fn().mockResolvedValue([]),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ExtensionsSection />
      </StoreProvider>,
    )
  })
  return store
}

/** The row whose title names this marketplace, and what that row alone says. */
const rowFor = (title: string): string | undefined =>
  [...container.querySelectorAll('span')].find((node) => node.textContent === title)?.parentElement?.textContent ?? undefined

it('says what went wrong with every marketplace that failed, each in its own row', async () => {
  mount([
    { source: '/broken/one/marketplace.json', message: 'could not parse' },
    { source: '/broken/two/marketplace.json', message: 'no such file' },
  ])
  await act(async () => {})
  // Row by row (#219): read as the whole page's text, one row carrying both failures passed.
  const one = rowFor('/broken/one/marketplace.json failed to load')
  const two = rowFor('/broken/two/marketplace.json failed to load')
  expect(one).toContain('could not parse')
  expect(one).not.toContain('no such file')
  expect(two).toContain('no such file')
  expect(two).not.toContain('could not parse')
})

it('two failures with the same source and message are two rows, without a key clash (#219)', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    mount([
      { source: '/broken/marketplace.json', message: 'could not parse' },
      { source: '/broken/marketplace.json', message: 'could not parse' },
    ])
    await act(async () => {})
    expect([...container.querySelectorAll('span')].filter((node) => node.textContent === '/broken/marketplace.json failed to load')).toHaveLength(2)
    expect(errors.mock.calls.some((call) => String(call[0]).includes('same key'))).toBe(false)
  } finally {
    errors.mockRestore()
  }
})

it('shows three failures and offers the rest, and shortens a path under the home folder (#219)', async () => {
  mount(
    Array.from({ length: 5 }, (_, index) => ({ source: `/home/dev/.codex/marketplaces/m${index}/marketplace.json`, message: `failure ${index}` })),
    '/home/dev',
  )
  await act(async () => {})
  const titles = (): string[] =>
    [...container.querySelectorAll('span')].map((node) => node.textContent ?? '').filter((text) => text.endsWith('failed to load'))
  expect(titles()).toEqual([0, 1, 2].map((index) => `~/.codex/marketplaces/m${index}/marketplace.json failed to load`))
  const more = [...container.querySelectorAll('button')].find((node) => node.textContent?.trim() === 'Show 2 more')
  expect(more, 'the rest are offered').toBeTruthy()
  await act(async () => more!.click())
  expect(titles()).toHaveLength(5)
})
