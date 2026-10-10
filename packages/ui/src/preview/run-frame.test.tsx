import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { RunInspectorExample } from './frames-run-inspector'
import { RunControlExample } from './frames-run-controls'
import { StopRunExample } from './frames-stop-run'
import { ReviewPublicationExample } from './frames-review-publication'
import { RunShapesFrame } from './frames-run-shapes'
import { FRAME } from '../design'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: ReturnType<typeof createRoot>[] = []
const mount = async (node: React.ReactNode) => {
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  await act(async () => root.render(node))
  return container
}
afterEach(() => { roots.forEach(root => act(() => root.unmount())); roots.length = 0; document.body.replaceChildren(); vi.restoreAllMocks() })
it.each(['inspector', 'controls', 'stop'] as const)('the standalone %s board owns the store required by its real Run producer', async scene => {
  const node = scene === 'inspector' ? <RunInspectorExample scene="check" /> : scene === 'controls' ? <RunControlExample scene="abandon" /> : <StopRunExample scene="cleanup" />
  const container = await mount(node)
  expect(container.querySelector('[data-slot="top-bar"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="run-inspector"]')).not.toBeNull()
})
it.each([390, 1440])('publication uses one actual Details body for aggregate and selected-round facts at %ipx', async width => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, width, 900))
  const container = await mount(<ReviewPublicationExample scene="local" />)
  const panel = container.querySelector<HTMLElement>('[data-preview-tool-placement]')!
  expect(panel).not.toBeNull()
  expect(panel.dataset.previewToolPlacement).toBe(width < FRAME.fold.panelFloats ? 'floating' : 'column')
  expect(panel.style.width).toBe(`${FRAME.rightPanel.width}px`)
  expect(container.querySelectorAll('[data-slot="tool-body"]')).toHaveLength(1)
  expect(panel.querySelector('[aria-label="Team Run facts"]')).not.toBeNull()
  expect(panel.querySelector('[data-slot="run-inspector"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="workbench-main"] [data-slot="run-inspector"]')).toBeNull()
})
it('shapes preserves main while explicit inspection uses the original fixed Details tool', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 1440, 900))
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  const container = await mount(<RunShapesFrame scene="comparison" />)
  const panel = container.querySelector<HTMLElement>('[data-preview-tool-placement]')!
  expect(panel).not.toBeNull()
  expect(panel.style.width).toBe(`${FRAME.rightPanel.width}px`)
  await act(async () => container.querySelector<HTMLButtonElement>('[data-row][data-kind="card"] button')!.click())
  expect(panel.querySelector('[data-slot="run-inspector"]')).not.toBeNull()
  expect(container.querySelector('[data-slot="workbench-main"] [data-slot="run-reading"]')).not.toBeNull()
})

it('shared Git preview authors use public placeholder identities before any bundle rewrite', async () => {
  const { gitLog, gitCommit } = await import('./git-fixture')
  const commits = gitLog().commits
  expect(commits.every(commit => commit.author === 'Jane Doe' && commit.authorEmail.endsWith('@example.com'))).toBe(true)
  expect(commits.every(commit => gitCommit(commit.sha)?.committer === 'Jane Doe')).toBe(true)
})

it('the narrow canonical tool door closes seeded inspection and original selection reopens it', async () => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 390, 900))
  const container = await mount(<RunInspectorExample scene="check-attempts" />)
  expect(container.querySelector('[data-preview-tool-placement="floating"] [data-slot="run-inspector"]')).not.toBeNull()
  const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Toggle right panel"]')
  expect(toggle).not.toBeNull()
  await act(async () => toggle!.click())
  expect(container.querySelector('[data-preview-tool-placement]')).toBeNull()
  const check = container.querySelector<HTMLButtonElement>('[data-row="check-2-2"] button')!
  await act(async () => check.click())
  expect(container.querySelector('[data-preview-tool-placement="floating"] [data-slot="run-inspector"]')?.textContent).toContain('Attempt 2')
})

it('the supported terminal specimen opens and closes the real PreviewStore resource', async () => {
  const { TerminalToggleSpecimen } = await import('./frames-supported-controls')
  const container = await mount(<TerminalToggleSpecimen />)
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Open terminal"]')!.click())
  expect(container.textContent).toContain('1 terminal resources')
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close terminal"]')!.click())
  expect(container.textContent).toContain('0 terminal resources')
})
it('the main work specimen changes actual Fill state and restores the layout without arrangement actions', async () => {
  const { MainWorkActionsSpecimen } = await import('./frames-supported-controls')
  const container = await mount(<MainWorkActionsSpecimen />)
  expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(0)
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Fill the window"]')!.click())
  expect(container.querySelector('[aria-label="Back to the layout"]')).not.toBeNull()
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Back to the layout"]')!.click())
  expect(container.querySelector('[aria-label="Fill the window"]')).not.toBeNull()
})
it('the supported plan specimen opens its real recorded Weekly allowance and dispatches its details action', async () => {
  const { PlanMetersSpecimen } = await import('./frames-supported-controls')
  const container = await mount(<PlanMetersSpecimen />)
  await act(async () => container.querySelector<HTMLButtonElement>('[data-slot="plan-meter"]')!.closest('button')!.click())
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('Weekly')
  expect(document.querySelector('[role="menu"]')?.textContent).toContain('79%')
  await act(async () => document.querySelector<HTMLButtonElement>('[role="menu"] button')!.click())
  expect(container.textContent).toContain('Recorded plan opened')
})

it('PreviewStore terminal cleanup preserves main and every nonterminal right-tool resource', async () => {
  const { previewStore } = await import('./harness')
  const { dock, dockViews } = await import('../state/workbench')
  const store = previewStore(), before = store.getSnapshot()
  const terminal = { kind: 'terminal' as const, terminalId: 'fixture-terminal', runtime: before.activeRuntime!, cwd: '/repo' }
  const withTools = dock(dock(before.workbench, 'right', { kind: 'changes' }), 'right', { kind: 'activity' })
  const held = dockViews(withTools.right)
  const workbench = dock(dock(withTools, 'bottom', terminal), 'right', { ...terminal, terminalId: 'fixture-terminal-2' })
  store.patch({ workbench, layout: workbench.main })
  act(() => store.closeTerminalDock())
  expect(store.getSnapshot().workbench.main).toBe(before.workbench.main)
  expect(dockViews(store.getSnapshot().workbench.bottom)).toHaveLength(0)
  expect(dockViews(store.getSnapshot().workbench.right)).toEqual(held)
})
