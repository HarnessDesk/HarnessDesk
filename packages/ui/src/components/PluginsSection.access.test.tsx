import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { NO_PERMISSIONS, type PluginInstance, type PluginPermissions, type RuntimeInfo } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { PluginsSection } from './PluginsSection'

/**
 * The Access list, as the person actually reads it (#288).
 *
 * This is the surface that asks someone to live with a grant, and it wrote its
 * own sentences rather than the host's. Two things followed. A plugin asking to
 * reach the whole network was described as `Reach *`. And five of the grants
 * the manifest allows had no sentence here at all, so a plugin holding one of
 * them — `browser`, `ios` and `android` are each the only grant a shipped
 * built-in declares — read as holding nothing.
 *
 * Asserted against the rendered rows rather than the function's return value:
 * the function was never the half that was wrong.
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
  capabilities: { pluginTools: true },
  presentation: { name: 'Codex' },
} as unknown as RuntimeInfo

const plugin = (id: string, name: string, over: Partial<PluginPermissions>): PluginInstance =>
  ({
    instanceId: id,
    identity: { id, name, source: { kind: 'builtin' } },
    state: { type: 'active' },
    revision: 1,
    permissions: { ...NO_PERMISSIONS, ...over },
    injects: [],
    provides: [],
    contributions: [],
    enabled: true,
  }) as unknown as PluginInstance

const mount = (plugins: PluginInstance[]) => {
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: runtime.id,
    runtimes: [runtime],
    plugins,
    contributions: [],
  }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    listCapabilities: async () => [],
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <PluginsSection />
      </StoreProvider>,
    )
  })
}

/** Open a plugin's own page — the row is the button that opens it. */
const open = (name: string) => {
  const row = [...container.querySelectorAll('button[class*="_rowButton_"]')].find((button) =>
    button.textContent?.includes(name),
  )
  expect(row, `the row for ${name} is on the list`).toBeTruthy()
  act(() => (row as HTMLButtonElement).click())
  // The control on every case below: the page opened at all, so an assertion
  // about its text is not passing against an empty container.
  expect(container.textContent).toContain('Access')
}

it('a plugin that may reach every host says so in words', () => {
  mount([plugin('reacher', 'Reacher', { network: { hosts: ['*'] } })])
  open('Reacher')

  expect(container.textContent).toContain('Reach any host on the network')
  expect(container.textContent).not.toContain('Reach *')
})

it('several hosts arrive as one row, not one row each', () => {
  mount([
    plugin('reacher', 'Reacher', {
      network: { hosts: ['api.example.com', 'logs.example.com', 'cdn.example.com'] },
    }),
  ])
  open('Reacher')

  const rows = [...container.querySelectorAll('[class*="_rowTitle_"]')].map(
    (row) => row.textContent ?? '',
  )
  const reach = rows.filter((row) => row.startsWith('Reach '))
  expect(reach).toEqual(['Reach api.example.com, logs.example.com, cdn.example.com'])
})

it('a grant the page had no sentence for is not rendered as no grant at all', () => {
  /* The Browser built-in's manifest exactly: `permissions: { browser: true }`
     and nothing else. The page had no branch for it, so it fell to the empty
     case and told the person this plugin did nothing beyond reading what the
     agent sends it. */
  mount([plugin('looking-glass', 'Looking Glass', { browser: true })])
  open('Looking Glass')

  expect(container.textContent).toContain('Open and control a browser on this machine')
  expect(container.textContent).not.toContain('Nothing beyond reading what the agent sends it')
})

it('the other grants the page could not name are named', () => {
  mount([
    plugin('wide', 'Wide Reach', {
      ios: true,
      android: true,
      editor: true,
      secrets: ['deploy-token'],
    }),
  ])
  open('Wide Reach')

  expect(container.textContent).toContain('Control the iOS Simulator on this machine')
  expect(container.textContent).toContain('Control Android devices and emulators')
  expect(container.textContent).toContain('Open files in the editor and mark them up')
  expect(container.textContent).toContain('Read the stored secret "deploy-token"')
})

it('a plugin holding nothing still says so', () => {
  // The control for the three cases above: the empty sentence is reachable, so
  // "does not say nothing" is a claim about the grant and not about a page
  // that can no longer produce that line.
  mount([plugin('quiet', 'Quiet', {})])
  open('Quiet')

  expect(container.textContent).toContain('Nothing beyond running in the plugin host')
})
