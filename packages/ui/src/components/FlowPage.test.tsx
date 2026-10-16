import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AuthoringDocument } from '@harnessdesk/protocol'
import { DestinationPageScope } from '../panels/destination-page'
import { StoreProvider } from '../state/context'
import { emptySnapshot, type AppStore } from '../state/store'
import { FlowPage } from './FlowPage'
import type { FlowPageStart } from '../state/destinations'

vi.mock('./ShapeEditor', () => ({ ShapeEditor: (props: { readonly document?: AuthoringDocument; readonly presentation: string; readonly context: unknown; readonly goal?: unknown; readonly onStartTeam: (source: string) => void; readonly onUpdate?: () => void }) => <div data-editor={props.presentation} data-context={JSON.stringify(props.context)} data-goal={JSON.stringify(props.goal)}>{props.document?.source ?? 'Blank Flow'}<button onClick={() => props.onStartTeam('current edited source')}>Start a Team</button><button onClick={props.onUpdate}>Update</button></div> }))
vi.mock('./FrontDoor', () => ({ FrontDoor: (props: { readonly initialSource: string; readonly context: unknown; readonly goal?: unknown; readonly initialTask?: string; readonly initialDone?: string }) => <div data-front-door data-context={JSON.stringify(props.context)} data-goal={JSON.stringify(props.goal)} data-task={props.initialTask} data-done={props.initialDone}>{props.initialSource}</div> }))
vi.mock('./FlowUpdate', () => ({ FlowUpdate: (props: { readonly mode: string; readonly onApplied: () => void }) => <button data-update={props.mode} onClick={props.onApplied}>Apply update</button> }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let container: HTMLDivElement
let root: Root
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container) })
afterEach(() => { act(() => root.unmount()); container.remove(); vi.restoreAllMocks() })
const doc = (id: string): AuthoringDocument => ({ target: { kind: 'flow', root: '/repo', origin: 'project', id }, source: `${id} source`, digest: `${id}-digest`, exists: true, writable: true, displayPath: `.harnessdesk/flows/${id}.yml`, issues: [] })
const setup = (readAuthoring = vi.fn(async () => doc('review'))) => {
  const snapshot = emptySnapshot()
  const store = { getSnapshot: () => snapshot, subscribe: () => () => {}, readAuthoring, openGoal: vi.fn() } as unknown as AppStore
  const render = async (id: string | null, active = true, start?: FlowPageStart) => act(async () => root.render(<StoreProvider store={store}><DestinationPageScope owner="flows" active={active}><FlowPage root="/repo" id={id} start={start} onBack={vi.fn()} /></DestinationPageScope></StoreProvider>))
  return { render, readAuthoring }
}
it('waits for its destination to be active before reading a catalogue file', async () => {
  const { render, readAuthoring } = setup()
  await render('review', false)
  expect(readAuthoring).not.toHaveBeenCalled()
  await render('review')
  expect(readAuthoring).toHaveBeenCalledWith({ kind: 'flow', root: '/repo', id: 'review', origin: 'project' })
  expect(container.querySelector('[data-editor="page"]')?.textContent).toContain('review source')
})
it('a blank Flow starts the shared New Team dialog with the current source and hides it while away', async () => {
  const { render, readAuthoring } = setup()
  await render(null)
  expect(readAuthoring).not.toHaveBeenCalled()
  act(() => container.querySelector('button')!.click())
  expect(container.querySelector('[data-front-door]')?.textContent).toBe('current edited source')
  await render(null, false)
  expect(container.querySelector('[data-front-door]')).toBeNull()
})
it('ignores a late file read after a different Flow takes its place', async () => {
  let first!: (value: AuthoringDocument) => void
  const read = vi.fn().mockImplementationOnce(() => new Promise<AuthoringDocument>(resolve => { first = resolve })).mockResolvedValueOnce(doc('build'))
  const { render } = setup(read)
  await render('review')
  await render('build')
  await act(async () => first(doc('review')))
  expect(container.textContent).toContain('build source')
  expect(container.textContent).not.toContain('review source')
})
it('keeps the originating target and empty Team through editing and the shared start dialog', async () => {
  const { render } = setup()
  const start: FlowPageStart = { context: { kind: 'pull-request', root: '/repo', number: 42 }, goal: { id: 'team-1', revision: 3 }, task: 'Review this change', done: 'Checks pass' }
  await render(null, true, start)
  const editor = container.querySelector<HTMLElement>('[data-editor]')!
  expect(JSON.parse(editor.dataset.context!)).toEqual(start.context)
  expect(JSON.parse(editor.dataset.goal!)).toEqual(start.goal)
  act(() => container.querySelector('button')!.click())
  const dialog = container.querySelector<HTMLElement>('[data-front-door]')!
  expect(JSON.parse(dialog.dataset.context!)).toEqual(start.context)
  expect(JSON.parse(dialog.dataset.goal!)).toEqual(start.goal)
  expect(dialog.dataset.task).toBe(start.task)
  expect(dialog.dataset.done).toBe(start.done)
})
it('rereads the document after the existing legacy update applies', async () => {
  const read = vi.fn().mockResolvedValueOnce(doc('review')).mockResolvedValueOnce({ ...doc('review'), source: 'current format source', digest: 'updated' })
  const { render } = setup(read)
  await render('review')
  act(() => [...container.querySelectorAll('button')].find(button => button.textContent === 'Update')!.click())
  expect(container.querySelector('[data-update="update"]')).not.toBeNull()
  await act(async () => container.querySelector<HTMLButtonElement>('[data-update]')!.click())
  expect(read).toHaveBeenCalledTimes(2)
  expect(container.textContent).toContain('current format source')
})
