import { describe, expect, it, vi } from 'vitest'

const load = async () => {
  const modules = import.meta.glob('./lead.ts')
  expect(typeof modules['./lead.ts'], 'typed Lead facade must exist').toBe('function')
  return await modules['./lead.ts']!() as any
}
const settings = { version: 1, model: 'fixture-model', key: { configured: false, protection: 'unavailable' },
  policy: { version: 1, revision: 1, mode: 'default', rules: [] }, caps: { usdMicros: 100, rounds: 3 } }
const thread = (revision = 1, state = 'draft', cards: unknown[] = []) => ({ version: 1, id: 'lead', revision, state,
  project: null, olderMessages: 0, messages: [], cards })
const projection = (revision: number, state = 'running', cards: unknown[] = []) => ({ version: 1, revision, thread: thread(revision, state, cards), settings, wayOut: state === 'stopped' ? null : cards.length ? 'decide-plan' : state === 'waiting-for-user' ? 'resume' : null })

describe('Lead state facade', () => {
  it('gates every operation on capability and has a typed caller for all six controls', async () => {
    const { createLeadState } = await load()
    let available = false
    const request = vi.fn(async (method: string) => method === 'lead/thread/read' || method === 'lead/settings/read' ? projection(1, 'draft') :
      method === 'lead/thread/send' ? { messageId: 'message-1', revision: 2 } : projection(3))
    const facade = createLeadState({ request }, () => available)
    await expect(facade.readThread()).rejects.toMatchObject({ code: 'lead-unavailable' })
    expect(request).not.toHaveBeenCalled()
    available = true
    await facade.readThread(); await facade.readSettings()
    await facade.send('Inspect the check', 'send-1')
    await facade.decide({ version: 1, cardId: 'plan', cardType: 'plan', expectedRevision: 1, contractDigest: 'a'.repeat(64), choice: 'approve' })
    await facade.updateSettings({ credential: { provider: 'anthropic', key: 'sk-test-not-real-0000' } })
    await facade.resume()
    expect(new Set(request.mock.calls.map(call => call[0]))).toEqual(new Set(['lead/thread/read', 'lead/settings/read', 'lead/thread/send', 'lead/card/decide', 'lead/settings/read', 'lead/settings/update', 'lead/resume']))
    expect(request).toHaveBeenCalledWith('lead/resume', { expectedRevision: 3 })
    expect(JSON.stringify(facade.state)).not.toContain('sk-test-not-real-0000')
  })
  it('derives resume versus plan decision and ignores delayed projections', async () => {
    const { createLeadState } = await load()
    const facade = createLeadState({ request: vi.fn() }, () => true)
    facade.changed({ method: 'lead/changed', params: projection(3, 'waiting-for-user') })
    expect(facade.state.wayOut).toBe('resume')
    facade.changed({ method: 'lead/changed', params: projection(2, 'running') })
    expect(facade.state.revision).toBe(3)
    facade.changed({ method: 'lead/changed', params: projection(4, 'waiting-for-user', [{ type: 'plan', id: 'plan', revision: 1 }]) })
    expect(facade.state.wayOut).toBe('decide-plan')
    facade.changed({ method: 'lead/changed', params: projection(5, 'stopped') })
    expect(facade.state.wayOut).toBe(null)
  })
})
