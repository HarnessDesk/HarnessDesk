import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { TriggerHistoryPage, TriggerProjectView } from '@harnessdesk/protocol'

import {
  issueDefinition,
  prDefinition,
  scheduleDefinition,
  triggerFiring,
  triggerHistoryPage,
  triggerProjectView,
  triggerView,
} from '../preview/intake-fixture'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { ProjectTriggers } from './ProjectTriggers'

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

const ROOT = '/home/dev/code/storefront'
const settle = () => act(async () => {})

const mount = (overrides: Partial<AppStore> = {}, snapshotOverrides: Partial<AppSnapshot> = {}) => {
  const snapshot = { ...emptySnapshot(), status: 'open', home: '/home/dev', ...snapshotOverrides } as AppSnapshot
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    projectTriggers: vi.fn(async () => triggerProjectView()),
    previewTrigger: vi.fn(async () => { throw new Error('not exercised') }),
    armTrigger: vi.fn(async () => { throw new Error('not exercised') }),
    disarmTrigger: vi.fn(async () => triggerView({ armed: false, state: 'off' })),
    triggerHistory: vi.fn(async (): Promise<TriggerHistoryPage> => ({ items: [], next: null })),
    openFile: vi.fn(),
    openGoal: vi.fn(),
    agentsIn: vi.fn(async () => []),
    ...overrides,
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <ProjectTriggers root={ROOT} />
      </StoreProvider>,
    )
  })
  return store
}

const button = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll('button')].find((one) => one.textContent?.trim().startsWith(label))
  if (!found) throw new Error(`no button reading “${label}”`)
  return found
}

it('describes every source, its arm state, and the last thing that happened, including a skip reason', async () => {
  const view: TriggerProjectView = triggerProjectView({
    triggers: [
      triggerView({ id: 'review-pr', definition: prDefinition() }),
      triggerView({
        id: 'triage-issue',
        definition: issueDefinition(),
        last: triggerFiring({ id: 'f2', trigger: 'triage-issue', source: 'issue', outcome: 'skipped', reason: 'Out of budget for today.', goal: null, run: null, round: null, head: null }),
      }),
      triggerView({
        id: 'nightly-sweep',
        definition: scheduleDefinition(),
        armed: true,
        state: 'armed',
        openGoals: 1,
      }),
      triggerView({
        id: 'fork-review',
        definition: prDefinition({ id: 'fork-review', forks: 'allow' }),
        state: 'refused',
        reason: 'A pull request from a fork was seen, and this trigger is not armed for forks.',
        fix: 'Arm it, or turn on forks: allow.',
      }),
    ],
  })
  mount({ projectTriggers: vi.fn(async () => view) })
  await settle()
  const text = container.textContent ?? ''
  expect(text).toContain('When a pull request opens or is pushed, open review-pr, at most 4 at once.')
  expect(text).toContain('When an issue is labelled, open triager, once at a time.')
  expect(text).toContain('Every 24 hours')
  expect(text).toContain('Out of budget for today.')
  expect(text).toContain('Armed')
  expect(text).toContain('Off')
  expect(text).toContain('Refused')
  expect(text).toContain('A pull request from a fork was seen')
})

it('a project with no triggers file says so, without creating one', async () => {
  const store = mount({
    projectTriggers: vi.fn(async () => triggerProjectView({ exists: false, triggers: [] })),
  })
  await settle()
  expect(container.textContent).toContain('No triggers')
  expect(container.textContent).toContain('.harnessdesk/triggers.yml')
  expect(store.projectTriggers).toHaveBeenCalledTimes(1)
})

it('a working copy that differs from what is committed is said, and only the committed file is offered', async () => {
  mount({ projectTriggers: vi.fn(async () => triggerProjectView({ workingCopyChanged: true })) })
  await settle()
  expect(container.textContent).toContain('Your working copy of this file is not what is committed.')
})

it('a broken declaration is listed with where and why, never hidden', async () => {
  mount({
    projectTriggers: vi.fn(async () => triggerProjectView({
      triggers: [],
      problems: [{ at: '[0].budget.usd', text: 'A budget must be a positive number.', fix: 'Give it a positive amount.' }],
    })),
  })
  await settle()
  // Where, in words; the exact path only on hover (review #898).
  expect(container.textContent).toContain('Trigger 1, its budget')
  expect(container.textContent).not.toContain('[0].budget.usd')
  expect(container.querySelector('[title="[0].budget.usd"]')?.textContent).toBe('Trigger 1, its budget')
  expect(container.textContent).toContain('A budget must be a positive number.')
  expect(container.textContent).toContain('Will not run')
})

it('turning a trigger off disarms it and stays pending until the host answers; a failure keeps it armed and says why', async () => {
  let resolveDisarm!: (value: unknown) => void
  const disarmTrigger = vi.fn(() => new Promise((resolve) => { resolveDisarm = resolve }))
  const store = mount({
    projectTriggers: vi.fn(async () => triggerProjectView({ triggers: [triggerView({ armed: true, state: 'armed' })] })),
    disarmTrigger: disarmTrigger as never,
  })
  await settle()
  const toggle = container.querySelector<HTMLElement>('[role="switch"]')!
  expect(toggle.getAttribute('aria-checked')).toBe('true')
  act(() => toggle.click())
  expect(disarmTrigger).toHaveBeenCalledWith(ROOT, 'review-pr')
  expect(toggle.getAttribute('data-disabled')).not.toBeNull()
  await act(async () => {
    resolveDisarm(triggerView({ armed: false, state: 'off' }))
  })
  expect(store.projectTriggers).toHaveBeenCalledTimes(2)
})

it('a failed disarm leaves the switch armed and reports the reason on that row', async () => {
  const disarmTrigger = vi.fn(async () => { throw new Error('The host refused to disarm review-pr.') })
  mount({
    projectTriggers: vi.fn(async () => triggerProjectView({ triggers: [triggerView({ armed: true, state: 'armed' })] })),
    disarmTrigger: disarmTrigger as never,
  })
  await settle()
  const toggle = container.querySelector<HTMLElement>('[role="switch"]')!
  await act(async () => { toggle.click() })
  expect(container.textContent).toContain('The host refused to disarm review-pr.')
  expect(toggle.getAttribute('aria-checked')).toBe('true')
})

it('turning a trigger on opens the arming review rather than arming it directly', async () => {
  mount({ projectTriggers: vi.fn(async () => triggerProjectView({ triggers: [triggerView()] })) })
  await settle()
  const toggle = container.querySelector<HTMLElement>('[role="switch"]')!
  act(() => toggle.click())
  await settle()
  expect(document.body.textContent).toContain('Arm this trigger')
})

it('History pages a trigger’s firings and always names an exact duplicate', async () => {
  const page = triggerHistoryPage({
    items: [
      triggerFiring({ id: 'f1', subject: '9', outcome: 'fired' }),
      triggerFiring({ id: 'f2', subject: '9', outcome: 'duplicate', reason: null }),
    ],
    next: null,
  })
  mount({
    projectTriggers: vi.fn(async () => triggerProjectView({ triggers: [triggerView()] })),
    triggerHistory: vi.fn(async () => page),
  })
  await settle()
  act(() => button('History').click())
  await settle()
  expect(container.textContent).toContain('Already recorded')
})

it('a changed or refused arm is still switched on, so it can be switched off — and reviewed to arm it again', async () => {
  const disarmTrigger = vi.fn(async () => triggerView({ armed: false, state: 'off' }))
  mount({
    projectTriggers: vi.fn(async () => triggerProjectView({ triggers: [
      triggerView({ state: 'changed', reason: 'The triggers file changed since it was armed.', fix: 'Review the preview and arm it again.' }),
      triggerView({ id: 'triage-issue', definition: issueDefinition(), state: 'refused', reason: 'This machine cannot verify how this trigger was armed, so it does not run.', fix: 'Preview it and arm it again on this machine.' }),
    ] })),
    disarmTrigger: disarmTrigger as never,
  })
  await settle()
  const toggles = [...container.querySelectorAll<HTMLElement>('[role="switch"]')]
  expect(toggles.map((one) => one.getAttribute('aria-checked'))).toEqual(['true', 'true'])
  act(() => toggles[0]!.click())
  expect(disarmTrigger).toHaveBeenCalledWith(ROOT, 'review-pr')
  await settle()
  act(() => toggles[1]!.click())
  expect(disarmTrigger).toHaveBeenCalledWith(ROOT, 'triage-issue')
  await settle()
  act(() => button('Review').click())
  await settle()
  expect(document.body.textContent).toContain('Arm this trigger')
})

it('a source stopped at a gap offers Watch from now, and it asks the host to watch from now', async () => {
  const rebaselineTrigger = vi.fn(async () => triggerView({ armed: true, state: 'armed' }))
  const store = mount({
    projectTriggers: vi.fn(async () => triggerProjectView({ triggers: [triggerView({
      armed: true, state: 'armed',
      source: {
        project: ROOT, source: 'pull-request', state: 'gap', lastPolledAt: 1, skipped: 0,
        reason: 'More changed than one read can cover, so watching this source stopped.',
        fix: 'Resume it to watch from now: what changed in the gap is skipped, not replayed.',
      },
    })] })),
    rebaselineTrigger: rebaselineTrigger as never,
  })
  await settle()
  expect(container.textContent).toContain('Its source stopped at a gap')
  expect(container.textContent).toContain('what changed in the gap is skipped, not replayed')
  await act(async () => button('Watch from now').click())
  expect(rebaselineTrigger).toHaveBeenCalledWith(ROOT, 'review-pr')
  expect(store.projectTriggers).toHaveBeenCalledTimes(2)
})

it('a source that is watching offers no gap control', async () => {
  mount({ projectTriggers: vi.fn(async () => triggerProjectView({ triggers: [triggerView({ armed: true, state: 'armed', source: { project: ROOT, source: 'pull-request', state: 'watching', reason: null, fix: null, lastPolledAt: 1, skipped: 0 } })] })) })
  await settle()
  expect(container.textContent).not.toContain('Watch from now')
})
