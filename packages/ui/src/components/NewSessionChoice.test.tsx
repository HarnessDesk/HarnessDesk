import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntry, FlowEntry, FlowExecution, FlowPreview, SeatPlan } from '@harnessdesk/protocol'

import { ShellProvider, type ShellActions } from '../panels/views'
import { StoreProvider } from '../state/context'
import { AppStore, emptySnapshot, type AppSnapshot } from '../state/store'
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
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), snapshot)
  vi.spyOn(store.transport, 'request').mockImplementation((async () => []) as never)
  vi.spyOn(store, 'newDraft').mockImplementation(() => {})
  vi.spyOn(store, 'createGoal').mockResolvedValue({ goal: { id: 'g1' } } as never)
  vi.spyOn(store, 'openGoal').mockImplementation(() => {})
  vi.spyOn(store, 'loadAgents').mockResolvedValue(undefined)
  vi.spyOn(store, 'startAsAgent').mockResolvedValue(null)
  vi.spyOn(store, 'showView').mockImplementation(() => {})
  vi.spyOn(store, 'flowCatalog').mockResolvedValue([])
  vi.spyOn(store, 'agentsIn').mockResolvedValue([])
  vi.spyOn(store, 'flowSource').mockResolvedValue('')
  vi.spyOn(store, 'previewFlow').mockResolvedValue(null as never)
  vi.spyOn(store, 'startFlowGoal').mockResolvedValue(null as never)
  return { store }
}

const shell: ShellActions = {
  chooseProject: vi.fn(),
  signIn: vi.fn(),
  openUsage: vi.fn(),
  openRuntimes: vi.fn(),
  openAgents: vi.fn(), reviewImports: () => {},
}

const render = (store: AppStore, onClose = vi.fn(), initialKind?: 'session' | 'goal' | 'flow' | 'team'): typeof onClose => {
  act(() => {
    root.render(
      <ShellProvider actions={shell}>
        <StoreProvider store={store}>
          <NewSessionChoice onClose={onClose} initialKind={initialKind} />
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

it.each(['goal', 'flow', 'team'] as const)('%s opens the same New Team dialog', async kind => {
  const { store } = rig()
  render(store, vi.fn(), kind)
  act(() => button('Continue').click())
  await act(async () => {})
  expect(document.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('New Team')
  expect(document.querySelector('[aria-label="Search Flows"]')).not.toBeNull()
  expect(document.querySelector('textarea[aria-label="What should they do?"]')).not.toBeNull()
})

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

  const field = document.querySelector<HTMLTextAreaElement>('[aria-label="What should they do?"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(field, 'Ship the release')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  act(() => button('Start Team').click())
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
  expect(document.querySelector<HTMLInputElement>('[aria-label="What should they do?"]')).not.toBeNull()
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
  expect(optionLabels).toContain('Default runtime')
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

it('opens with the requested starting kind selected and describes the work in plain words', () => {
  const { store } = rig()
  render(store, vi.fn(), 'goal')
  expect(kindRow('Goal').getAttribute('aria-checked')).toBe('true')
  expect(kindRow('Goal').textContent).toContain('Several agents work toward one result, with progress tracked together.')
  expect(kindRow('Flow').textContent).toContain('Agents take turns: one writes, another reviews.')
  expect(kindRow('Team').textContent).toContain('Starts the helpers this project defines.')
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

it('Enter with Agents listed still starts a plain session while Default runtime is chosen', () => {
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

it('a kind that needs a folder stays selected when no folder is open', () => {
  const noFolder = rig({ workspace: null })
  render(noFolder.store, vi.fn(), 'goal')
  expect(kindRow('Goal').getAttribute('aria-checked')).toBe('true')
  expect(button('Continue').disabled).toBe(true)
  expect(noFolder.store.newDraft).not.toHaveBeenCalled()
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

const installFlow = (store: AppStore, preview: FlowPreview = FLOW_PREVIEW, entry: FlowEntry = FLOW) => {
  vi.mocked(store.flowCatalog).mockResolvedValue([entry])
  const source = 'version: 2\nname: Fix\n'
  vi.mocked(store.flowSource).mockResolvedValue(source)
  let current = preview
  vi.mocked(store.transport.request).mockImplementation((async (method: string, input: { vars?: Record<string, string>; source?: string }) => {
    if (method === 'authoring/start/preview') return { flow: current, source: input.source, vars: input.vars, sentence: 'Fix this project', goal: null, target: { label: 'this project', base: null, head: null, dirty: false, independence: 'unknown' } }
    return []
  }) as never)
  vi.mocked(store.startFlowGoal).mockResolvedValue(FLOW_EXECUTION)
  return { source, setPreview: (next: FlowPreview) => { current = next } }
}

const typeTask = async (value: string) => {
  const area = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="What should they do?"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

it('Flow uses the shared strict preview and starts exactly one Team', async () => {
  const { store } = rig()
  if (FLOW_PREVIEW.compiled.document.format !== 'agents') throw new Error('Expected Agent flow')
  const preview = { ...FLOW_PREVIEW, compiled: { ...FLOW_PREVIEW.compiled, document: { format: 'agents' as const, flow: { ...FLOW_PREVIEW.compiled.document.flow, inputs: [{ id: 'task', label: 'Task' }] } } } }
  const { source } = installFlow(store, preview)
  const onClose = render(store, vi.fn(), 'flow')
  act(() => button('Continue').click())
  await act(async () => {})
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Fix"]')!.click())
  await typeTask('Fix the ticket')
  const done = document.querySelector<HTMLInputElement>('[aria-label="Done when · optional"]')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(done, 'Ship the fix')
    done.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await act(async () => button('Start Team').click())
  expect(store.startFlowGoal).toHaveBeenCalledExactlyOnceWith({ root: '/repo', source, token: 'tok-1', sentence: 'Ship the fix', vars: { task: 'Fix the ticket' } })
  expect(store.createGoal).not.toHaveBeenCalled()
  expect(store.openGoal).toHaveBeenCalledWith('goal-1')
  expect(onClose).toHaveBeenCalledOnce()
})

it('Start Team waits for an imported brief and its strict preview', async () => {
  const { store } = rig()
  if (FLOW_PREVIEW.compiled.document.format !== 'agents') throw new Error('Expected Agent flow')
  const preview: FlowPreview = { ...FLOW_PREVIEW, compiled: { ...FLOW_PREVIEW.compiled, document: { format: 'agents', flow: { ...FLOW_PREVIEW.compiled.document.flow, inputs: [{ id: 'task', label: 'Task', default: 'Fix the ticket' }, { id: 'brief', label: 'Brief', default: 'Previous brief' }] } } } }
  const { source } = installFlow(store, preview)
  const onClose = render(store, vi.fn(), 'flow')
  act(() => button('Continue').click())
  await act(async () => {})
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Fix"]')!.click())
  act(() => button('Details').click())
  expect(button('Start Team').disabled).toBe(false)
  let resolveFile!: (text: string) => void
  const file = new File(['New file brief'], 'brief.txt', { type: 'text/plain' })
  Object.defineProperty(file, 'text', { value: () => new Promise<string>(resolve => { resolveFile = resolve }) })
  const picker = document.querySelector<HTMLInputElement>('input[type="file"]')!
  await act(async () => {
    Object.defineProperty(picker, 'files', { configurable: true, value: [file] })
    picker.dispatchEvent(new Event('change', { bubbles: true }))
  })
  expect(button('Start Team').disabled).toBe(true)
  let resolvePreview!: (value: unknown) => void
  const original = vi.mocked(store.transport.request).getMockImplementation()!
  vi.mocked(store.transport.request).mockImplementationOnce((async () => new Promise(resolve => { resolvePreview = resolve })) as never)
  await act(async () => resolveFile('New file brief'))
  expect(button('Start Team').disabled).toBe(true)
  await act(async () => resolvePreview({ flow: { ...preview, token: 'file-token' }, source, vars: { task: 'Fix the ticket', brief: 'New file brief' }, sentence: 'Fix this project', goal: null, target: { label: 'this project', base: null, head: null, dirty: false, independence: 'unknown' } }))
  vi.mocked(store.transport.request).mockImplementation(original)
  await act(async () => button('Start Team').click())
  expect(store.startFlowGoal).toHaveBeenCalledExactlyOnceWith({ root: '/repo', source, token: 'file-token', sentence: 'Fix the ticket', vars: { task: 'Fix the ticket', brief: 'New file brief' } })
  expect(onClose).toHaveBeenCalledOnce()
})

it('an old-format Flow cannot start a Team from the shared dialog', async () => {
  const { store } = rig()
  const legacy: FlowPreview = { ...FLOW_PREVIEW, compiled: { document: { format: 'legacy', flow: { name: 'Old', roles: [], rules: [], inputs: [], seed: { role: 'w', title: 'W' }, wait: 240 } }, bindings: [], problems: [] } }
  installFlow(store, legacy, { ...FLOW, id: 'old', name: 'Old', format: 'legacy' })
  render(store, vi.fn(), 'flow')
  act(() => button('Continue').click())
  await act(async () => {})
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Old"]')!.click())
  expect(button('Start Team').disabled).toBe(true)
  expect(document.body.textContent).toContain('Update this Flow from its Flows page')
  expect(store.startFlowGoal).not.toHaveBeenCalled()
})
