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
it.each(['code', 'wireCode'])('fences a rejected old Lead mutation before its %s can trigger a new-generation retry', async field => {
  let reject!: (error: unknown) => void
  let calls = 0
  let lead!: ReturnType<typeof createLeadState>
  const request = vi.fn(async (method: string) => {
    if (++calls === 1) return new Promise((_resolve, no) => { reject = no })
    return { ...lead.state, revision: 2, thread: null }
  }) as never
  lead = createLeadState({ request }, () => true)
  lead.changed({ method: 'lead/changed', params: { ...lead.state, revision: 1, settings: { caps: { usdMicros: 100, rounds: 3 } } } } as never)
  const update = lead.updateSettings({ caps: { usdMicros: 100, rounds: 4 } })
  lead.reset()
  lead.changed({ method: 'lead/changed', params: { ...lead.state, revision: 2, settings: { caps: { usdMicros: 100, rounds: 3 } } } } as never)
  reject({ [field]: 'lead-revision-stale' })
  await expect(update).rejects.toMatchObject({ code: 'lead-unavailable' })
  expect(request).toHaveBeenCalledExactlyOnceWith('lead/settings/update', { caps: { usdMicros: 100, rounds: 4 }, expectedRevision: 1 })
  expect(lead.state.revision).toBe(2)
})
it('does not project an old missing-folder rejection into a reset Lead', async () => {
  let reject!: (error: unknown) => void
  const request = vi.fn(() => new Promise((_resolve, no) => { reject = no })) as never
  const lead = createLeadState({ request }, () => true)
  const read = lead.readSettings()
  lead.reset()
  reject({ wireCode: 'lead-project-missing' })
  await expect(read).rejects.toMatchObject({ code: 'lead-unavailable' })
  expect(lead.state.projectMissing).not.toBe(true)
  expect(request).toHaveBeenCalledOnce()
})

it('invalidates a rejected old phone pairing response across reset', async () => {
  let reject!: (error: unknown) => void
  const request = vi.fn(() => new Promise((_resolve, no) => { reject = no })) as never
  const phone = createPhoneState({ request })
  const pairing = phone.pairing()
  phone.reset()
  reject(new Error('Old service refusal.'))
  await expect(pairing).rejects.toThrow('Mobile settings changed')
  expect(request).toHaveBeenCalledOnce()
  expect(phone.state.enabled).toBe(false)
})
