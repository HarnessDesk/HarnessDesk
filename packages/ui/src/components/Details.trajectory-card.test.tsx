import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { itemId, turnId, type Session } from '@harnessdesk/protocol'
import { previewStore, PREVIEW_SESSION_KEY } from '../preview/harness'
import { StoreProvider } from '../state/context'
import { TrajectoryCard } from './Details'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); document.body.replaceChildren() })
const render = async (patch: Partial<Session>, hideEmpty = true) => {
  const seed = previewStore().getSnapshot()
  const session = { ...seed.sessions.get(PREVIEW_SESSION_KEY)!, turns: [], itemsLoaded: true, ...patch }
  const store = previewStore({ ...seed, sessions: new Map([[PREVIEW_SESSION_KEY, session]]) })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  await act(async () => root.render(<StoreProvider store={store}><TrajectoryCard hideEmpty={hideEmpty} /></StoreProvider>))
  return container
}
it('omits only a successfully loaded empty optional trajectory', async () => {
  expect((await render({})).querySelector('[aria-label="Trajectory"]')).toBeNull()
  expect((await render({ itemsLoaded: false })).querySelector('[aria-label="Trajectory"]')).not.toBeNull()
  expect((await render({}, false)).querySelector('[aria-label="Trajectory"]')).not.toBeNull()
})
it('retains untimed recorded steps and failed turns instead of mistaking them for no data', async () => {
  const untimed = await render({ turns: [{ id: turnId('untimed'), status: 'completed', items: [{ id: itemId('response'), type: 'assistantMessage', text: 'Recorded result' }] }] })
  expect(untimed.querySelector('[aria-label="Trajectory"]')).not.toBeNull()
  const failed = await render({ turns: [{ id: turnId('failed'), status: 'failed', items: [] }] })
  expect(failed.querySelector('[aria-label="Trajectory"]')).not.toBeNull()
})
