import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { itemId, sessionKey, turnId, type Session } from '@harnessdesk/protocol'
import { StoreProvider, PaneProvider } from '../state/context'
import { previewStore, PREVIEW_SESSION_KEY } from '../preview/harness'
import { ConversationDetails } from './work-details'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: ReturnType<typeof createRoot>[] = []
afterEach(() => { for (const root of roots.splice(0)) act(() => root.unmount()); document.body.replaceChildren() })

it('keeps conversation facts, plan and its background work beside a folded time summary', async () => {
  const seed = previewStore().getSnapshot()
  const session: Session = { ...seed.sessions.get(PREVIEW_SESSION_KEY)!, turns: [{
    id: turnId('timed'), status: 'completed' as const, durationMs: 6 * 60_000,
    plan: [{ step: 'Verify the result', status: 'pending' }],
    items: [{ id: itemId('command'), type: 'command', command: 'pnpm test', status: 'completed', durationMs: 60_000, actions: [], output: '', cwd: '/work/storefront', origin: 'agent' }],
  }] }
  const store = previewStore({ ...seed, sessions: new Map([[PREVIEW_SESSION_KEY, session]]), tasks: new Map([
    [PREVIEW_SESSION_KEY, [{ id: 'own', label: 'Watch this project', kind: 'command', state: 'running', stoppable: true }]],
    [sessionKey('other', 'foreign'), [{ id: 'foreign', label: 'Foreign background work', kind: 'command', state: 'running', stoppable: true }]],
  ]) })
  const stopTask = vi.fn(), clearTasks = vi.fn()
  Object.assign(store, { stopTask, clearTasks })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  await act(async () => root.render(<StoreProvider store={store}><PaneProvider scope={{ paneId: 'owner', view: { kind: 'conversation', session: PREVIEW_SESSION_KEY }, sessionKey: PREVIEW_SESSION_KEY }}>
    <ConversationDetails session={session} placeAction={<button>Folder action</button>} />
  </PaneProvider></StoreProvider>))
  expect([...container.querySelectorAll('[data-slot="tool-section"]')].map(one => one.getAttribute('aria-label'))).toEqual(['Conversation', 'Plan', 'Seat record', 'Background tasks', 'Trajectory'])
  expect(container.querySelector('[aria-label="Conversation facts"]')?.textContent).toContain('Folder action')
  expect(container.textContent).toContain('Watch this project')
  expect(container.textContent).not.toContain('Foreign background work')
  const trajectory = container.querySelector('[aria-label="Trajectory"]')!
  expect(trajectory.querySelector('[data-slot="tool-section-fold"]')?.getAttribute('aria-expanded')).toBe('false')
  expect(trajectory.querySelector('[data-slot="tool-section-value"]')?.textContent).toBe('6m · 1m in commands')
  for (const section of container.querySelectorAll('[data-slot="tool-section"]')) {
    expect(section.querySelector('[data-slot="tool-section-fold"]'), section.getAttribute('aria-label')!).not.toBeNull()
  }
  expect(container.querySelector('[aria-label="Plan"] [data-slot="tool-section-value"]')?.textContent).toBe('1 step')
  expect(container.querySelector('[aria-label="Events"]')).toBeNull()
  expect(container.querySelectorAll('[data-slot="tool-scroll"]')).toHaveLength(1)
  expect(container.querySelector('[data-slot="inspector-body"]')).toBeNull()
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Stop Watch this project"]')!.click())
  expect(stopTask).toHaveBeenCalledWith('own', PREVIEW_SESSION_KEY)
})

it('omits an empty plan and empty agent filters while keeping permission details and export reachable', async () => {
  const seed = previewStore().getSnapshot()
  const session: Session = { ...seed.sessions.get(PREVIEW_SESSION_KEY)!, turns: [], settings: { ...seed.sessions.get(PREVIEW_SESSION_KEY)!.settings!, ceiling: { level: 'edit', hold: 'asked' }, ceilingNote: 'A detailed runtime explanation that belongs behind Details.' } }
  const store = previewStore({ ...seed, sessions: new Map([[PREVIEW_SESSION_KEY, session]]) })
  const container = document.createElement('div'); document.body.append(container)
  const root = createRoot(container); roots.push(root)
  await act(async () => root.render(<StoreProvider store={store}><ConversationDetails session={session} /></StoreProvider>))
  expect(container.querySelector('[aria-label="Plan"]')).toBeNull()
  expect(container.querySelector('[aria-label="Filter sub-agents"]')).toBeNull()
  const facts = container.querySelector('[aria-label="Conversation facts"]')!
  expect(facts.textContent).toContain('Asked, not held')
  expect(facts.textContent).not.toContain('A detailed runtime explanation')
  const details = [...container.querySelectorAll('button')].find(one => one.textContent?.includes('Details'))!
  act(() => details.click())
  expect(container.textContent).toContain('A detailed runtime explanation')
  expect(container.querySelector('[aria-label="Conversation actions"]')).not.toBeNull()
})
