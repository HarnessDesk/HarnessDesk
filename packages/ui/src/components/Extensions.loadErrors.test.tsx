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

const mount = (loadErrors: RuntimeCatalog['loadErrors']) => {
  const catalog: RuntimeCatalog = { plugins: [], marketplaces: ['openai'], loadErrors, featured: [] }
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtime.id,
    runtimes: [runtime],
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

it('says what went wrong with every marketplace that failed, not only the first', async () => {
  mount([
    { source: '/broken/one/marketplace.json', message: 'could not parse' },
    { source: '/broken/two/marketplace.json', message: 'no such file' },
  ])
  await act(async () => {})
  const text = container.textContent ?? ''
  expect(text).toContain('/broken/one/marketplace.json failed to load')
  expect(text).toContain('could not parse')
  expect(text).toContain('/broken/two/marketplace.json failed to load')
  expect(text).toContain('no such file')
})
