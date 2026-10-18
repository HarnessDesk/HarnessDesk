import { act, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { StoreProvider } from '../state/context'
import { AppStore } from '../state/store'
import { previewStore } from '../preview/harness'
import { leadPlan, leadProjection } from '../preview/lead-fixture'
import { DestinationPageScope } from '../panels/destination-page'
import { TopBarProvider, TopBarOutlet } from '../panels/top-bar'
import { LeadPage } from './LeadPage'
import { Settings } from './Settings'
import { Conversation } from './Conversation'
import { Sidebar } from './Sidebar'
import { settingsGroups } from './settings-navigation'
import { readDestination } from '../state/destinations'
import type { PageDestination } from '../state/destinations'

const cleanup: (() => void)[] = []
afterEach(() => { cleanup.splice(0).forEach(fn => fn()); vi.restoreAllMocks() })
const mount = async (page: 'lead' | 'settings' | 'session' = 'lead', available = true, cards = [leadPlan]) => {
  const store = new AppStore('ws://localhost:0/')
  Object.assign(store.getSnapshot(), previewStore({ leadAvailable: available }).getSnapshot())
  let projection = leadProjection()
  projection = { ...projection, thread: { ...projection.thread, cards } }
  store.lead.changed({ method: 'lead/changed', params: projection })
  const fixtureRequest = previewStore().transport.request.bind(previewStore().transport)
  vi.spyOn(store, 'runtimeResources').mockResolvedValue([])
  const request = vi.spyOn(store.transport, 'request').mockImplementation(async (method, input) => {
    if (method === 'lead/settings/update') {
      const update = input as any
      projection = { ...projection, revision: projection.revision + 1,
        settings: { ...projection.settings, ...(update.name ? { name: update.name } : {}) },
        thread: update.caps ? { ...projection.thread, cards: [...projection.thread.cards, { version: 1, id: 'widen', revision: 1, type: 'budget-change', contractDigest: null, logicalGoalId: 'demo', previous: { revision: 1, caps: projection.settings.caps }, proposed: update.caps }] } : projection.thread }
    }
    if (!method.startsWith('lead/')) return fixtureRequest(method, input as never)
    return projection as never
  })
  const box = document.createElement('div'); document.body.append(box); const root = createRoot(box)
  let navigate: (next: PageDestination) => void = () => {}
  vi.spyOn(store, 'openDestination').mockImplementation(next => navigate(next))
  const Surface = () => {
    const [destination, setDestination] = useState<PageDestination>(page === 'settings' ? { kind: 'settings', route: { kind: 'section', section: 'lead' as any, focus: null } } : { kind: 'lead' })
    navigate = setDestination
    return <TopBarProvider><TopBarOutlet owner="test" fallback={{ place: '', more: () => null }} />
      <Sidebar activeDestination="lead" onOpenSettings={() => {}} onOpenPlugins={() => {}} onOpenAgents={() => {}} onOpenTeams={() => {}} onOpenUsage={() => {}} onBrowseFolders={() => {}} onSignIn={() => {}} onSearch={() => {}} />
      <DestinationPageScope owner="test" active>{page === 'session' ? <Conversation header={false} composer={false} onChooseProject={() => {}} onSignIn={() => {}} onOpenUsage={() => {}} onOpenRuntimes={() => {}} /> : destination.kind === 'settings' ? <Settings route={destination.route} onRoute={route => setDestination({ kind: 'settings', route })} onSignIn={() => {}} /> : <LeadPage focus={destination.kind === 'lead' ? destination.focus : null} />}</DestinationPageScope>
    </TopBarProvider>
  }
  await act(async () => root.render(<StoreProvider store={store}><Surface /></StoreProvider>))
  cleanup.push(() => { act(() => root.unmount()); box.remove() })
  return { store, request, box, update: async (over: any) => { projection = { ...projection, ...over, revision: projection.revision + 1 }; await act(async () => store.lead.changed({ method: 'lead/changed', params: projection })) } }
}
const button = (box: Element, text: string) => [...box.querySelectorAll<HTMLButtonElement>('button')].find(node => node.textContent?.replace(/[123]$/, '') === text || node.getAttribute('aria-label') === text)!
const fill = async (node: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(node, value)
  node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true }))
})
it('renders the plan as an assistant message and docks the approval above the composer without a card border', async () => {
  const { box } = await mount()
  const message = box.querySelector('[data-lead-card="plan"]')!
  expect(message.closest('[data-slot="message"]')).not.toBeNull()
  expect(message.querySelector('[data-slot="card"], [data-slot="rows"], button')).toBeNull()
  expect(message.textContent).toContain("Here's my plan:")
  const dock = box.querySelector('[data-slot="conversation-dock"]')!
  expect(dock.querySelector('[data-slot="approval-card"]')).not.toBeNull()
  expect(button(dock, 'Approve')).toBeDefined(); expect(button(dock, 'Decline')).toBeDefined()
})
it.each(['lead', 'session'] as const)('uses the shared conversation shell for %s', async page => {
  const { box } = await mount(page)
  expect(box.querySelector('[data-slot="conversation-shell"]')).not.toBeNull()
  expect(box.querySelector('[data-slot="conversation-thread"]')).not.toBeNull()
  expect(box.querySelector('[data-slot="conversation-dock"]')).not.toBeNull()
})
it('keeps a decided message with a one-word state and removes the dock buttons', async () => {
  const { box, update } = await mount()
  await update({ planConsentExpiresAt: Date.now() + 86400000, thread: { ...leadProjection().thread, contract: leadPlan.contract, cards: [], decisions: [{ card: leadPlan, choice: 'approve', position: 1 }] } })
  expect(box.querySelector('[data-lead-card="plan"]')?.textContent).toContain('Approved')
  expect(box.querySelector('[data-slot="approval-card"]')).toBeNull()
  expect(box.querySelector('[data-lead-card="plan"]')?.textContent).not.toContain('expired')
})
it('saves Name immediately and shows Lex in the page, empty state, composer and sidebar', async () => {
  const { box, request, store } = await mount('settings', true, [])
  await act(async () => button(box, 'Lex').click())
  expect(request).toHaveBeenCalledWith('lead/settings/update', expect.objectContaining({ name: 'lex' }))
  await act(async () => store.openDestination({ kind: 'lead' }))
  expect(box.textContent).toContain("Hi, I'm Lex.")
  expect(box.querySelector('textarea')?.getAttribute('placeholder')).toBe('Message Lex…')
  expect(box.querySelector('button[title="Lead"]')?.getAttribute('aria-label')).toBe('Lex')
  expect(box.querySelector('h1')).toBeNull()
})
it('gates the Lead settings entry and its restored route with the host capability', async () => {
  const store = previewStore({ leadAvailable: false }), snapshot = store.getSnapshot()
  expect(settingsGroups(snapshot, snapshot.runtimes[0]!).flatMap(group => group.entries).some(entry => entry.id === 'lead')).toBe(false)
  expect(readDestination({ kind: 'settings', route: { kind: 'section', section: 'lead', focus: null } }, false)).toMatchObject({ kind: 'settings', route: { section: 'runtimes' } })
  const { box, request } = await mount('settings', false)
  expect(box.querySelector('[aria-label="Name"]')).toBeNull()
  expect(request.mock.calls.some(([method]) => method.startsWith('lead/'))).toBe(false)
})
it('a widening save shows the waiting line and Open lands on its decision message', async () => {
  const { box } = await mount('settings', true, [leadPlan])
  await fill(box.querySelector('[aria-label="Dollar allowance"]')!, '10')
  await act(async () => button(box, 'Save allowances').click())
  expect(box.textContent).toContain('Waiting for your approval in the conversation')
  await act(async () => button(box, 'Open').click())
  expect(box.querySelector('[data-lead-card="widen"]')).not.toBeNull()
  expect(document.activeElement?.closest('[data-lead-decision]')?.getAttribute('data-lead-decision')).toBe('widen')
})
it('empties the uncontrolled credential input before a refused request', async () => {
  const { box, request } = await mount('settings')
  await act(async () => button(box, 'Replace…').click())
  const key = box.querySelector<HTMLInputElement>('input[type="password"]')!
  await fill(key, 'sk-synthetic-only-1234')
  request.mockRejectedValueOnce({ code: 'lead-secret-refused' })
  await act(async () => button(box, 'Save').click())
  expect(key.value).toBe('')
  expect(box.innerHTML).not.toContain('sk-synthetic-only-1234')
  expect(box.querySelector('[role="alert"]')).not.toBeNull()
})
