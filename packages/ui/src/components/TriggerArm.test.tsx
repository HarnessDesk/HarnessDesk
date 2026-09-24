import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { TriggerArmPreview, TriggerView } from '@harnessdesk/protocol'

import { FLOW_SEATS, FIX_PREVIEW } from '../preview/flow-fixture'
import { prDefinition, sceneArmPreview, triggerArmPreview, triggerView } from '../preview/intake-fixture'
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
  expect(text).toContain('pr')
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
