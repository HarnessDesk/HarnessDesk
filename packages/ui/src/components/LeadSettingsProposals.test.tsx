import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { createLeadFixtureStore } from '../preview/frames-lead'
import { LEAD_RULE_DEFAULTS } from '@harnessdesk/protocol'
import { leadSettingsProposals, leadSettingsWordsProposal } from '../preview/lead-fixture'
import { StoreProvider } from '../state/context'
import { DestinationPageScope } from '../panels/destination-page'
import { TopBarProvider } from '../panels/top-bar'
import { LeadPage } from './LeadPage'
import { LEAD_SETTINGS_EFFECT, LeadSettingsProposals, leadSettingsProposalTitle } from './LeadSettingsProposals'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const clean: (() => void)[] = []
afterEach(() => clean.splice(0).forEach(fn => fn()))
const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
const mount = async (node: React.ReactNode) => {
  const store = createLeadFixtureStore('autonomy-proposal'), box = document.createElement('div'); document.body.append(box)
  const calls: { method: string; params: any }[] = []
  const request = store.transport.request.bind(store.transport)
  store.transport.request = (async (method: string, params: unknown) => { calls.push({ method, params }); return request(method as never, params as never) }) as typeof store.transport.request
  const root = createRoot(box)
  await act(async () => root.render(<StoreProvider store={store}>{node}</StoreProvider>))
  await settle()
  clean.push(() => { act(() => root.unmount()); box.remove() })
  return { box, calls, store }
}
const buttons = (box: ParentNode, label: string) => [...box.querySelectorAll('button')].filter(one => one.textContent === label)

it('#2106: each card says what it changes and when it takes effect, and an asked-again card says so', async () => {
  const { box } = await mount(<LeadSettingsProposals proposals={leadSettingsProposals} />)
  expect(leadSettingsProposalTitle(leadSettingsProposals[0]!)).toBe('Desk-change reports: Act → Observe')
  expect(box.textContent).toContain('Desk-change reports: Act → Observe')
  expect(box.textContent).toContain('Lead every report with the conclusion.')
  expect(box.textContent).toContain('How to talk to me')
  expect(box.textContent).toContain(LEAD_SETTINGS_EFFECT.autonomy)
  expect(box.textContent).toContain(LEAD_SETTINGS_EFFECT.rules)
  expect(box.textContent).toContain('Asked again')
  expect(buttons(box, 'Apply')).toHaveLength(2)
  expect(buttons(box, 'No')).toHaveLength(2)
})

it('#2106: Apply and No under the Lead reply send the person\'s decision, and an answered card leaves the thread', async () => {
  const { box, calls, store } = await mount(<TopBarProvider><DestinationPageScope owner="lead-test" active><LeadPage /></DestinationPageScope></TopBarProvider>)
  const cards = box.querySelector('[data-slot="lead-settings-proposals"]')!
  expect(cards, 'the proposals sit under the reply that made them').toBeTruthy()
  await act(async () => buttons(cards, 'Apply')[0]!.click())
  await settle()
  expect(calls.filter(call => call.method === 'lead/settings/decide').map(call => call.params)).toEqual([{ id: 's2', decision: 'apply' }])
  expect(store.lead.state.autonomy?.proposals?.find(one => one.id === 's2')?.state).toBe('applied')
  await act(async () => buttons(box.querySelector('[data-slot="lead-settings-proposals"]')!, 'No')[0]!.click())
  await settle()
  expect(calls.filter(call => call.method === 'lead/settings/decide').map(call => call.params).at(-1)).toEqual({ id: 's1', decision: 'decline' })
  expect(box.querySelector('[data-slot="lead-settings-proposals"]'), 'no card waits once both are answered').toBeNull()
  // The page never writes a mode or a rule itself: the decision is the only call that changes a setting.
  expect(calls.some(call => call.method === 'lead/autonomy/set' || call.method === 'lead/rules/update')).toBe(false)
})

it('#2106 review: the Lead\'s words are drawn as plain text, without terminal control sequences', async () => {
  const [, line] = leadSettingsProposals
  const hostile = { ...line!, id: 's9', change: { ...line!.change, add: '\x1b[1mLead\x1b[0m with <b onclick=x>the conclusion</b>\x07' } } as typeof line
  const { box } = await mount(<LeadSettingsProposals proposals={[hostile!]} />)
  const row = box.querySelector('[data-slot="row"]')!
  expect(row.textContent).toContain('Lead with <b onclick=x>the conclusion</b>')
  expect(row.textContent).not.toMatch(/[\x1b\x07]/)
  expect(box.querySelector('b')).toBeNull()
})

it('#2106 review: a section\'s whole new words sit inside their own row, as what changes against the words in force', async () => {
  const { box, store } = await mount(<LeadSettingsProposals proposals={[leadSettingsWordsProposal]} />)
  await act(async () => { await store.lead.readAutonomy() })
  const words = box.querySelector('[aria-label="What changes in What counts as done"]')!
  expect(words, 'the words are drawn').toBeTruthy()
  const row = words.closest('[data-slot="row"]')!
  expect(row, 'inside a row, never after the list').toBeTruthy()
  expect(buttons(row, 'Apply'), 'the row the words sit in is the one Apply answers').toHaveLength(1)
  expect(words.textContent).toContain(`- ${LEAD_RULE_DEFAULTS.done.text}`)
  expect(words.textContent).toContain('+ Done means every check run is green and the person reviewed it.')
  expect(row.textContent).toContain(LEAD_SETTINGS_EFFECT.rules)
})
