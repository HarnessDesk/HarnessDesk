import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { AgentEntry, FlowPolicy, FrontDoorPreview, HostMethodName } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { ShapeEditor } from './ShapeEditor'

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
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
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
  const found = [...document.body.querySelectorAll('[role="menuitem"]')].find((one) => one.textContent?.trim() === label)
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
  const graphNode = () => [...document.body.querySelectorAll('button')].some((one) => one.getAttribute('aria-label')?.startsWith('review —'))
  expect(graphNode()).toBe(false)

  act(() => button('Agent').click())
  await settle()
  const stepsPolicy = document.body.textContent
  expect(stepsPolicy).toContain('Uses')

  act(() => button('Graph').click())
  await settle()
  // The same two roles (the seed person and the agent just added) are visible on the graph.
  expect(graphNode()).toBe(true)

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
  // Neither of its siblings in the same menu carries the same tone.
  expect(menuItem('Move up').getAttribute('data-variant')).not.toBe('destructive')
  expect(menuItem('Move down').getAttribute('data-variant')).not.toBe('destructive')
})
