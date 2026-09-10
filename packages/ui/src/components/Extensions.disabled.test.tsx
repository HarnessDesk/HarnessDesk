import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { RuntimeCatalog, RuntimeInfo, RuntimePlugin } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ExtensionsSection } from './Extensions'

/**
 * An installed plugin the runtime will not run.
 *
 * Codex reports two facts about every plugin — installed, and enabled — and
 * this list drew only the first. So a plugin an administrator had turned off,
 * or one this account's plan does not include, sat among the working ones
 * reading "Installed", and the only way to find out was to watch an agent
 * fail to use it.
 *
 * There is nothing to press. None of the agents this app drives offers a verb
 * that turns one back on: Codex's plugin surface is install and uninstall, and
 * every reason it gives for a plugin being off is an administrator's or a
 * plan's. So the honest control is a word — which is also why the store method
 * beside it is called `setRuntimePluginInstalled`. It was
 * `setRuntimePluginEnabled`, and passing `false` to a thing called "enabled"
 * deleted the plugin from disk.
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

const plugin = (over: Partial<RuntimePlugin> & { id: string; name: string }): RuntimePlugin =>
  ({
    description: 'Does a thing.',
    marketplace: 'openai',
    installed: true,
    enabled: true,
    ...over,
  }) as RuntimePlugin

const runtime = {
  id: 'codex',
  name: 'codex',
  capabilities: { extensionStore: true, mcp: true },
  presentation: { name: 'Codex' },
} as unknown as RuntimeInfo

const mount = (plugins: readonly RuntimePlugin[]) => {
  const catalog: RuntimeCatalog = { plugins, marketplaces: ['openai'], loadErrors: [], featured: [] }
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

/* One `Kit.Row`, by its own class. `[class*="row"]` matched both the list
   wrapper above it and the title span inside it — the first made an assertion
   about what a row does *not* say unable to fail, the second made one about
   what it does say unable to pass. */
const rowFor = (name: string): HTMLElement => {
  const found = [...container.querySelectorAll<HTMLElement>('div[class*="_row_"]')].find((one) =>
    one.querySelector('[class*="_rowTitle_"]')?.textContent?.includes(name),
  )
  expect(found, `a row for ${name}`).toBeTruthy()
  return found as HTMLElement
}

it('an installed plugin the runtime will not run says why, beside the one that works', async () => {
  mount([
    plugin({ id: 'good@openai', name: 'Working plugin' }),
    plugin({
      id: 'off@openai',
      name: 'Blocked plugin',
      enabled: false,
      disabledReason: 'turned off by an administrator',
    }),
  ])
  await act(async () => {})

  expect(rowFor('Blocked plugin').textContent).toContain('turned off by an administrator')
  /* The control. Both rows say "Installed" — that was the whole of what the
     list used to report — and only one of them is off. */
  expect(rowFor('Blocked plugin').textContent).toContain('Installed')
  expect(rowFor('Working plugin').textContent).toContain('Installed')
  expect(rowFor('Working plugin').textContent).not.toContain('administrator')
})

it('a plugin off for a reason the runtime will not name still reads as off', async () => {
  /* Codex answers `unknown` as readily as a real cause, and a sentence
     invented to fill the gap would be this app claiming to know something it
     does not. */
  mount([plugin({ id: 'off@openai', name: 'Blocked plugin', enabled: false })])
  await act(async () => {})
  expect(rowFor('Blocked plugin').textContent).toContain('off')
})

it('removing an installed plugin is an uninstall, and the method says so', async () => {
  const store = mount([plugin({ id: 'good@openai', name: 'Working plugin' })])
  await act(async () => {})

  const button = [...rowFor('Working plugin').querySelectorAll('button')].find(
    (one) => one.textContent?.trim() === 'Installed',
  )
  act(() => (button as HTMLButtonElement).click())
  await act(async () => {})

  expect(store.setRuntimePluginInstalled).toHaveBeenCalledWith(
    'openai',
    'Working plugin',
    'good@openai',
    false,
  )
})
