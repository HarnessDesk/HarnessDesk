import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { AccountLinkState } from '@harnessdesk/protocol'
import { AccountLinkSettings } from './AccountLinkSettings'
import { createAccountLinkState } from '../state/account-link'

const clean: (() => void)[] = []
afterEach(() => { clean.splice(0).forEach(fn => fn()); document.body.innerHTML = ''; vi.useRealTimers() })
const mount = (state: AccountLinkState) => {
  const box = document.createElement('div'); document.body.append(box); const root = createRoot(box)
  const actions = { onStart: vi.fn(), onCancel: vi.fn(), onOpen: vi.fn(), onCopy: vi.fn() }
  act(() => root.render(<AccountLinkSettings state={state} {...actions} />))
  clean.push(() => act(() => root.unmount()))
  return { box, ...actions }
}
const press = (box: HTMLElement, label: string) => act(() => [...box.querySelectorAll('button')].find(b => b.textContent === label)!.click())
it('is absent without the capability', () => { expect(mount({ status: 'unavailable' }).box.textContent).toBe('') })
it('starts an unlinked desk', () => {
  const r = mount({ status: 'idle' }); expect(r.box.textContent).toContain('Link to your account'); press(r.box, 'Link'); expect(r.onStart).toHaveBeenCalledOnce()
})
it('shows a selectable code, browser and copy actions, cancel, and a ticking deadline', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-24T12:00:00Z'))
  const r = mount({ status: 'waiting', userCode: 'ABCD-EFGH', verifyUrl: 'https://example.com/link', expiresAt: Date.now() + 61_000 })
  expect(r.box.textContent).toContain('ABCD-EFGH'); expect(r.box.textContent).toContain('1:01 left'); expect(r.box.querySelector('[data-link-code]')?.className).toContain('select-text')
  press(r.box, 'Open the link page'); expect(r.onOpen).toHaveBeenCalledWith('https://example.com/link')
  press(r.box, 'Copy code'); expect(r.onCopy).toHaveBeenCalledWith('ABCD-EFGH')
  press(r.box, 'Cancel'); expect(r.onCancel).toHaveBeenCalledOnce()
  act(() => vi.advanceTimersByTime(2000)); expect(r.box.textContent).toContain('0:59 left')
})
it('shows a linked chip and date', () => {
  const r = mount({ status: 'linked', deskId: 'desk', linkedAt: new Date('2026-10-24T12:00:00Z').getTime() })
  expect(r.box.textContent).toContain('Linked'); expect(r.box.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-24T12:00:00.000Z'); expect(r.box.querySelector('button')).toBeNull()
})
for (const status of ['denied', 'expired'] as const) it(`explains ${status} and retries`, () => {
  const r = mount({ status }); expect(r.box.textContent).toContain(status === 'denied' ? 'declined' : 'expired'); press(r.box, 'Try again'); expect(r.onStart).toHaveBeenCalledOnce()
})
it('renders plain host errors and disables duplicate starts', () => {
  const r = mount({ status: 'error', reason: 'Too many attempts. Try again later.' }); expect(r.box.textContent).toContain('Too many attempts')
  const pending = mount({ status: 'starting' }); expect(pending.box.querySelector('button')?.disabled).toBe(true)
})
it('follows notifications and ignores stale reads after a reset or newer notification', async () => {
  let answer!: (s: AccountLinkState) => void
  const request = vi.fn(() => new Promise<AccountLinkState>(r => { answer = r }))
  const state = createAccountLinkState({ request: request as never }); const reading = state.refresh()
  state.changed({ method: 'account/link/changed', params: { status: 'linked', deskId: 'desk', linkedAt: 1 } })
  answer({ status: 'idle' }); await reading; expect(state.state.status).toBe('linked')
  const stale = state.refresh(); state.reset(); answer({ status: 'idle' }); await stale; expect(state.state.status).toBe('unavailable')
})

it('sends actions only through the host and converts transport failures to a plain state', async () => {
  const request = vi.fn(async (_method: string, _params: unknown) => ({ status: 'idle' }))
  const state = createAccountLinkState({ request: request as never })
  await state.start(); await state.cancel()
  expect(request.mock.calls.map(c => c[0])).toEqual(['account/link/start', 'account/link/cancel'])
  request.mockRejectedValueOnce(new Error('offline'))
  await state.refresh(); expect(state.state.status).toBe('error')
})
