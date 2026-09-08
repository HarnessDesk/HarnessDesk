import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import type {
  CapabilityContribution,
  PluginInstance,
  RuntimeInfo,
} from '@harnessdesk/protocol'
import { NO_PERMISSIONS } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { PluginsSection } from './PluginsSection'

/**
 * The capability inventory: everything plugins contribute, findable.
 *
 * Three promises. The search finds a tool by what it does, not only by its
 * wire name. The kind filter narrows to one vocabulary. And the reach chip is
 * honest about an agent that refuses the session-request server: DeepSeek
 * Harness loads the same bridge from its own composition, so "no reach" was
 * a lie the moment §28.5 landed — the chip may only claim what the host can
 * actually see.
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

const runtime = (id: string, name: string, pluginTools: boolean): RuntimeInfo =>
  ({
    id,
    name,
    capabilities: { pluginTools },
    presentation: { name },
  }) as unknown as RuntimeInfo

const plugin = (id: string, name: string, contributions: CapabilityContribution[]): PluginInstance =>
  ({
    instanceId: id,
    identity: { id, name, source: { kind: 'builtin' } },
    state: { type: 'active' },
    revision: 1,
    permissions: NO_PERMISSIONS,
    injects: [],
    provides: [],
    contributions,
    enabled: true,
  }) as unknown as PluginInstance

const tool = (owner: string, name: string, description: string): CapabilityContribution =>
  ({
    id: `${owner}/${name}`,
    owner,
    revision: 1,
    kind: 'tool',
    namespace: owner,
    name,
    description,
    inputSchema: {},
  }) as unknown as CapabilityContribution

const hook = (owner: string, name: string): CapabilityContribution =>
  ({
    id: `${owner}/${name}`,
    owner,
    revision: 1,
    kind: 'hook',
    event: 'preToolUse',
    description: name,
  }) as unknown as CapabilityContribution

const makeStore = (info: RuntimeInfo): AppStore => {
  const git = plugin('git', 'Git', [tool('git', 'git_status', 'Show the working tree status.')])
  const guard = plugin('guardrails', 'Guardrails', [hook('guardrails', 'Checks every tool call')])
  const web = plugin('web', 'Web', [tool('web', 'web_fetch', 'Fetch a page from an allowed host.')])
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: info.id,
    runtimes: [info],
    plugins: [git, guard, web],
    contributions: [...git.contributions, ...guard.contributions, ...web.contributions],
  }
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  } as unknown as AppStore
}

const mount = (store: AppStore) => {
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <PluginsSection />
      </StoreProvider>,
    )
  })
}

const openCapabilities = () => {
  const segment = [...container.querySelectorAll('button')].find((button) =>
    button.textContent?.startsWith('Capabilities'),
  )
  expect(segment, 'the Capabilities segment exists').toBeTruthy()
  act(() => segment?.click())
}

const setValue = (input: HTMLInputElement | HTMLSelectElement, value: string) => {
  const proto = input instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement
  const set = Object.getOwnPropertyDescriptor(proto.prototype, 'value')?.set
  act(() => {
    set?.call(input, value)
    input.dispatchEvent(new Event('change', { bubbles: true }))
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('search finds a tool by what it does, and the kind filter narrows the list', () => {
  mount(makeStore(runtime('codex', 'Codex', true)))
  openCapabilities()

  expect(container.textContent).toContain('Show the working tree status.')
  expect(container.textContent).toContain('Checks every tool call')

  const search = container.querySelector<HTMLInputElement>('input[aria-label="Search capabilities"]')
  expect(search).toBeTruthy()
  setValue(search as HTMLInputElement, 'working tree')
  expect(container.textContent).toContain('Show the working tree status.')
  expect(container.textContent).not.toContain('Fetch a page')
  expect(container.textContent).not.toContain('Checks every tool call')

  setValue(search as HTMLInputElement, '')
  const kind = container.querySelector<HTMLSelectElement>('select[aria-label="Filter by kind"]')
  expect(kind).toBeTruthy()
  setValue(kind as HTMLSelectElement, 'hook')
  expect(container.textContent).toContain('Checks every tool call')
  expect(container.textContent).not.toContain('Show the working tree status.')
})

it('an agent that takes the server shows every tool as reaching it', () => {
  mount(makeStore(runtime('codex', 'Codex', true)))
  openCapabilities()
  expect(container.textContent).toContain('reaches agent')
  expect(container.textContent).not.toContain('own config only')
})

it('an agent that refuses the server is not told the tools are lost', () => {
  // DeepSeek Harness refuses the session-request server yet loads the same
  // bridge from its own composition — the host cannot see which, so the chip
  // and the note may say "not through the session request" and no more.
  mount(makeStore(runtime('dsh', 'DeepSeek Harness', false)))
  openCapabilities()
  expect(container.textContent).toContain('own config only')
  expect(container.textContent).not.toContain('no reach')
  expect(container.textContent).toContain('does not take them in the session request')
  expect(container.textContent).not.toContain('cannot receive plugin tools')
})
