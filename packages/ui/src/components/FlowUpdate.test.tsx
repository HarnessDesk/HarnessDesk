import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { FlowUpdatePreview, FlowUpdateResult } from '@harnessdesk/protocol'

import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { FlowUpdate } from './FlowUpdate'

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

const settle = (): Promise<void> => act(async () => {})

const PREVIEW: FlowUpdatePreview = {
  token: 'tok-1',
  resuming: false,
  edits: [
    { path: '.harnessdesk/agents/fix-fixer/AGENT.md', before: null, after: '---\nname: "Fix — fixer"\nceiling: edit\n---\n\nfix it\n' },
    { path: '.harnessdesk/agents/fix-reviewer/AGENT.md', before: null, after: '---\nname: "Fix — reviewer"\nceiling: read\n---\n\nreview it\n' },
    { path: '.harnessdesk/flows/fix.yml', before: '---\nname: Fix\n---\n\nfix it\n', after: 'version: 2\nname: "Fix"\nroles:\n  fixer:\n    kind: agent\n    uses: [fix-fixer]\n' },
  ],
  problems: [],
}

it('all generated files are shown before one apply, and Apply cannot be pressed twice', async () => {
  let resolveApply!: (result: FlowUpdateResult) => void
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => emptySnapshot(),
    previewFlowUpdate: vi.fn(async () => PREVIEW),
    applyFlowUpdate: vi.fn(() => new Promise<FlowUpdateResult>((resolve) => { resolveApply = resolve })),
  } as unknown as AppStore
  const onApplied = vi.fn()
  const onClose = vi.fn()
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <FlowUpdate root="/repo" id="fix" mode="update" onClose={onClose} onApplied={onApplied} />
      </StoreProvider>,
    )
  })
  await settle()

  // Every proposed file, before anything is written.
  expect(document.body.textContent).toContain('.harnessdesk/agents/fix-fixer/AGENT.md')
  expect(document.body.textContent).toContain('.harnessdesk/agents/fix-reviewer/AGENT.md')
  expect(document.body.textContent).toContain('.harnessdesk/flows/fix.yml')
  expect(document.body.textContent).toContain('fix it')
  expect(document.body.textContent).toContain('review it')
  expect(store.applyFlowUpdate).not.toHaveBeenCalled()

  const proceed = [...document.body.querySelectorAll('button')].find((one) => one.textContent === 'Write these files')!
  act(() => proceed.click())
  await settle()
  // Pending: a second press before the host answers must not fire twice.
  expect((proceed as HTMLButtonElement).disabled).toBe(true)
  act(() => proceed.click())
  await settle()
  expect(store.applyFlowUpdate).toHaveBeenCalledTimes(1)
  expect(store.applyFlowUpdate).toHaveBeenCalledWith('/repo', 'fix', 'tok-1', 'update')

  act(() => {
    resolveApply({ state: 'partial', written: ['.harnessdesk/agents/fix-fixer/AGENT.md'], message: 'The flow was not replaced. Some Agent files were created; review them, then continue the update.' })
  })
  await settle()
  // Partial keeps the dialog open, names what was written and re-previews for a fresh token.
  expect(onClose).not.toHaveBeenCalled()
  expect(onApplied).not.toHaveBeenCalled()
  expect(document.body.textContent).toContain('Partly written')
  expect(document.body.textContent).toContain('The flow was not replaced. Some Agent files were created')
  expect(document.body.textContent).toContain('.harnessdesk/agents/fix-fixer/AGENT.md')
  expect(store.previewFlowUpdate).toHaveBeenCalledTimes(2)
})

it('an error in the preview keeps Apply visible and disabled, with the fix named on screen', async () => {
  const broken: FlowUpdatePreview = { ...PREVIEW, problems: [{ level: 'error', at: 'update', text: 'An Agent file already exists. Choose another flow name and preview again.' }] }
  const store = {
    subscribe: () => () => {},
    getSnapshot: () => emptySnapshot(),
    previewFlowUpdate: vi.fn(async () => broken),
    applyFlowUpdate: vi.fn(),
  } as unknown as AppStore
  act(() => {
    root.render(
      <StoreProvider store={store}>
        <FlowUpdate root="/repo" id="fix" mode="update" onClose={() => {}} onApplied={() => {}} />
      </StoreProvider>,
    )
  })
  await settle()
  expect(document.body.textContent).toContain('An Agent file already exists')
  const proceed = [...document.body.querySelectorAll('button')].find((one) => one.textContent === 'Write these files')!
  expect((proceed as HTMLButtonElement).disabled).toBe(true)
})
