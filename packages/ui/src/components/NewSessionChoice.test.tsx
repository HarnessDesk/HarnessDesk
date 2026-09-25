import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntry, FlowEntry, FlowExecution, FlowPreview, SeatPlan } from '@harnessdesk/protocol'

import { ShellProvider, type ShellActions } from '../panels/views'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { NewSessionChoice } from './NewSessionChoice'

/**
 * The entry point for the whole product: what kind of thing you are
 * starting, first, and only then — for a Session — who runs it.
 *
 * Every created Agent used to lead this dialog as its own bordered row, so a
 * roster of more than a couple buried "A session" — what ⌘N does — under a
 * scrolling column of identical tiles. An Agent is now an answer to "who
 * runs the session," reached from a "Run as" picker, not a fifth kind of
 * thing to start.
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

const rig = (
  over: { workspace?: unknown } = {},
  agents: readonly AgentEntry[] = [],
  plans: ReadonlyMap<string, SeatPlan> = new Map(),
) => {
  const open = over.workspace === undefined ? { path: '/repo', name: 'repo', lastOpenedAt: 1 } : over.workspace
  const snapshot = {
    ...emptySnapshot(),
    status: 'open',
    workspace: open,
    workspaces: open ? [open] : [],
    agents,
    agentPlans: plans,
  } as unknown as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    newDraft: vi.fn(),
    createGoal: vi.fn().mockResolvedValue({ goal: { id: 'g1' } }),
    openGoal: vi.fn(),
    loadAgents: vi.fn(async () => {}),
    startAsAgent: vi.fn(async () => null),
    showView: vi.fn(),
    flowGeneration: vi.fn(() => 0),
    flowCatalog: vi.fn(async () => []),
    agentsIn: vi.fn(async () => []),
    flowSource: vi.fn(async () => ''),
    previewFlow: vi.fn(async () => null),
    startFlowGoal: vi.fn(),
  } as unknown as AppStore
  return { store }
}

const shell: ShellActions = {
  chooseProject: vi.fn(),
  signIn: vi.fn(),
  openUsage: vi.fn(),
  openRuntimes: vi.fn(),
  openAgents: vi.fn(),
}

const render = (store: AppStore, onClose = vi.fn()): typeof onClose => {
  act(() => {
    root.render(
      <ShellProvider actions={shell}>
        <StoreProvider store={store}>
          <NewSessionChoice onClose={onClose} />
        </StoreProvider>
      </ShellProvider>,
    )
  })
  return onClose
}

const choose = (select: HTMLSelectElement, value: string): void => {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

/** The kind row named `name` — "Session", "Goal", "Flow" or "Team". */
const kindRow = (name: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find((one) =>
    one.textContent?.startsWith(name),
  )
  if (!found) throw new Error(`no kind row named ${name}`)
  return found
}

/** A footer or dialog button by its exact label. */
const button = (label: string): HTMLButtonElement => {
  const found = [...document.querySelectorAll('button')].find((one) => one.textContent === label)
  if (!found) throw new Error(`no button labelled ${label}`)
  return found
}

const runAsSelect = (): HTMLSelectElement => document.querySelector('select')!

const reviewer = (id: string, name: string): AgentEntry => ({
  id,
  origin: 'builtin',
  path: `/app/agents/${id}/AGENT.md`,
  digest: 'd',
  shadows: [],
  problems: [],
  definition: {
    id,
    name,
    description: `${name}.`,
    ceiling: 'edit',
    ceilingFrom: 'permission',
    answers: [],
    produces: [],
    skills: [],
    mcp: [],
    prefer: [{ runtime: 'claude-code' }],
    brief: 'Review.',
  },
})

const PLANS = new Map<string, SeatPlan>([
  [
    'code-reviewer',
    {
      id: 'code-reviewer',
      from: 'prefer',
      winner: 0,
      blocked: null,
      ceiling: { level: 'edit', hold: 'asked' },
      candidates: [{ seat: { runtime: 'claude-code' }, label: 'Claude', runtimeName: 'Claude', state: 'taken', reason: null, fix: null }],
    },
  ],
  [
    'judge',
    {
      id: 'judge',
      from: 'prefer',
      winner: null,
      blocked: null,
      ceiling: null,
      candidates: [
        { seat: { runtime: 'cursor' }, label: 'Cursor', runtimeName: 'Cursor', state: 'passed', reason: { kind: 'signedOut' }, fix: { kind: 'signIn', runtime: 'cursor' } },
      ],
    },
  ],
])

it('opens on the Session row focused, selected, and starts a plain draft on Enter', () => {
  const { store } = rig()
  const onClose = render(store)

  const session = kindRow('Session')
  expect(document.activeElement).toBe(session)
  expect(session.getAttribute('aria-checked')).toBe('true')
  expect(button('Start')).toBeTruthy()
  expect(document.querySelector('select')).toBeNull()

  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  expect(store.newDraft).toHaveBeenCalledTimes(1)
  expect(store.startAsAgent).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalled()
})

it('the primary label follows the chosen kind, and Goal opens Goal creation under the open project', async () => {
  const { store } = rig()
  const onClose = render(store)

  act(() => kindRow('Goal').click())
  expect(button('Continue')).toBeTruthy()
  act(() => button('Continue').click())

  const field = document.querySelector<HTMLInputElement>('[aria-label="What finishes this?"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'Ship the release')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => button('Create Goal').click())
  await act(async () => {})

  expect(store.createGoal).toHaveBeenCalledWith({ root: '/repo', sentence: 'Ship the release', checkout: 'shared' })
  expect(store.openGoal).toHaveBeenCalledWith('g1')
  expect(store.newDraft).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalled()
})

it('a double click on a kind row answers and proceeds in one gesture', () => {
  const { store } = rig()
  render(store)

  act(() => kindRow('Goal').click())
  act(() => kindRow('Goal').dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true })))
  expect(document.querySelector<HTMLInputElement>('[aria-label="What finishes this?"]')).not.toBeNull()
})

it('Goal, Flow and Team stay listed but disabled without an open folder, and say why', () => {
  const { store } = rig({ workspace: null })
  render(store)

  for (const name of ['Goal', 'Flow', 'Team']) {
    const row = kindRow(name)
    expect(row.disabled, `${name} should be disabled without a folder`).toBe(true)
    expect(row.textContent).toContain('Open a folder to start one.')
  }
  expect(kindRow('Session').disabled).toBe(false)

  // Session still needs no folder, and Enter still starts a plain draft.
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  expect(store.newDraft).toHaveBeenCalledTimes(1)
})

it('lists every in-force Agent under "Run as", and starting one runs the session as it', () => {
  const { store } = rig({}, [reviewer('code-reviewer', 'Code reviewer'), reviewer('judge', 'Judge')], PLANS)
  const onClose = render(store)

  const select = runAsSelect()
  const optionLabels = [...select.options].map((one) => one.textContent)
  expect(optionLabels).toContain('Plain session')
  expect(optionLabels).toContain('Code reviewer')

  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, 'code-reviewer')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(document.body.textContent).toContain('It would sit on Claude.')

  act(() => button('Start').click())
  expect(store.startAsAgent).toHaveBeenCalledWith('code-reviewer')
  expect(store.newDraft).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalled()
})

it('a refused Agent stays choosable, is marked in the list, says why once under it, and still starts to show why', () => {
  const { store } = rig({}, [reviewer('judge', 'Judge')], PLANS)
  render(store)

  const select = runAsSelect()
  const judgeOption = [...select.options].find((one) => one.value === 'judge')!
  expect(judgeOption.textContent).toContain('can’t start here')
  expect(judgeOption.textContent).not.toContain('Cursor is signed out')

  act(() => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, 'judge')
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(document.body.textContent?.split('Cursor is signed out').length).toBe(2)

  act(() => button('Start').click())
  expect(store.startAsAgent).toHaveBeenCalledWith('judge')
})

it('"Run as" stays off the page when no Agent is in force', () => {
  const { store } = rig()
  render(store)
  expect(document.querySelector('select')).toBeNull()
})

it('"Manage Agents…" closes the dialog and opens the Agents window, not a session\'s side view', () => {
  vi.mocked(shell.openAgents).mockClear()
  const { store } = rig()
  const onClose = render(store)
  act(() => button('Manage Agents…').click())
  expect(shell.openAgents).toHaveBeenCalledTimes(1)
  expect(store.showView).not.toHaveBeenCalled()
  expect(onClose).toHaveBeenCalled()
})

/*
 * #870: focusing the selected kind must never scroll the dialog, and a later
 * render must never pull focus back to it once a person has moved on.
 */
it('opens focused on Session without scrolling, and leaves focus where a person moved it', () => {
  const spy = vi.spyOn(HTMLElement.prototype, 'focus')
  const { store } = rig({}, [reviewer('code-reviewer', 'Code reviewer')], PLANS)
  render(store)
  expect(document.activeElement).toBe(kindRow('Session'))
  const call = spy.mock.calls.find(([options]) => (options as FocusOptions | undefined)?.preventScroll === true)
  expect(call, `focus() was called as: ${JSON.stringify(spy.mock.calls)}`).toBeDefined()
  spy.mockRestore()

  const select = runAsSelect()
  act(() => select.focus())
  render(store)
  expect(document.activeElement).toBe(select)
})

it('Enter with Agents listed still starts a plain session while Plain session is chosen', () => {
  const { store } = rig({}, [reviewer('code-reviewer', 'Code reviewer')], PLANS)
  render(store)
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
  })
  expect(store.newDraft).toHaveBeenCalledTimes(1)
  expect(store.startAsAgent).not.toHaveBeenCalled()
})

it('an Agent that leaves the roster is not started behind the dialog\'s back', () => {
  const agent = reviewer('code-reviewer', 'Code reviewer')
  const first = rig({}, [agent, reviewer('judge', 'Judge')], PLANS)
  render(first.store)
  choose(runAsSelect(), 'code-reviewer')

  const later = rig({}, [reviewer('judge', 'Judge')], PLANS)
  render(later.store)
  expect(runAsSelect().value).toBe('plain')
  act(() => button('Start').click())
  expect(later.store.startAsAgent).not.toHaveBeenCalled()
  expect(later.store.newDraft).toHaveBeenCalledTimes(1)
})

it('an Agent whose seat check has not come back says what it does, never "undefined"', () => {
  const { store } = rig({}, [reviewer('fresh', 'Fresh reviewer')], new Map())
  render(store)
  choose(runAsSelect(), 'fresh')
  expect(document.body.textContent).toContain('Fresh reviewer.')
  expect(document.body.textContent).not.toContain('undefined')
  expect(document.body.textContent).not.toContain('null')
})

it('a kind that needs a folder falls back to Session when the folder goes away', () => {
  const withFolder = rig()
  render(withFolder.store)
  act(() => kindRow('Goal').click())
  expect(button('Continue')).toBeTruthy()

  const noFolder = rig({ workspace: null })
  render(noFolder.store)
  expect(kindRow('Session').getAttribute('aria-checked')).toBe('true')
  act(() => button('Start').click())
  expect(noFolder.store.newDraft).toHaveBeenCalledTimes(1)
})

/*
 * A flow starts exactly one Goal through `flow/start-goal`: no bare Goal is
 * ever made first and a flow started into it after, which is the old room
 * path this dialog no longer takes.
 */

const FLOW: FlowEntry = { id: 'fix', origin: 'project', path: '.harnessdesk/flows/fix.yml', name: 'Fix', description: null, format: 'agents', problem: null, shadows: [] }
const FLOW_PREVIEW: FlowPreview = {
  token: 'tok-1',
  compiled: { document: { format: 'agents', flow: { version: 2, name: 'Fix', inputs: [], roles: [], rules: [], seed: { role: 'fixer', title: 'Go' }, messaging: 'board-only', wait: 240 } }, bindings: [], problems: [] },
  seats: [], commands: [], guards: [], messaging: 'board-only', problems: [],
}
const FLOW_EXECUTION: FlowExecution = {
  version: 2, id: 'run-1', goal: 'goal-1', document: FLOW_PREVIEW.compiled.document, state: 'running', rounds: [], operations: [], legacyRun: null, reason: null,
}

it('flow starts exactly one Goal through its host operation', async () => {
  const { store } = rig()
  vi.mocked(store.flowCatalog).mockResolvedValue([FLOW])
  vi.mocked(store.flowSource).mockResolvedValue('version: 2\nname: Fix\n')
  vi.mocked(store.previewFlow).mockResolvedValue(FLOW_PREVIEW)
  vi.mocked(store.startFlowGoal).mockResolvedValue(FLOW_EXECUTION)
  const onClose = render(store)

  act(() => kindRow('Flow').click())
  act(() => button('Continue').click())
  await act(async () => {})
  const flowSelect = document.querySelector('select') as HTMLSelectElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(flowSelect, 'fix')
    flowSelect.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {})

  const field = document.querySelector<HTMLInputElement>('[aria-label="What finishes this?"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'Ship the fix')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => button('Start').click())
  await act(async () => {})

  expect(store.startFlowGoal).toHaveBeenCalledWith({ root: '/repo', source: 'version: 2\nname: Fix\n', token: 'tok-1', sentence: 'Ship the fix', vars: {} })
  expect(store.createGoal).not.toHaveBeenCalled()
  expect(store.openGoal).toHaveBeenCalledWith('goal-1')
  expect(onClose).toHaveBeenCalled()
})

/*
 * An old-format flow cannot start a new Goal — only an Agent-format flow
 * can — so its Start stays greyed with the reason beside it, never a Start
 * that fails after it is pressed. Even a host that still hands the old
 * format a preview token does not light it.
 */
it('an old-format flow greys Start and says to update it, rather than a Start that fails', async () => {
  const { store } = rig()
  const LEGACY: FlowEntry = { ...FLOW, id: 'old', name: 'Old', format: 'legacy' }
  vi.mocked(store.flowCatalog).mockResolvedValue([LEGACY])
  vi.mocked(store.flowSource).mockResolvedValue('name: Old\nroles:\n  w: { kind: agent, seat: fake, order: Work }\nseed: { role: w, title: W }\n')
  vi.mocked(store.previewFlow).mockResolvedValue({
    ...FLOW_PREVIEW,
    token: 'tok-legacy',
    compiled: { document: { format: 'legacy', flow: { name: 'Old', roles: [], rules: [], inputs: [], seed: { role: 'w', title: 'W' }, wait: 240 } }, bindings: [], problems: [] },
  } as unknown as FlowPreview)
  render(store)

  act(() => kindRow('Flow').click())
  act(() => button('Continue').click())
  await act(async () => {})
  const flowSelect = document.querySelector('select') as HTMLSelectElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(flowSelect, 'old')
    flowSelect.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await act(async () => {})
  const field = document.querySelector<HTMLInputElement>('[aria-label="What finishes this?"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(field, 'Ship the fix')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })

  const start = button('Start')
  expect(start.disabled).toBe(true)
  expect(document.body.textContent).toContain('Update it from the project’s Flows list before it can start a Goal here')
  act(() => start.click())
  await act(async () => {})
  expect(store.startFlowGoal).not.toHaveBeenCalled()
})
