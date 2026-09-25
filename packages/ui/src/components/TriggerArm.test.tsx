import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { TriggerArmPreview, TriggerView } from '@harnessdesk/protocol'

import { FLOW_SEATS, FIX_PREVIEW } from '../preview/flow-fixture'
import { issueDefinition, prDefinition, sceneArmPreview, triggerArmPreview, triggerView } from '../preview/intake-fixture'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppSnapshot, type AppStore } from '../state/store'
import { TriggerArm } from './TriggerArm'

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

const rig = async (
  preview: TriggerArmPreview | (() => Promise<TriggerArmPreview>),
  overrides: Partial<AppStore> = {},
) => {
  const snapshot = { ...emptySnapshot(), status: 'open', home: '/home/dev' } as AppSnapshot
  const previewTrigger = vi.fn(typeof preview === 'function' ? preview : async () => preview)
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    previewTrigger,
    armTrigger: vi.fn(async () => triggerView({ armed: true, state: 'armed' }) as TriggerView),
    agentsIn: vi.fn(async () => []),
    ...overrides,
  } as unknown as AppStore
  const onClose = vi.fn()
  const onArmed = vi.fn()
  await act(async () => {
    root.render(
      <StoreProvider store={store}>
        <TriggerArm root={ROOT} id="review-pr" onClose={onClose} onArmed={onArmed} />
      </StoreProvider>,
    )
  })
  return { store, onClose, onArmed, previewTrigger }
}

const button = (text: string): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent?.trim() === text)

it('arm requires the shown preview and reads back the result — cancel never calls it', async () => {
  const { store, onClose, onArmed } = await rig(triggerArmPreview({ token: 'good-token' }))
  expect(document.body.textContent).toContain('Arm this trigger')
  await act(async () => button('Cancel')!.click())
  expect(onClose).toHaveBeenCalled()
  expect(store.armTrigger).not.toHaveBeenCalled()
  expect(onArmed).not.toHaveBeenCalled()
})

it('arm sends exactly the token this preview carried, once, and reports back through onArmed', async () => {
  const { store, onArmed } = await rig(triggerArmPreview({ token: 'good-token' }))
  await act(async () => button('Arm')!.click())
  expect(store.armTrigger).toHaveBeenCalledWith(ROOT, 'review-pr', 'good-token')
  expect(store.armTrigger).toHaveBeenCalledTimes(1)
  expect(onArmed).toHaveBeenCalledWith(expect.objectContaining({ armed: true }))
})

it('a preview with no token disables Arm and keeps its refusal list visible', async () => {
  const { store } = await rig(sceneArmPreview('refused'))
  expect(document.body.textContent).toContain('A budget must be a positive number.')
  expect(document.body.textContent).toContain('Give it a positive USD amount');
  expect(button('Arm')?.disabled).toBe(true)
  await act(async () => {})
  expect(store.armTrigger).not.toHaveBeenCalled()
})

it('a stale token that the host refuses stays in the dialog and offers Review changes rather than re-arming on its own', async () => {
  const armTrigger = vi.fn(async () => { throw new Error('This preview has expired. Review it again before arming.') })
  const previewTrigger = vi.fn(async () => triggerArmPreview({ token: 'once-only' }))
  const { onArmed } = await rig(previewTrigger, { armTrigger })
  await act(async () => button('Arm')!.click())
  expect(document.body.textContent).toContain('This preview has expired')
  expect(document.body.textContent).toContain('Review changes')
  expect(onArmed).not.toHaveBeenCalled()

  await act(async () => button('Review changes')!.click())
  expect(previewTrigger).toHaveBeenCalledTimes(2)
})

it('refused candidates and every trusted command remain inspectable, and the exact command, cwd and timeout are shown verbatim', async () => {
  await rig(triggerArmPreview({ flow: FIX_PREVIEW, definition: prDefinition() }))
  const text = document.body.textContent ?? ''
  // The asked seat's passed-over candidates and their fixes, straight from the shared dry-run report.
  expect(text).toContain('Gamma')
  expect(text).toContain('Delta')
  // The exact trusted command, its cwd and its timeout, never a paraphrase.
  expect(text).toContain('pnpm verify')
  expect(text).toContain(FIX_PREVIEW.commands[0]!.cwd)
  expect(text).toContain('1800s')
  expect(FLOW_SEATS.length).toBeGreaterThan(0)
})

it('shows the source path, working-copy mismatch, grouping, again behaviour, fork rule, concurrency and budget from the frozen preview', async () => {
  await rig(triggerArmPreview({
    workingCopyChanged: true,
    definition: prDefinition({ forks: 'allow', concurrency: 2 }),
  }))
  const text = document.body.textContent ?? ''
  expect(text).toContain('.harnessdesk/triggers.yml')
  expect(text).toContain('Changed since committed')
  expect(text).toContain('When a pull request opens or is pushed')
  expect(text).toContain('One Goal per pull request.')
  expect(text).toContain('A new head on an open pull request')
  expect(text).toContain('Records the fact and needs a person')
  expect(text).toContain('Allowed — read-only')
  expect(text).toContain('Up to 2 open Goals at once')
  expect(text).toContain('Up to $5')
  expect(text).toContain('This runs while you are away. Commands shown here run with your authority.')
  expect(text).toContain('Stops when reported spend reaches the limit.')
})

it('a busy arm disables the button so a second click or a held Enter cannot arm twice', async () => {
  let resolveArm!: (value: TriggerView) => void
  const armTrigger = vi.fn(() => new Promise<TriggerView>((resolve) => { resolveArm = resolve }))
  const { onArmed } = await rig(triggerArmPreview({ token: 'good-token' }), { armTrigger: armTrigger as never })
  act(() => { button('Arm')!.click() })
  expect(button('Arming…')?.disabled).toBe(true)
  act(() => { button('Arming…')?.click() })
  expect(armTrigger).toHaveBeenCalledTimes(1)
  await act(async () => { resolveArm(triggerView({ armed: true })) })
  expect(onArmed).toHaveBeenCalledTimes(1)
})

it('names the repository it binds, and says what a later firing does in words, not field ids', async () => {
  await rig(triggerArmPreview({ repository: 'acme/widgets', definition: prDefinition({ again: { role: 'reviewer', title: 'Continue this work', detail: null } }) }))
  const text = document.body.textContent ?? ''
  expect(text).toContain('Repository')
  expect(text).toContain('acme/widgets')
  expect(text).toContain('A new head on an open pull request')
  expect(text).toContain('Stops the work on the old one and opens a new round: Continue this work.')
  expect(text).not.toContain('A new event at the same head')
})

it('an issue trigger that reads comments says whose count, and warns when anyone’s do', async () => {
  await rig(triggerArmPreview({ definition: issueDefinition({ on: { kind: 'issue', events: ['commented'] }, label: undefined, from: 'me' }) }))
  let text = document.body.textContent ?? ''
  expect(text).toContain('Comments that fire it')
  expect(text).toContain('Only yours: comments by the forge account this trigger is armed with. Posts this desk makes never fire it.')
  expect(text).toContain('A later event on an open issue')
  expect(text).not.toContain('Forks')
  expect(text).not.toContain('will start unattended work')
  act(() => root.unmount())
  root = createRoot(container)
  await rig(triggerArmPreview({ definition: issueDefinition({ on: { kind: 'issue', events: ['commented'] }, label: undefined, from: 'anyone' }) }))
  text = document.body.textContent ?? ''
  expect(text).toContain('Anyone who can comment on the repository.')
  expect(text).toContain('Anyone who can comment on this repository will start unattended work.')
})

it('refusals say where in words, keeping the exact path on hover', async () => {
  await rig(sceneArmPreview('refused'))
  expect(document.body.textContent).toContain('Trigger 1, its budget: A budget must be a positive number.')
  expect(document.querySelector('[title="[0].budget.usd"]')).not.toBeNull()
})

it('an expired preview says so in a banner with a way to read it again, never a sentence in a chip', async () => {
  const previewTrigger = vi.fn(async () => triggerArmPreview({ token: null, problems: [], flow: null }))
  await rig(previewTrigger)
  expect(document.body.textContent).toContain('This preview has expired')
  // A chip is a word on the label's line (data-size and data-variant are what one renders): never this sentence.
  expect([...document.querySelectorAll('[data-size][data-variant]')].some((one) => /expired/.test(one.textContent ?? ''))).toBe(false)
  await act(async () => button('Review again')!.click())
  expect(previewTrigger).toHaveBeenCalledTimes(2)
})

it('never reads as a deletion: arming authorises unattended work, it destroys nothing', async () => {
  await rig(triggerArmPreview({ token: 'good-token' }))
  const surface = document.querySelector('[role="alertdialog"]')!
  // The destructive tone's glyph — never shown for a consent that runs work, not one that deletes it.
  expect(surface.querySelector('.lucide-trash-2')).toBeNull()
  const armButton = button('Arm')!
  expect(armButton.getAttribute('data-variant')).not.toBe('destructive')
})

it('keeps each sentence-length explanation in its wrapped description, never squeezed into the value column', async () => {
  await rig(triggerArmPreview({
    definition: issueDefinition({ on: { kind: 'issue', events: ['commented'] }, label: undefined, from: 'anyone' }),
  }))
  const sentences = [
    'Records the fact and needs a person — no new round opens on its own.',
    'Anyone who can comment on the repository. Posts this desk makes never fire it.',
    'Up to $5, 3 rounds, 4 hours; stops after 2 rounds with no progress.',
    'Arming reserves this Goal’s whole budget against today’s cap the moment it opens, in Settings › Triggers on this Mac.',
  ]
  // `data-wrap` is what the stylesheet keys on to let a sentence run to a
  // second line instead of being ellipsised — see Row's description, which wraps unless it is a name or a path (`truncateDesc`).
  const wrapped = [...document.querySelectorAll('[data-wrap]')].map((el) => el.textContent)
  for (const sentence of sentences) expect(wrapped).toContain(sentence)
  // None of them are sitting in a KeyValueRow's right-aligned value slot.
  const values = [...document.querySelectorAll('dd')].map((el) => el.textContent)
  for (const sentence of sentences) expect(values).not.toContain(sentence)
})
