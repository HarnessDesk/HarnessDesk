import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'

import { sessionKey, type SessionKey } from '@harnessdesk/protocol'
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

/* `scope` is on every contribution the host sends — `ContributionBase`
   requires it — and these fixtures omitted it behind a cast, so the list
   rendered here was a list the wire never produces. It cost a crash the
   moment a row read the field. Global unless a test says otherwise, which is
   what every contribution in this repository is today. */
const tool = (
  owner: string,
  name: string,
  description: string,
  scope: CapabilityContribution['scope'] = { kind: 'global' },
): CapabilityContribution =>
  ({
    id: `${owner}/${name}`,
    owner,
    revision: 1,
    scope,
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
    scope: { kind: 'global' },
    kind: 'hook',
    event: 'preToolUse',
    description: name,
  }) as unknown as CapabilityContribution

/** What the host was asked, so a test can say the question was put to it. */
type Asked = { readonly kind: string; readonly scope: object }

const makeStore = (
  info: RuntimeInfo,
  here?: {
    readonly answers: CapabilityContribution[]
    readonly asked: Asked[]
    readonly webScope?: CapabilityContribution['scope']
    readonly activeSessionKey?: SessionKey
  },
): AppStore => {
  const git = plugin('git', 'Git', [tool('git', 'git_status', 'Show the working tree status.')])
  const guard = plugin('guardrails', 'Guardrails', [hook('guardrails', 'Checks every tool call')])
  const web = plugin('web', 'Web', [
    tool('web', 'web_fetch', 'Fetch a page from an allowed host.', here?.webScope),
  ])
  const snapshot: AppSnapshot = {
    ...emptySnapshot(),
    status: 'open',
    activeRuntime: info.id,
    runtimes: [info],
    plugins: [git, guard, web],
    contributions: [...git.contributions, ...guard.contributions, ...web.contributions],
    /* A conversation is the active one before its session object has been
       read in — the map is deliberately left empty for that case. */
    ...(here?.activeSessionKey ? { activeSessionKey: here.activeSessionKey } : {}),
  }
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    listCapabilities: async (kind: string, scope: object) => {
      here?.asked.push({ kind, scope })
      return (here?.answers ?? []).filter((one) => one.kind === kind)
    },
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

it('a contribution that applies to one workspace says so; a global one says nothing', () => {
  /* The scope has been on every contribution since the capability plane
     landed and on no row: a tool a plugin offered to one checkout read here
     exactly like one offered to every agent in the app. */
  mount(
    makeStore(runtime('codex', 'Codex', true), {
      answers: [],
      asked: [],
      webScope: { kind: 'workspace', root: '/repo/api' },
    }),
  )
  openCapabilities()
  expect(container.textContent).toContain('only in /repo/api')
  // The control: the other two are global, and a row saying "everywhere"
  // under every entry is a word nobody reads.
  expect(container.textContent).not.toContain('everywhere')
})

it('“applies here” is the host’s answer, not the pushed list filtered again', async () => {
  /* The whole reason `capability/list` exists. The renderer is pushed every
     contribution regardless of scope and filters by kind alone, so it cannot
     answer this question at all — only the host evaluates a scope. */
  const asked: Asked[] = []
  const only = tool('git', 'git_status', 'Show the working tree status.')
  mount(makeStore(runtime('codex', 'Codex', true), { answers: [only], asked }))
  openCapabilities()

  expect(container.textContent).toContain('Fetch a page from an allowed host.')

  const where = container.querySelector<HTMLSelectElement>('select[aria-label="Where it applies"]')
  expect(where, 'the scope filter exists').toBeTruthy()
  setValue(where as HTMLSelectElement, 'here')
  await act(async () => {})

  // Every kind was asked, and the answer replaced the list rather than
  // narrowing it: `web_fetch` is in the pushed set and not in the host's.
  expect(asked.map((one) => one.kind)).toContain('tool')
  expect(asked.map((one) => one.kind)).toContain('hook')
  expect(container.textContent).toContain('Show the working tree status.')
  expect(container.textContent).not.toContain('Fetch a page from an allowed host.')
})

it('changing the kind under “applies here” does not show the last kind’s answer', async () => {
  /* Found by both reviewers. The list skipped kind filtering under `here` on
     the grounds that the host had already filtered — true of a fresh answer
     and false of the one still in hand while the next request is in flight.
     Selecting Tools left hooks and panels on screen until it landed. */
  const asked: Asked[] = []
  const answers = [
    tool('git', 'git_status', 'Show the working tree status.'),
    hook('guardrails', 'Checks every tool call'),
  ]
  mount(makeStore(runtime('codex', 'Codex', true), { answers, asked }))
  openCapabilities()

  const where = container.querySelector<HTMLSelectElement>('select[aria-label="Where it applies"]')
  setValue(where as HTMLSelectElement, 'here')
  await act(async () => {})
  expect(container.textContent).toContain('Checks every tool call')

  /* The kind moves and the answer for it has not arrived. `setValue` does not
     flush the effect's promise, so this is exactly the in-flight moment. */
  const kind = container.querySelector<HTMLSelectElement>('select[aria-label="Filter by kind"]')
  setValue(kind as HTMLSelectElement, 'tool')
  expect(container.textContent).not.toContain('Checks every tool call')

  await act(async () => {})
  expect(container.textContent).toContain('Show the working tree status.')
})

it('the conversation’s id reaches the host before its session has been read in', async () => {
  /* `snapshot.sessions.get(activeSessionKey)?.id` is `undefined` for the whole
     window between a conversation becoming active and its session arriving, so
     the scope went out without a `sessionId` and the host left session-scoped
     contributions out of its answer. Found in review. The key carries the id;
     splitting it cannot be early. */
  const asked: Asked[] = []
  mount(
    makeStore(runtime('codex', 'Codex', true), {
      answers: [],
      asked,
      activeSessionKey: sessionKey('codex' as never, '01a04ec8-90f2-70b0' as never),
    }),
  )
  openCapabilities()
  const where = container.querySelector<HTMLSelectElement>('select[aria-label="Where it applies"]')
  setValue(where as HTMLSelectElement, 'here')
  await act(async () => {})

  expect(asked.length).toBeGreaterThan(0)
  for (const one of asked) {
    expect(one.scope).toMatchObject({ sessionId: '01a04ec8-90f2-70b0' })
  }
})
