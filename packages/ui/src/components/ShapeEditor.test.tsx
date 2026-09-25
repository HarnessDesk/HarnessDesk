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
      const { source } = params as { source: string }
      try {
        const policy = JSON.parse(source) as FlowPolicy
        return previewFor(policy)
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

  const primaries = document.body.querySelectorAll('[data-slot="button"][data-variant="default"]')
  expect(primaries).toHaveLength(1)
  expect(primaries[0]?.textContent?.trim()).toBe('Start')

  // A dialog footer's own rule (design/usage.ts, slot "dialogFooter") is one
  // ink action and every other button `secondary` — never `ghost`, which
  // reads as a link in a footer where every choice should look equally
  // pressable. Close is the ordinary, enclosed action the footer already is.
  expect(button('Close').getAttribute('data-variant')).toBe('secondary')

  // "Every time…" is not a standing button of its own any more — it moved
  // behind the overflow next to Save.
  expect([...document.body.querySelectorAll('button')].some((one) => one.textContent?.trim() === 'Every time…')).toBe(false)
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
