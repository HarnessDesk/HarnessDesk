import { expect, it, vi } from 'vitest'
import { createPhoneState } from './phone'
import { createLeadState } from './lead'

it('rejects a pending pairing and phone refresh from before disable even after reenable', async () => {
  let resolve!: (value: unknown) => void
  const request = vi.fn(() => new Promise(yes => { resolve = yes })) as never
  const phone = createPhoneState({ request })
  const pairing = phone.pairing()
  phone.reset()
  resolve({ url: 'harnessdesk://pair?c=old' })
  await expect(pairing).rejects.toThrow('Mobile settings changed')
  const refresh = phone.refresh()
  phone.reset()
  resolve({ enabled: true })
  await expect(refresh).rejects.toThrow('Mobile settings changed')
  expect(phone.state.enabled).toBe(false)
})
it('rejects Lead reads that span a disable and reenable', async () => {
  let resolve!: (value: unknown) => void
  const request = vi.fn(() => new Promise(yes => { resolve = yes })) as never
  const lead = createLeadState({ request }, () => true)
  const read = lead.readSettings()
  lead.reset()
  resolve({ revision: 2, settings: { name: 'lex' } })
  await expect(read).rejects.toThrow('Lead settings changed')
  expect(lead.state.settings).toBeNull()
})
