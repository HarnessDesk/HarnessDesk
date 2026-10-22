import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { PhoneLinkState } from '@harnessdesk/protocol'
import { createPhoneState } from '../state/phone'
import { PhoneSettings } from './PhoneSettings'

const clean: (() => void)[] = []
afterEach(() => { clean.splice(0).forEach(fn => fn()); document.body.innerHTML = '' })

const linked: PhoneLinkState = {
  enabled: true, deskName: 'Studio', deskId: 'desk', port: 4455,
  devices: [{ id: 'd1', name: 'Jane Doe’s phone', tiers: ['read', 'run', 'answer'], createdAt: 1, lastSeenAt: null }],
  pending: [{ id: 'p1', name: 'Jane Doe’s tablet', deviceId: 'd2', requestedAt: 2 }],
}
const mount = (state: PhoneLinkState, pairing: { url: string; expiresAt: number; addresses: [] } | null = null) => {
  const box = document.createElement('div'); document.body.append(box)
  const root = createRoot(box)
  const handlers = { onPair: vi.fn(), onAllow: vi.fn(), onDeny: vi.fn(), onRevoke: vi.fn() }
  act(() => root.render(<PhoneSettings state={state} pairing={pairing} error={null} busy={false} {...handlers} />))
  clean.push(() => { act(() => root.unmount()); box.remove() })
  return { box, ...handlers }
}
const press = (label: string, scope: ParentNode = document) =>
  act(() => { [...scope.querySelectorAll('button')].find(b => b.textContent === label)!.click() })

it('says the link is off when the desk was not started with it', () => {
  const { box } = mount({ ...linked, enabled: false })
  expect(box.textContent).toContain('The phone link is off on this desk.')
  expect(box.querySelector('button')).toBeNull()
})
it('lists paired phones and waiting ones, and answers each', () => {
  const { box, onAllow, onDeny } = mount(linked)
  expect(box.textContent).toContain('Jane Doe’s phone')
  expect(box.textContent).toContain('Allow Jane Doe’s tablet?')
  press('Allow', box); expect(onAllow).toHaveBeenCalledWith(linked.pending[0])
  press('Not now', box); expect(onDeny).toHaveBeenCalledWith(linked.pending[0])
})
it('draws the code from the link and asks before removing a phone', () => {
  const { box, onRevoke, onPair } = mount(linked, { url: 'harnessdesk://pair?c=abc', expiresAt: Date.now() + 1000, addresses: [] })
  expect(box.querySelector('[aria-label="Pairing code"] svg')).not.toBeNull()
  press('New code', box); expect(onPair).toHaveBeenCalled()
  press('Remove', box)
  expect(onRevoke).not.toHaveBeenCalled()
  press('Remove phone'); expect(onRevoke).toHaveBeenCalledWith(linked.devices[0])
})
it('the state follows the host: notifications replace it, a reset turns it off, actions name the method', async () => {
  const request = vi.fn(async () => linked) as never
  const phone = createPhoneState({ request })
  const seen = vi.fn(); phone.subscribe(seen)
  phone.changed({ method: 'phone/changed', params: linked })
  expect(phone.state.devices).toHaveLength(1); expect(seen).toHaveBeenCalledTimes(1)
  await phone.allow('p1'); await phone.revoke('d1'); await phone.deny('p1'); await phone.pairing()
  expect((request as unknown as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])).toEqual(['phone/allow', 'phone/revoke', 'phone/deny', 'phone/pairing'])
  phone.reset(); expect(phone.state.enabled).toBe(false)
})
