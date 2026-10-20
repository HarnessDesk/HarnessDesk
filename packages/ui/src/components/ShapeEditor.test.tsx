import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { parseClientMessage, type AgentEntry, type AuthoringDocument, type FlowPolicy, type FrontDoorPreview, type HostMethodName } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { ShapeEditor } from './ShapeEditor'
import { canvasDOM } from '../test/flow-canvas-dom'
import { DestinationPageScope } from '../panels/destination-page'
import { TopBarProvider, TopBarOutlet } from '../panels/top-bar'

/**
 * The ordered editor: every step and rule edit renders through the one host
 * call (`authoring/shape/render`) rather than a private serializer of its
 * own, and the exact string that call returns is what Start would send. The
 * fake `authoring/shape/render` here stands in for `writeShape` — it turns a
 * policy into an opaque, unique string, and `authoring/start/preview`'s fake
 * parses that same string back into a policy, so a round trip through this
 * pair behaves like the real host without needing YAML in a UI test.
 */
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  canvasDOM()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks(); vi.unstubAllGlobals()
})

const AGENT: AgentEntry = {
  id: 'reviewer', origin: 'project', path: '.harnessdesk/agents/reviewer/AGENT.md', digest: 'd', shadows: [], problems: [],
  definition: { id: 'reviewer', name: 'Reviewer', description: null, ceiling: 'read', ceilingFrom: 'ceiling', answers: ['approve'], produces: [], skills: [], mcp: [], prefer: [], brief: 'b' },
}

const previewFor = (policy: FlowPolicy, over: Partial<FrontDoorPreview> = {}): FrontDoorPreview => ({
  flow: {
    token: 'tok', compiled: { document: { format: 'agents', flow: policy }, bindings: [], problems: [] },
    seats: [], commands: [], guards: [], messaging: policy.messaging, problems: [],
  },
  target: { label: 'this project', base: null, head: null, dirty: false, independence: 'unknown' },
  vars: {}, source: JSON.stringify(policy), sentence: policy.name, goal: null,
  ...over,
})

/** A fake host: `authoring/shape/render` returns the policy as an opaque JSON string, and `authoring/start/preview` parses that same string back. */
const fakeHost = (store: AppStore, roster: readonly AgentEntry[] = [AGENT]) =>
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'authoring/shape/render') {
      const { policy } = params as { policy: FlowPolicy }
      return { source: JSON.stringify(policy), issues: [] }
    }
    if (method === 'authoring/start/preview') {
      const { source, vars } = params as { source: string; vars: Readonly<Record<string, string>> }
      try {
        const policy = JSON.parse(source) as FlowPolicy
        // Echoes the vars it was asked to check, exactly like the real host —
        // never a fixed `{}` regardless of what was sent, which is what let a
        // typed value pass every dry-run assertion here while still never
        // reaching `flow/start-goal` for real.
        return previewFor(policy, { vars })
      } catch {
        // The real host never returns a null document, even for an unreadable
        // source — an empty placeholder in the old (never-startable) format,
        // exactly `emptyPreview` in flow-preview.ts.
        return {
          flow: {
            token: null,
            compiled: { document: { format: 'legacy', flow: { name: '', roles: [], rules: [], inputs: [], seed: { role: '', title: '' }, wait: 0 } }, bindings: [], problems: [] },
            seats: [], commands: [], guards: [], messaging: 'board-only', problems: [{ level: 'error', at: 'file', text: 'not readable' }],
          },
          target: { label: 'this project', base: null, head: null, dirty: false, independence: 'unknown' },
          vars: {}, source, sentence: '', goal: null,
        }
      }
    }
    if (method === 'agent/list') return roster
    if (method === 'flow/start-goal') return { version: 2, id: 'run-1', goal: 'goal-1', document: { format: 'agents', flow: JSON.parse((params as { source: string }).source) }, state: 'running', rounds: [], operations: [], legacyRun: null, reason: null }
    return null
  }) as never)

const render = (store: AppStore) => {
  const onClose = vi.fn()
  const onStarted = vi.fn()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ShapeEditor root="/repo" context={{ kind: 'project', root: '/repo' }} onClose={onClose} onStarted={onStarted} />
      </StoreProvider>,
    )
  })
  return { onClose, onStarted }
}

const renderWithSource = (store: AppStore, initialSource: string) => {
  const onClose = vi.fn()
  const onStarted = vi.fn()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ShapeEditor root="/repo" context={{ kind: 'project', root: '/repo' }} initialSource={initialSource} onClose={onClose} onStarted={onStarted} />
      </StoreProvider>,
    )
  })
  return { onClose, onStarted }
}

/**
 * A host double that actually enforces the binding the real one does: every
 * `authoring/start/preview` mints a fresh token bound to the exact
 * `(source, vars)` it was asked to check, and `flow/start-goal` refuses any
 * redemption whose `(source, vars)` do not match what that exact token was
 * minted for — never merely echoing back whatever the caller sends.
 */
const bindingFakeHost = (store: AppStore, roster: readonly AgentEntry[] = [AGENT]) => {
  const bound = new Map<string, { readonly source: string; readonly vars: Readonly<Record<string, string>> }>()
  let tokenSeq = 0
  return vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'authoring/shape/render') {
      const { policy } = params as { policy: FlowPolicy }
      return { source: JSON.stringify(policy), issues: [] }
    }
    if (method === 'authoring/start/preview') {
      const { source, vars } = params as { source: string; vars: Readonly<Record<string, string>> }
      try {
        const policy = JSON.parse(source) as FlowPolicy
        const token = `tok-${++tokenSeq}`
        bound.set(token, { source, vars: { ...vars } })
        return previewFor(policy, { flow: { ...previewFor(policy).flow, token }, vars })
      } catch {
        return {
          flow: {
            token: null,
            compiled: { document: { format: 'legacy', flow: { name: '', roles: [], rules: [], inputs: [], seed: { role: '', title: '' }, wait: 0 } }, bindings: [], problems: [] },
            seats: [], commands: [], guards: [], messaging: 'board-only', problems: [{ level: 'error', at: 'file', text: 'not readable' }],
          },
          target: { label: 'this project', base: null, head: null, dirty: false, independence: 'unknown' },
          vars: {}, source, sentence: '', goal: null,
        }
      }
    }
    if (method === 'agent/list') return roster
    if (method === 'flow/start-goal') {
      const { token, source, vars } = params as { token: string; source: string; vars?: Readonly<Record<string, string>> }
      const entry = bound.get(token)
      const matches = entry !== undefined && entry.source === source && JSON.stringify(entry.vars) === JSON.stringify(vars ?? {})
      if (!matches) throw new Error('This flow or its seating changed. Review the dry run again before starting.')
      return { version: 2, id: 'run-1', goal: 'goal-1', document: { format: 'agents', flow: JSON.parse(source) }, state: 'running', rounds: [], operations: [], legacyRun: null, reason: null }
    }
    return null
  }) as never)
}

const settle = () => act(async () => {})
const button = (label: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll('button')].find((one) => one.textContent?.trim() === label)
  if (!found) throw new Error(`no button “${label}”`)
  return found
}
const byAriaLabel = (label: string): HTMLElement => {
  const found = [...document.body.querySelectorAll('[aria-label]')].find((one) => one.getAttribute('aria-label') === label)
  if (!found) throw new Error(`no element with aria-label “${label}”`)
  return found as HTMLElement
}
/** A row's overflow menu item — Base UI's `Menu.Item` renders a `<div role="menuitem">` by default, never a `<button>`. */
const menuItem = (label: string): HTMLElement => {
  const found = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find((one) => one.querySelector('[data-menu-label]')?.textContent?.trim() === label)
  if (!found) throw new Error(`no menu item “${label}”`)
  return found as HTMLElement
}

it('adding an Agent, a check and a person step, then a rule, renders through the one host call — never a private grammar', async () => {
  const store = new AppStore('ws://localhost:0/')
  const spy = fakeHost(store)

  render(store)
  await settle()

  act(() => button('Agent').click())
  await settle()
  act(() => button('Check').click())
  await settle()
  act(() => button('Person').click())
  await settle()
  act(() => button('Add a rule').click())
  await settle()

  const renders = spy.mock.calls.filter((call) => call[0] === 'authoring/shape/render')
  expect(renders.length).toBeGreaterThan(0)
  const last = renders.at(-1)![1] as { policy: FlowPolicy }
  // Every step kind landed on the one policy object, and a rule was added —
  // exactly what the ordered editor is for, with no engine special case.
  const kinds = last.policy.roles.map((role) => role.kind).sort()
  expect(kinds).toEqual(['agent', 'check', 'person', 'person'].sort())
  expect(last.policy.rules.length).toBe(1)
})

it('reordering roles keeps a rule pointed at the same role, never at a position', async () => {
  const store = new AppStore('ws://localhost:0/')
  const spy = fakeHost(store)

  render(store)
  await settle()

  act(() => button('Agent').click())
  await settle()
  act(() => button('Add a rule').click())
  await settle()

  const beforeMove = (spy.mock.calls.filter((call) => call[0] === 'authoring/shape/render').at(-1)![1] as { policy: FlowPolicy }).policy
  const rule = beforeMove.rules[0]!
  const targetRoleId = rule.then.role

  // Move the seed role ("review", index 0) down past the added agent. Move
  // up/down live behind each row's own "… actions" overflow menu now, not as
  // standalone buttons — open it, then act on the item inside.
  act(() => byAriaLabel('review actions').click())
  await settle()
  act(() => menuItem('Move down').click())
  await settle()

  const afterMove = (spy.mock.calls.filter((call) => call[0] === 'authoring/shape/render').at(-1)![1] as { policy: FlowPolicy }).policy
  const movedRule = afterMove.rules.find((one) => one.id === rule.id)!
  expect(movedRule.then.role).toBe(targetRoleId)
  expect(movedRule.on).toBe(rule.on)
  // The role set is unchanged, only reordered.
  expect([...afterMove.roles.map((one) => one.id)].sort()).toEqual([...beforeMove.roles.map((one) => one.id)].sort())
})

it('an unreadable raw source keeps the last valid steps and disables Start, without discarding what was typed', async () => {
  const store = new AppStore('ws://localhost:0/')
  fakeHost(store)

  render(store)
  await settle()
  expect(button('Start').hasAttribute('disabled')).toBe(false)

  act(() => button('Source').click())
  await settle()
  const textarea = document.body.querySelector('textarea[aria-describedby], textarea') as HTMLTextAreaElement
  expect(textarea).toBeTruthy()
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(textarea, 'not json at all {{{')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()

  expect(document.body.textContent).toContain('This source does not parse yet')
  expect(button('Start').hasAttribute('disabled')).toBe(true)
  // Switching back to Steps still shows the last valid form, not a blank one.
  act(() => button('Steps').click())
  await settle()
  expect(document.body.textContent).toContain('Outcomes')
})

it('the plain path never opens this editor or calls its authoring methods', async () => {
  // ShapeEditor itself is only ever mounted by an explicit "Your own shape…"
  // action; this proves that mounting anything else (nothing, here) makes no
  // authoring/shape or authoring/read call at all.
  const store = new AppStore('ws://localhost:0/')
  const spy = vi.spyOn(store.transport, 'request')
  act(() => {
    root.render(<StoreProvider store={store}><div /></StoreProvider>)
  })
  await settle()
  expect(spy.mock.calls.filter((call) => String(call[0]).startsWith('authoring/'))).toHaveLength(0)
})

it('Steps, Graph and Source all read one document, and Graph is absent until its tab is opened', async () => {
  const store = new AppStore('ws://localhost:0/')
  fakeHost(store)
  render(store)
  await settle()

  // No graph node exists yet — its own read/edit surfaces mount only once selected.
  const graphNode = () => Boolean(document.body.querySelector('.react-flow__node[data-id="review"]'))
  expect(graphNode()).toBe(false)

  act(() => button('Agent').click())
  await settle()
  const stepsPolicy = document.body.textContent
  expect(stepsPolicy).toContain('Uses')

  await act(async () => { button('Graph').click(); await import('../design/patterns/FlowCanvas/Engine') })
  await settle()
  // The same two roles (the seed person and the agent just added) are visible on the graph.
  await act(async () => { await vi.waitFor(() => expect(graphNode()).toBe(true)) })

  act(() => button('Source').click())
  await settle()
  const textarea = document.body.querySelector('textarea') as HTMLTextAreaElement
  const parsed = JSON.parse(textarea.value) as FlowPolicy
  expect(parsed.roles.map((role) => role.kind).sort()).toEqual(['agent', 'person'])

  act(() => button('Steps').click())
  await settle()
  expect(document.body.textContent).toContain('Uses')
})

it('a step reads as a form, not a toy: no bare per-row move buttons, no duplicate "Steps" heading, and fields sit in a padded card', async () => {
  const store = new AppStore('ws://localhost:0/')
  fakeHost(store)
  render(store)
  await settle()

  // Move up/down live behind each row's own overflow menu, never as
  // standing buttons a person has to scan past on every row.
  expect(document.body.querySelectorAll('button[aria-label^="Move"]')).toHaveLength(0)
  expect([...document.body.querySelectorAll('button')].some((one) => one.textContent?.trim() === 'Move up')).toBe(false)
  expect([...document.body.querySelectorAll('button')].some((one) => one.textContent?.trim() === 'Move down')).toBe(false)

  // The Tabs trigger says "Steps" once; there is no second, duplicate
  // section heading repeating it right underneath.
  const stepsHeadings = [...document.body.querySelectorAll('[data-slot="section-name"]')].filter((one) => one.textContent?.trim() === 'Steps')
  expect(stepsHeadings).toHaveLength(0)

  // The step's own fields (Step name, Kind, …) sit inside a padded card,
  // not bare against the row list's edge.
  const stepNameLabel = [...document.body.querySelectorAll('label')].find((one) => one.textContent?.startsWith('Step name'))
  expect(stepNameLabel?.closest('[data-slot="card"]')).not.toBeNull()
})

it('the footer has exactly one primary action; the rest are secondary, an overflow, or quiet', async () => {
  const store = new AppStore('ws://localhost:0/')
  fakeHost(store)
  render(store)
  await settle()

  const footer = document.body.querySelector('[data-slot="dialog-footer"]')!
  const primaries = footer.querySelectorAll('[data-slot="button"][data-variant="default"]')
  expect(primaries).toHaveLength(1)
  expect(primaries[0]?.textContent?.trim()).toBe('Start')

  // A dialog footer's own rule (design/usage.ts, slot "dialogFooter") is one
  // ink action and every other button `secondary` — never `ghost`, which
  // reads as a link in a footer where every choice should look equally
  // pressable. Close is the ordinary, enclosed action the footer already is.
  expect(button('Close').getAttribute('data-variant')).toBe('secondary')

  // "Every time…" stands in the footer itself, as an ordinary secondary
  // button — a menu the design audit's footer reader cannot see into (a
  // `DropdownMenu`'s trigger is a `render` prop, not readable JSX) is not a
  // shape a dialog footer's one-filled-act rule can hold.
  expect(button('Every time…').getAttribute('data-variant')).toBe('secondary')
})

it('the seed preview follows input defaults, edits and clearing in the shape editor', async () => {
  const policy: FlowPolicy = {
    version: 2, name: 'Review', inputs: [{ id: 'task', label: 'Task', default: 'Initial task' }],
    roles: [], seed: { role: 'reviewer', title: '{{ task }}' },
    rules: [{ id: 'check', on: 'reviewer', then: { role: 'verify', title: 'Check the task' } }],
    messaging: 'board-only', wait: 240,
  }
  const store = new AppStore('ws://localhost:0/')
  fakeHost(store)
  renderWithSource(store, JSON.stringify(policy))
  await settle()
  const rounds = () => document.body.querySelector('[aria-label="Rounds and rules"]')!.textContent
  expect(rounds()).toContain('Seed round — Initial task')
  const label = [...document.body.querySelectorAll('label')].find(one => one.textContent === 'Task')!
  const field = document.getElementById(label.htmlFor) as HTMLInputElement
  for (const [value, expected] of [['Edited task', 'Edited task'], ['Keep {{task}} literal', 'Keep {{task}} literal'], ['', 'Task']]) {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(field, value)
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await settle()
    expect(rounds()).toContain(`Seed round — ${expected}`)
  }
})

it('a typed input survives a dry run and reaches Start, never reset to its default', async () => {
  const store = new AppStore('ws://localhost:0/')
  const spy = fakeHost(store)
  render(store)
  await settle()

  // The blank draft's own seed input, "Task", is here from the first dry run.
  const label = [...document.body.querySelectorAll('label')].find((one) => one.textContent === 'Task')!
  const field = document.getElementById(label.getAttribute('for')!) as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(field, 'typed value')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()

  // The field itself was not reset by the dry run its own edit triggered.
  expect(field.value).toBe('typed value')

  // The dry run this typing triggered carried the typed value, never `{}`.
  const previews = spy.mock.calls.filter((call) => call[0] === 'authoring/start/preview')
  const lastPreview = previews.at(-1)![1] as { vars: Record<string, string> }
  expect(lastPreview.vars.task).toBe('typed value')

  act(() => button('Start').click())
  await settle()
  const started = spy.mock.calls.find((call) => call[0] === 'flow/start-goal')![1] as { vars?: Record<string, string> }
  expect(started.vars?.task).toBe('typed value')
})

it('choosing a different step never wipes a typed input that step did not touch', async () => {
  const store = new AppStore('ws://localhost:0/')
  fakeHost(store)
  render(store)
  await settle()

  const label = [...document.body.querySelectorAll('label')].find((one) => one.textContent === 'Task')!
  const field = document.getElementById(label.getAttribute('for')!) as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(field, 'kept')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()

  // Adding a step re-renders and re-previews the whole policy — the typed
  // value must still read back from the same field afterwards.
  act(() => button('Agent').click())
  await settle()

  const fieldAgain = document.getElementById(label.getAttribute('for')!) as HTMLInputElement
  expect(fieldAgain.value).toBe('kept')
})

it('an input nobody typed into starts on its own default, bound to the SAME token the defaulted preview minted — never the throwaway one sent before it', async () => {
  const policy: FlowPolicy = {
    version: 2, name: 'P', inputs: [{ id: 'topic', label: 'Topic', default: 'dflt' }],
    roles: [{ id: 'person', kind: 'person', outcomes: ['done'] }], rules: [], seed: { role: 'person', title: 't' },
    messaging: 'board-only', wait: 60,
  }
  const store = new AppStore('ws://localhost:0/')
  const spy = bindingFakeHost(store)
  const { onStarted } = renderWithSource(store, JSON.stringify(policy))
  await settle()

  // Never typed into "Topic" — Start must still work, redeeming whatever the
  // *last* (defaulted) preview minted rather than the first, throwaway one
  // taken of the empty vars nobody asked for.
  expect(button('Start').hasAttribute('disabled')).toBe(false)
  act(() => button('Start').click())
  await settle()

  expect(onStarted).toHaveBeenCalled()
  const starts = spy.mock.calls.filter((call) => call[0] === 'flow/start-goal')
  expect(starts).toHaveLength(1)
  expect((starts[0]![1] as { vars?: Record<string, string> }).vars).toEqual({ topic: 'dflt' })
})

it('Start is disabled while a dry run a var edit triggered is still in flight', async () => {
  const store = new AppStore('ws://localhost:0/')
  fakeHost(store)
  render(store)
  await settle()
  expect(button('Start').hasAttribute('disabled')).toBe(false)

  // A slow second preview, in flight after typing — Start must go back to
  // disabled the instant the edit fires, before that preview answers.
  const stalled: FlowPolicy = {
    version: 2, name: 'Stalled', inputs: [{ id: 'task', label: 'Task' }],
    roles: [{ id: 'review', kind: 'person', outcomes: ['done'] }], rules: [], seed: { role: 'review', title: '{{task}}' },
    messaging: 'board-only', wait: 240,
  }
  let resolveSecond!: (value: unknown) => void
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: string) => {
    if (method === 'authoring/start/preview') return new Promise((resolve) => { resolveSecond = resolve })
    return null
  }) as never)

  const label = [...document.body.querySelectorAll('label')].find((one) => one.textContent === 'Task')!
  const field = document.getElementById(label.getAttribute('for')!) as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(field, 'typed')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(button('Start').hasAttribute('disabled')).toBe(true)

  await act(async () => {
    resolveSecond(previewFor(stalled))
  })
})

it('Start stays disabled through a step edit’s own render round trip, not just its own dry run', async () => {
  const store = new AppStore('ws://localhost:0/')
  fakeHost(store)
  render(store)
  await settle()
  expect(button('Start').hasAttribute('disabled')).toBe(false)

  // A slow `authoring/shape/render` — the render round trip an edited step
  // takes before its own dry run is even asked for. Start must already be
  // disabled for this whole span, not just once the dry run itself starts.
  let resolveRender!: (value: { readonly source: string; readonly issues: readonly unknown[] }) => void
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'authoring/shape/render') return new Promise((resolve) => { resolveRender = resolve as never })
    if (method === 'authoring/start/preview') {
      const { source, vars } = params as { source: string; vars: Readonly<Record<string, string>> }
      const policy = JSON.parse(source) as FlowPolicy
      return previewFor(policy, { vars })
    }
    if (method === 'agent/list') return [AGENT]
    return null
  }) as never)

  act(() => button('Agent').click())
  expect(button('Start').hasAttribute('disabled')).toBe(true)

  const rendered: FlowPolicy = {
    version: 2, name: 'Your own shape', inputs: [{ id: 'task', label: 'Task' }],
    roles: [{ id: 'review', kind: 'person', outcomes: ['done'] }, { id: 'agent-1', kind: 'agent', uses: [], seats: [], isolate: false, grant: 'read', independentOf: [] }],
    rules: [], seed: { role: 'review', title: '{{task}}' }, messaging: 'board-only', wait: 240,
  }
  await act(async () => {
    resolveRender({ source: JSON.stringify(rendered), issues: [] })
  })
  await settle()
  expect(button('Start').hasAttribute('disabled')).toBe(false)
})

it('a stale render answering after a later edit’s own render never re-enables Start — only the latest edit decides', async () => {
  const store = new AppStore('ws://localhost:0/')
  fakeHost(store)
  render(store)
  await settle()
  expect(button('Start').hasAttribute('disabled')).toBe(false)

  const resolvers: ((value: { readonly source: string; readonly issues: readonly unknown[] }) => void)[] = []
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'authoring/shape/render') return new Promise((resolve) => { resolvers.push(resolve as never) })
    if (method === 'authoring/start/preview') {
      const { source, vars } = params as { source: string; vars: Readonly<Record<string, string>> }
      const policy = JSON.parse(source) as FlowPolicy
      return previewFor(policy, { vars })
    }
    if (method === 'agent/list') return [AGENT]
    return null
  }) as never)

  // Two edits land in quick succession — the second (Check) fires before the
  // first (Agent) has answered — and only the second's own render, resolved
  // last, decides.
  act(() => button('Agent').click())
  act(() => button('Check').click())
  expect(button('Start').hasAttribute('disabled')).toBe(true)
  expect(resolvers).toHaveLength(2)

  const agentAnswer: FlowPolicy = {
    version: 2, name: 'Your own shape', inputs: [{ id: 'task', label: 'Task' }],
    roles: [{ id: 'review', kind: 'person', outcomes: ['done'] }, { id: 'agent-1', kind: 'agent', uses: [], seats: [], isolate: false, grant: 'read', independentOf: [] }],
    rules: [], seed: { role: 'review', title: '{{task}}' }, messaging: 'board-only', wait: 240,
  }
  // The stale first render answers, after the second edit already took the
  // sequence — it must change nothing: Start stays disabled for the second
  // edit's own still-pending render.
  await act(async () => {
    resolvers[0]!({ source: JSON.stringify(agentAnswer), issues: [] })
  })
  expect(button('Start').hasAttribute('disabled')).toBe(true)

  const checkAnswer: FlowPolicy = {
    version: 2, name: 'Your own shape', inputs: [{ id: 'task', label: 'Task' }],
    roles: [{ id: 'review', kind: 'person', outcomes: ['done'] }, { id: 'check-1', kind: 'check', check: { run: 'true', timeout: 900, exits: { '0': 'pass' }, otherwise: 'fail' } }],
    rules: [], seed: { role: 'review', title: '{{task}}' }, messaging: 'board-only', wait: 240,
  }
  await act(async () => {
    resolvers[1]!({ source: JSON.stringify(checkAnswer), issues: [] })
  })
  await settle()
  expect(button('Start').hasAttribute('disabled')).toBe(false)
})

it('a var edit while a step edit’s own render is still out never reverts the step — its dry run waits for that edit’s own', async () => {
  const store = new AppStore('ws://localhost:0/')
  fakeHost(store)
  render(store)
  await settle()

  let resolveRender!: (value: { readonly source: string; readonly issues: readonly unknown[] }) => void
  const previews: { readonly source: string; readonly vars: Readonly<Record<string, string>> }[] = []
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'authoring/shape/render') return new Promise((resolve) => { resolveRender = resolve as never })
    if (method === 'authoring/start/preview') {
      const { source, vars } = params as { source: string; vars: Readonly<Record<string, string>> }
      previews.push({ source, vars })
      const policy = JSON.parse(source) as FlowPolicy
      return previewFor(policy, { vars })
    }
    if (method === 'agent/list') return [AGENT]
    return null
  }) as never)

  // A step edit's own render is out — Start is disabled for the whole trip.
  act(() => button('Agent').click())
  expect(button('Start').hasAttribute('disabled')).toBe(true)

  // A var typed while that render is still pending must not fire its own dry
  // run against the pre-edit source: that would preview — and briefly show —
  // the step edit undone, and once the edit's own render lands stale, undone
  // for good.
  const label = [...document.body.querySelectorAll('label')].find((one) => one.textContent === 'Task')!
  const field = document.getElementById(label.getAttribute('for')!) as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(field, 'typed')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(previews).toHaveLength(0)

  const rendered: FlowPolicy = {
    version: 2, name: 'Your own shape', inputs: [{ id: 'task', label: 'Task' }],
    roles: [{ id: 'review', kind: 'person', outcomes: ['done'] }, { id: 'agent-1', kind: 'agent', uses: [], seats: [], isolate: false, grant: 'read', independentOf: [] }],
    rules: [], seed: { role: 'review', title: '{{task}}' }, messaging: 'board-only', wait: 240,
  }
  await act(async () => {
    resolveRender({ source: JSON.stringify(rendered), issues: [] })
  })
  await settle()

  // The step edit's own dry run fired, on its own source, once — and carried
  // the var typed while it was still out.
  expect(previews).toHaveLength(1)
  expect(JSON.parse(previews[0]!.source)).toMatchObject({ roles: [{ id: 'review' }, { id: 'agent-1' }] })
  expect(previews[0]!.vars).toEqual({ task: 'typed' })
  expect(button('Start').hasAttribute('disabled')).toBe(false)
})

it('a superseded step edit answering stale never leaves a var typed afterward unpreviewed — renderPending cannot stick', async () => {
  const store = new AppStore('ws://localhost:0/')
  let resolveRender!: (value: { readonly source: string; readonly issues: readonly unknown[] }) => void
  const previews: { readonly source: string; readonly vars: Readonly<Record<string, string>> }[] = []
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'authoring/shape/render') return new Promise((resolve) => { resolveRender = resolve as never })
    if (method === 'authoring/start/preview') {
      const { source, vars } = params as { source: string; vars: Readonly<Record<string, string>> }
      previews.push({ source, vars })
      const policy = JSON.parse(source) as FlowPolicy
      return previewFor(policy, { vars })
    }
    if (method === 'agent/list') return [AGENT]
    return null
  }) as never)

  const startPolicy: FlowPolicy = {
    version: 2, name: 'Review', inputs: [{ id: 'task', label: 'Task' }],
    roles: [{ id: 'review', kind: 'person', outcomes: ['done'] }], rules: [], seed: { role: 'review', title: '{{task}}' },
    messaging: 'board-only', wait: 240,
  }
  renderWithSource(store, JSON.stringify(startPolicy))
  await settle()
  const afterMount = previews.length

  // A step edit's own render goes out and hangs.
  act(() => button('Agent').click())
  expect(button('Start').hasAttribute('disabled')).toBe(true)

  // An unrelated dry run — the raw Source tab, which calls `runDryRun`
  // directly and shares its sequence with every edit — settles first and
  // bumps that shared sequence, without a second step edit ever existing.
  act(() => button('Source').click())
  await settle()
  const textarea = document.body.querySelector('textarea') as HTMLTextAreaElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(textarea, JSON.stringify({ ...startPolicy, name: 'Renamed on the Source tab' }))
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
  expect(previews.length).toBeGreaterThan(afterMount)

  // The step edit's own render now answers stale — its sequence no longer
  // matches the one the Source tab's edit just took.
  await act(async () => {
    resolveRender({
      source: JSON.stringify({ ...startPolicy, name: 'Your own shape', roles: [...startPolicy.roles, { id: 'agent-1', kind: 'agent', uses: [], seats: [], isolate: false, grant: 'read', independentOf: [] }] }),
      issues: [],
    })
  })
  await settle()

  const before = previews.length

  // A var typed after that stale answer is still previewed — never dropped
  // because a superseded render left `renderPending` stuck true forever.
  const label = [...document.body.querySelectorAll('label')].find((one) => one.textContent === 'Task')!
  const field = document.getElementById(label.getAttribute('for')!) as HTMLInputElement
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(field, 'typed')
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()

  expect(previews.length).toBeGreaterThan(before)
  expect(previews.at(-1)!.vars).toEqual({ task: 'typed' })
  expect(button('Start').hasAttribute('disabled')).toBe(false)
})

it('a bound input takes the start target’s own value, never its own YAML default — a hand-written binding from a branch is not refused', async () => {
  const bound: FlowPolicy = {
    version: 2, name: 'Review', inputs: [{ id: 'branch', label: 'Branch', default: 'placeholder-default' }],
    roles: [{ id: 'reviewer', kind: 'person', outcomes: ['done'] }], rules: [],
    seed: { role: 'reviewer', title: 'Go' }, messaging: 'board-only', wait: 240,
    layout: { frontDoor: { bindings: [{ input: 'branch', value: 'branch' }] } },
  }
  const RESOLVED = 'feature-x'
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'authoring/start/preview') {
      const { source, vars } = params as { source: string; vars: Readonly<Record<string, string>> }
      const policy = JSON.parse(source) as FlowPolicy
      // The real host resolves a bound input from the start target alone —
      // it never accepts one asserted by the caller. A value other than the
      // one it resolves to is refused, the same as a stale, mismatched token.
      if ('branch' in vars && vars['branch'] !== RESOLVED) {
        return {
          flow: { token: null, compiled: { document: { format: 'agents', flow: policy }, bindings: [], problems: [] }, seats: [], commands: [], guards: [], messaging: 'board-only', problems: [{ level: 'error', at: 'branch', text: 'This input is bound; it cannot be set to anything else.' }] },
          target: { label: 'branch feature-x', base: null, head: null, dirty: false, independence: 'unknown' },
          vars, source, sentence: '', goal: null,
        }
      }
      return previewFor(policy, { vars: { ...vars, branch: RESOLVED }, target: { label: 'branch feature-x', base: null, head: null, dirty: false, independence: 'unknown' } })
    }
    if (method === 'agent/list') return [AGENT]
    return null
  }) as never)
  renderWithSource(store, JSON.stringify(bound))
  await settle()

  // The target's own value, shown — never the shape's own placeholder default.
  expect(document.body.textContent).toContain(RESOLVED)
  expect(document.body.textContent).not.toContain('placeholder-default')
  // Never refused: a hand-written binding starting from a branch reaches a usable Start.
  expect(button('Start').hasAttribute('disabled')).toBe(false)
})

it('an input bound from the start target renders read-only, as a fact, never an editable field that refuses its own edit', async () => {
  const bound: FlowPolicy = {
    version: 2, name: 'Review', inputs: [{ id: 'branch', label: 'Branch' }],
    roles: [{ id: 'reviewer', kind: 'person', outcomes: ['done'] }], rules: [],
    seed: { role: 'reviewer', title: 'Go' }, messaging: 'board-only', wait: 240,
    layout: { frontDoor: { bindings: [{ input: 'branch', value: 'branch' }] } },
  }
  const store = new AppStore('ws://localhost:0/')
  bindingFakeHost(store)
  renderWithSource(store, JSON.stringify(bound))
  await settle()

  // A bound input is a fact, never a field a person can type into only to
  // have the edit refused: no input element for it at all.
  const label = [...document.body.querySelectorAll('label')].find((one) => one.textContent === 'Branch')
  expect(label).toBeUndefined()
  expect(document.body.textContent).toContain('Branch')
})

it('a bound input carrying a commit shows it short, with the full sha in title — the same as the front door', async () => {
  const bound: FlowPolicy = {
    version: 2, name: 'Review', inputs: [{ id: 'head', label: 'Head commit' }],
    roles: [{ id: 'reviewer', kind: 'person', outcomes: ['done'] }], rules: [],
    seed: { role: 'reviewer', title: 'Go' }, messaging: 'board-only', wait: 240,
    layout: { frontDoor: { bindings: [{ input: 'head', value: 'head' }] } },
  }
  const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
  const store = new AppStore('ws://localhost:0/')
  vi.spyOn(store.transport, 'request').mockImplementation((async (method: HostMethodName, params: unknown) => {
    if (method === 'authoring/start/preview') {
      const { source, vars } = params as { source: string; vars: Readonly<Record<string, string>> }
      const policy = JSON.parse(source) as FlowPolicy
      return previewFor(policy, { vars: { ...vars, head: SHA } })
    }
    if (method === 'agent/list') return [AGENT]
    return null
  }) as never)
  renderWithSource(store, JSON.stringify(bound))
  await settle()

  const shortened = SHA.slice(0, 7)
  expect(document.body.textContent).toContain(shortened)
  expect(document.body.textContent).not.toContain(SHA)
  const holder = [...document.body.querySelectorAll('[title]')].find((one) => one.getAttribute('title') === SHA)
  expect(holder?.textContent).toBe(shortened)
})

it('removing a step uses the destructive tone, and only there', async () => {
  const store = new AppStore('ws://localhost:0/')
  fakeHost(store)
  render(store)
  await settle()

  act(() => byAriaLabel('review actions').click())
  await settle()
  const remove = menuItem('Remove step')
  expect(remove.getAttribute('data-variant')).toBe('destructive')
  expect(remove.getAttribute('aria-disabled')).toBe('true')
  expect(remove.querySelector('[data-menu-hint]')?.textContent).toBe('The seed step, and a step a rule still points at, cannot be removed.')
  expect(remove.querySelector('[data-menu-icon]')?.getAttribute('data-variant')).not.toBe('destructive')
  // Neither of its siblings in the same menu carries the same tone.
  expect(menuItem('Move up').getAttribute('data-variant')).not.toBe('destructive')
  expect(menuItem('Move down').getAttribute('data-variant')).not.toBe('destructive')
})

it('removing a role also removes its completion declaration from saved source', async () => {
  const policy: FlowPolicy = {
    version: 2,
    name: 'Review',
    inputs: [],
    roles: [
      { id: 'reviewer', kind: 'person', outcomes: ['done'] },
      { id: 'referee', kind: 'person', outcomes: ['merged', 'dropped'] },
    ],
    complete: { reviewer: ['done'], referee: ['merged', 'dropped'] },
    rules: [{ id: 'to-referee', on: 'reviewer', then: { role: 'referee', title: 'Merge' } }],
    seed: { role: 'reviewer', title: 'Review the change' },
    messaging: 'board-only',
    wait: 240,
  }
  const store = new AppStore('ws://localhost:0/')
  fakeHost(store)
  renderWithSource(store, JSON.stringify(policy))
  await settle()

  // Remove the rule that still points at referee before removing the role,
  // just as the ordered editor requires for a built-in complete role.
  act(() => byAriaLabel('Rule to-referee actions').click())
  await settle()
  act(() => menuItem('Remove rule').click())
  await settle()

  act(() => byAriaLabel('referee actions').click())
  await settle()
  act(() => menuItem('Remove step').click())
  await settle()

  act(() => button('Source').click())
  await settle()
  const saved = JSON.parse((document.body.querySelector('textarea') as HTMLTextAreaElement).value) as FlowPolicy
  expect(saved.roles.map((role) => role.id)).toEqual(['reviewer'])
  expect(saved.complete).toEqual({ reviewer: ['done'] })
  expect(parseClientMessage({ id: 1, method: 'authoring/shape/render', params: { policy: saved } }).method).toBe('authoring/shape/render')
})

it('renaming a role carries its completion declaration and rule reference into saved source', async () => {
  const policy: FlowPolicy = {
    version: 2,
    name: 'Review',
    inputs: [],
    roles: [
      { id: 'reviewer', kind: 'person', outcomes: ['done'] },
      { id: 'referee', kind: 'person', outcomes: ['merged', 'dropped'] },
    ],
    complete: { reviewer: ['done'], referee: ['merged', 'dropped'] },
    rules: [{ id: 'to-referee', on: 'reviewer', then: { role: 'referee', title: 'Merge' } }],
    seed: { role: 'reviewer', title: 'Review the change' },
    messaging: 'board-only',
    wait: 240,
  }
  const store = new AppStore('ws://localhost:0/')
  fakeHost(store)
  renderWithSource(store, JSON.stringify(policy))
  await settle()

  const name = [...document.body.querySelectorAll('input')].find((input) => input.value === 'referee')!
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'chair')
    name.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()

  act(() => button('Source').click())
  await settle()
  const saved = JSON.parse((document.body.querySelector('textarea') as HTMLTextAreaElement).value) as FlowPolicy
  expect(saved.complete).toEqual({ reviewer: ['done'], chair: ['merged', 'dropped'] })
  expect(saved.rules[0]?.then.role).toBe('chair')
})

it('offers the same editor as a page with canvas tools and a current-source New Team handoff', async () => {
  const store = new AppStore('ws://localhost:0/')
  const spy = fakeHost(store)
  const onStartTeam = vi.fn()
  act(() => root.render(<StoreProvider store={store}><DestinationPageScope owner="flows" active><ShapeEditor root="/repo" context={{ kind: 'project', root: '/repo' }} presentation="page" onClose={vi.fn()} onStarted={vi.fn()} onStartTeam={onStartTeam} /></DestinationPageScope></StoreProvider>))
  await settle()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(button('Back to Flows')).toBeTruthy()
  expect(document.querySelector('[data-slot="flow-canvas-toolbar"]')?.getAttribute('data-placement')).toBe('bar')
  expect(document.querySelector('[aria-label="Flow actions"]')?.textContent).toContain('Save…')
  expect(document.querySelector('input')?.value).toBe('review')
  expect(document.querySelector('input')?.closest('[hidden]')).toBeNull()
  expect([...document.querySelectorAll('button')].some(one => one.textContent === 'Edit step')).toBe(false)
  expect(button('Step')).toBeTruthy()
  expect(button('Rule')).toBeTruthy()
  expect(button('Undo').disabled).toBe(true)
  act(() => button('Step').click())
  await settle()
  act(() => menuItem('Agent').click())
  await settle()
  expect(button('Undo').disabled).toBe(false)
  const edited = (spy.mock.calls.filter(call => call[0] === 'authoring/shape/render').at(-1)![1] as { policy: FlowPolicy }).policy
  expect(edited.roles.at(-1)?.kind).toBe('agent')
  expect(edited.name).toBe('New Flow')
  act(() => button('Start a Team').click())
  expect(onStartTeam).toHaveBeenCalledWith(JSON.stringify(edited))
  act(() => button('Undo').click())
  await settle()
  const undone = JSON.parse((spy.mock.calls.filter(call => call[0] === 'authoring/start/preview').at(-1)![1] as { source: string }).source) as FlowPolicy
  expect(undone.roles).toHaveLength(1)
  act(() => button('Dry run').click())
  await settle()
  expect(document.querySelector('[role="dialog"][aria-label="Dry run"]')).not.toBeNull()
})

it('saving a built-in Flow creates a writable copy without asserting the built-in digest', async () => {
  const store = new AppStore('ws://localhost:0/')
  const spy = fakeHost(store)
  const policy: FlowPolicy = { version: 2, name: 'Review', inputs: [], messaging: 'board-only', wait: 240, roles: [{ id: 'review', kind: 'person', outcomes: ['done'] }], rules: [], seed: { role: 'review', title: 'Review' } }
  act(() => root.render(<StoreProvider store={store}><DestinationPageScope owner="flows" active><ShapeEditor root="/repo" context={{ kind: 'project', root: '/repo' }} presentation="page" document={{ target: { kind: 'flow', root: '/repo', origin: 'builtin', id: 'review' }, source: JSON.stringify(policy), digest: 'builtin-digest', exists: true, writable: false, displayPath: 'Built in', issues: [] }} onClose={vi.fn()} onStarted={vi.fn()} /></DestinationPageScope></StoreProvider>))
  await settle()
  act(() => button('Save…').click())
  await settle()
  expect(spy.mock.calls.find(call => call[0] === 'authoring/save/preview')?.[1]).toEqual(expect.objectContaining({ expected: null, target: { kind: 'flow', root: '/repo', origin: 'user', id: 'review' } }))
})

it('closes page-owned save and dry-run dialogs when another destination becomes active', async () => {
  const store = new AppStore('ws://localhost:0/')
  fakeHost(store)
  const context = { kind: 'project' as const, root: '/repo' }
  const renderPage = (active: boolean) => act(() => root.render(<StoreProvider store={store}><DestinationPageScope owner="flows" active={active}><ShapeEditor root="/repo" context={context} presentation="page" onClose={vi.fn()} onStarted={vi.fn()} /></DestinationPageScope></StoreProvider>))
  renderPage(true)
  await settle()
  act(() => button('Save…').click())
  await settle()
  expect(document.querySelector('[role="dialog"]')).not.toBeNull()
  renderPage(false)
  await settle()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  renderPage(true)
  await settle()
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

it('retires an inactive page preview before defaults can replace another New Team preview, then checks again on resume', async () => {
  const policy: FlowPolicy = {
    version: 2, name: 'Page draft', inputs: [{ id: 'topic', label: 'Topic', default: 'page-default' }],
    roles: [{ id: 'review', kind: 'person', outcomes: ['done'] }], rules: [], seed: { role: 'review', title: '{{topic}}' }, messaging: 'board-only', wait: 240,
  }
  const other: FlowPolicy = { ...policy, name: 'Active Team', inputs: [] }
  const source = JSON.stringify(policy), otherSource = JSON.stringify(other)
  const context = { kind: 'project' as const, root: '/repo' }
  const store = new AppStore('ws://localhost:0/')
  const held: ((preview: FrontDoorPreview) => void)[] = []
  const previews = vi.spyOn(store, 'previewFrontDoor')
  let releasePageReplies = false
  const spy = vi.spyOn(store.transport, 'request').mockImplementation((async (method: string, params: unknown) => {
    if (method === 'agent/list') return []
    if (method === 'authoring/start/preview') {
      const input = params as { source: string; vars: Readonly<Record<string, string>> }
      if (input.source === source && !releasePageReplies) return new Promise<FrontDoorPreview>(resolve => held.push(resolve))
      return previewFor(JSON.parse(input.source) as FlowPolicy, { vars: input.vars })
    }
    return null
  }) as never)
  const renderPage = (active: boolean) => act(() => root.render(<StoreProvider store={store}><DestinationPageScope owner="flows" active={active}><ShapeEditor root="/repo" context={context} presentation="page" initialSource={source} onClose={vi.fn()} onStarted={vi.fn()} onStartTeam={vi.fn()} /></DestinationPageScope></StoreProvider>))
  renderPage(true)
  await settle()
  expect(held).toHaveLength(1)
  expect(previews).toHaveBeenCalledWith(expect.objectContaining({ source }), { publish: false })
  renderPage(false)
  await act(async () => {
    store.openFrontDoor(context)
    await store.previewFrontDoor({ context, source: otherSource, vars: {} })
  })
  expect(store.getSnapshot().frontDoor?.preview?.source).toBe(otherSource)
  await act(async () => held[0]!(previewFor(policy)))
  expect.soft(spy.mock.calls.filter(call => call[0] === 'authoring/start/preview')).toHaveLength(2)
  expect.soft(store.getSnapshot().frontDoor?.preview?.source).toBe(otherSource)
  renderPage(true)
  expect(button('Start a Team').disabled).toBe(true)
  await settle()
  expect(held).toHaveLength(2)
  releasePageReplies = true
  await act(async () => held[1]!(previewFor(policy)))
  expect(button('Start a Team').disabled).toBe(false)
})

it('page rules keep first-match precedence editable through each rule’s move actions', async () => {
  const policy: FlowPolicy = {
    version: 2, name: 'Precedence', inputs: [], roles: [{ id: 'review', kind: 'person', outcomes: ['done'] }],
    rules: [{ id: 'first', on: 'review', when: { every: ['done'] }, then: { role: 'review', title: 'First' } }, { id: 'fallback', on: 'review', then: { role: 'review', title: 'Fallback' } }],
    seed: { role: 'review', title: 'Review' }, messaging: 'board-only', wait: 240,
  }
  const store = new AppStore('ws://localhost:0/')
  const spy = fakeHost(store)
  act(() => root.render(<StoreProvider store={store}><DestinationPageScope owner="flows" active><ShapeEditor root="/repo" context={{ kind: 'project', root: '/repo' }} presentation="page" initialSource={JSON.stringify(policy)} onClose={vi.fn()} onStarted={vi.fn()} /></DestinationPageScope></StoreProvider>))
  await settle()
  const rules = document.querySelector<HTMLElement>('section[aria-label="Flow settings"][data-slot="tool-section"]')!
  expect(rules.textContent).toContain('first match fires')
  act(() => rules.querySelector<HTMLButtonElement>('[data-slot="tool-section-fold"]')!.click())
  act(() => byAriaLabel('Rule first actions').click())
  await settle()
  act(() => menuItem('Move down').click())
  await settle()
  const changed = (spy.mock.calls.filter(call => call[0] === 'authoring/shape/render').at(-1)![1] as { policy: FlowPolicy }).policy
  expect(changed.rules.map(rule => rule.id)).toEqual(['fallback', 'first'])
  expect(changed.rules.find(rule => rule.id === 'first')?.when).toEqual({ every: ['done'] })
})

const savedPageFixture = () => {
  const policy: FlowPolicy = { version: 2, name: 'Race', inputs: [], roles: [{ id: 'review', kind: 'person', outcomes: ['done'] }], rules: [], seed: { role: 'review', title: 'Review' }, messaging: 'board-only', wait: 240 }
  const source = JSON.stringify(policy)
  const document: AuthoringDocument = { target: { kind: 'flow', root: '/repo', origin: 'project', id: 'race' }, source, digest: 'original', displayPath: '.harnessdesk/flows/race.yml', exists: true, writable: true, issues: [] }
  const store = new AppStore('ws://localhost:0/')
  fakeHost(store)
  vi.spyOn(store, 'previewAuthoringSave').mockResolvedValue({ token: 'save', edits: [], issues: [], resuming: false })
  vi.spyOn(store, 'applyAuthoringSave').mockResolvedValue({ state: 'applied', written: ['.harnessdesk/flows/race.yml'], message: 'Saved.' })
  const mount = () => act(() => root.render(<StoreProvider store={store}><TopBarProvider><DestinationPageScope owner="flows" active><TopBarOutlet owner="flows" fallback={{ place: 'Flows', more: () => null }} /><ShapeEditor root="/repo" context={{ kind: 'project', root: '/repo' }} presentation="page" document={document} onClose={vi.fn()} onStarted={vi.fn()} /></DestinationPageScope></TopBarProvider></StoreProvider>))
  const save = async () => { act(() => button('Save…').click()); await settle(); act(() => button('Save').click()); await settle() }
  return { policy, source, document, store, mount, save }
}

it('refuses an unseen post-save file revision as an overwrite or Delete target until reviewed', async () => {
  const fixture = savedPageFixture()
  const changed = { ...fixture.document, source: JSON.stringify({ ...fixture.policy, name: 'External change' }), digest: 'unseen' }
  vi.spyOn(fixture.store, 'readAuthoring').mockResolvedValue(changed)
  fixture.mount()
  await settle()
  await fixture.save()
  expect(document.body.textContent).toContain('The saved file changed before it could be read')
  expect(button('Save…').disabled).toBe(true)
  act(() => button('Race').click())
  await settle()
  expect(menuItem('Delete…').getAttribute('aria-disabled')).toBe('true')
  act(() => menuItem('Delete…').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
  await settle()
  act(() => button('Review saved file').click())
  await settle()
  expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe(changed.source)
  expect(button('Save…').disabled).toBe(false)
})

it('an older save readback cannot replace the document adopted by a newer duplicate', async () => {
  const fixture = savedPageFixture()
  let first!: (document: AuthoringDocument) => void
  const copy: AuthoringDocument = { ...fixture.document, target: { kind: 'flow', root: '/repo', origin: 'project', id: 'race-copy' }, digest: 'copy', displayPath: '.harnessdesk/flows/race-copy.yml' }
  vi.spyOn(fixture.store, 'readAuthoring').mockImplementationOnce(() => new Promise(resolve => { first = resolve })).mockResolvedValueOnce(copy)
  fixture.mount()
  await settle()
  await fixture.save()
  act(() => button('Race').click())
  await settle()
  act(() => menuItem('Duplicate').click())
  await settle()
  act(() => button('Save').click())
  await settle()
  expect(document.querySelector('[aria-label="Flow actions"] [title]')?.getAttribute('title')).toContain('race-copy.yml')
  await act(async () => first({ ...fixture.document, digest: 'first-save' }))
  expect(document.querySelector('[aria-label="Flow actions"] [title]')?.getAttribute('title')).toContain('race-copy.yml')
})

it('Undo after two overlapping policy edits removes only the most recent edit', async () => {
  const fixture = savedPageFixture()
  fixture.mount()
  await settle()
  const renders: { policy: FlowPolicy; resolve: (result: { source: string; issues: [] }) => void }[] = []
  vi.spyOn(fixture.store, 'renderShape').mockImplementation(policy => new Promise(resolve => { renders.push({ policy, resolve }) }))
  const addAgent = async () => { act(() => button('Step').click()); await settle(); act(() => menuItem('Agent').click()); await settle() }
  await addAgent()
  await addAgent()
  expect(renders).toHaveLength(2)
  expect(renders[1]!.policy.roles).toHaveLength(3)
  await act(async () => renders[1]!.resolve({ source: JSON.stringify(renders[1]!.policy), issues: [] }))
  await act(async () => renders[0]!.resolve({ source: JSON.stringify(renders[0]!.policy), issues: [] }))
  act(() => button('Undo').click())
  await settle()
  expect(renders).toHaveLength(3)
  expect(renders[2]!.policy.roles).toHaveLength(2)
  expect(renders[2]!.policy.roles.at(-1)?.id).toBe('agent')
  await act(async () => renders[2]!.resolve({ source: JSON.stringify(renders[2]!.policy), issues: [] }))
})

it('retains an unfinished ordered draft while away and renders it afresh before resuming Start', async () => {
  const fixture = savedPageFixture()
  const context = { kind: 'project' as const, root: '/repo' }
  const preview = vi.spyOn(fixture.store, 'previewFrontDoor')
  const renderPage = (active: boolean) => act(() => root.render(<StoreProvider store={fixture.store}><DestinationPageScope owner="flows" active={active}><ShapeEditor root="/repo" context={context} presentation="page" document={fixture.document} onClose={vi.fn()} onStarted={vi.fn()} /></DestinationPageScope></StoreProvider>))
  renderPage(true)
  await settle()
  const renders: { policy: FlowPolicy; resolve: (result: { source: string; issues: [] }) => void }[] = []
  vi.spyOn(fixture.store, 'renderShape').mockImplementation(policy => new Promise(resolve => { renders.push({ policy, resolve }) }))
  act(() => button('Step').click())
  await settle()
  act(() => menuItem('Agent').click())
  await settle()
  expect(renders).toHaveLength(1)
  renderPage(false)
  const previewsBefore = preview.mock.calls.length
  act(() => button('Rule').click())
  await settle()
  expect(renders).toHaveLength(1)
  await act(async () => renders[0]!.resolve({ source: JSON.stringify(renders[0]!.policy), issues: [] }))
  expect(preview).toHaveBeenCalledTimes(previewsBefore)
  renderPage(true)
  await settle()
  expect(button('Start a Team').disabled).toBe(true)
  expect(renders).toHaveLength(2)
  expect(renders[1]!.policy.roles.map(role => role.id)).toEqual(['review', 'agent'])
  expect(renders[1]!.policy.rules).toEqual([])
  await act(async () => renders[1]!.resolve({ source: JSON.stringify(renders[1]!.policy), issues: [] }))
  expect(button('Start a Team').disabled).toBe(false)
})

it('Undo after a settled File draft and ordered edit restores the exact File bytes', async () => {
  const fixture = savedPageFixture()
  const exactSource = `\n  ${JSON.stringify(fixture.policy, null, 2)}\n\n`
  const spy = vi.spyOn(fixture.store, 'previewFrontDoor')
  act(() => root.render(<StoreProvider store={fixture.store}><DestinationPageScope owner="flows" active><ShapeEditor root="/repo" context={{ kind: 'project', root: '/repo' }} presentation="page" initialSource={exactSource} onClose={vi.fn()} onStarted={vi.fn()} /></DestinationPageScope></StoreProvider>))
  await settle()
  act(() => button('Step').click())
  await settle()
  act(() => menuItem('Agent').click())
  await settle()
  act(() => button('Undo').click())
  await settle()
  expect(spy.mock.calls.at(-1)?.[0].source).toBe(exactSource)
  act(() => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent === 'File')!.click())
  await settle()
  expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe(exactSource)
})

it('Undo after fixing an invalid File with an ordered edit restores its unparsed text', async () => {
  const fixture = savedPageFixture()
  fixture.mount()
  await settle()
  act(() => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent === 'File')!.click())
  await settle()
  const invalidSource = '# keep this unfinished draft\nroles: [ unfinished'
  act(() => {
    const field = document.querySelector('textarea') as HTMLTextAreaElement
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, invalidSource)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await settle()
  expect(button('Start a Team').disabled).toBe(true)
  act(() => button('Step').click())
  await settle()
  act(() => menuItem('Agent').click())
  await settle()
  expect(button('Start a Team').disabled).toBe(false)
  act(() => button('Undo').click())
  await settle()
  expect((document.querySelector('textarea') as HTMLTextAreaElement).value).toBe(invalidSource)
  expect(button('Start a Team').disabled).toBe(true)
})


it('folds the selected Step inspector independently of its menu while keeping its form initially visible', async () => {
  const fixture = savedPageFixture()
  fixture.mount()
  await settle()
  const section = container.querySelector<HTMLElement>('[data-slot="tool-section"][aria-label="Step · review"]')!
  const toggle = section.querySelector<HTMLButtonElement>('[data-slot="tool-section-fold"]')!
  expect(toggle).not.toBeNull()
  expect(toggle.getAttribute('aria-expanded')).toBe('true')
  const action = section.querySelector<HTMLButtonElement>('[aria-label="Actions for step review"]')!
  expect(toggle.contains(action)).toBe(false)
  act(() => toggle.click())
  expect(section.querySelector<HTMLElement>('[data-slot="tool-section-body"]')!.hidden).toBe(true)
  act(() => action.click())
  await settle()
  expect(menuItem('Move up')).toBeTruthy()
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
})
