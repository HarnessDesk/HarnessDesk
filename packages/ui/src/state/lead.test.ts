import { describe, expect, it, vi } from 'vitest'

const load = async () => {
  const modules = import.meta.glob('./lead.ts')
  expect(typeof modules['./lead.ts'], 'typed Lead facade must exist').toBe('function')
  return await modules['./lead.ts']!() as any
}
const settings = { version: 1, name: 'dex', model: 'fixture-model', key: { configured: false, protection: 'unavailable' },
  policy: { version: 1, revision: 1, mode: 'default', rules: [] }, caps: { usdMicros: 100, rounds: 3 } }
const thread = (revision = 1, state = 'draft', cards: unknown[] = []) => ({ version: 1, id: 'lead', revision, state,
  project: null, olderMessages: 0, messages: [], cards })
const projection = (revision: number, state = 'running', cards: unknown[] = []) => ({ version: 1, revision, thread: thread(revision, state, cards), settings, waitReason: state === 'waiting-for-user' ? 'lead-request-failed' : null, planConsentExpiresAt: null, requestInFlight: false, wayOut: state === 'stopped' ? null : cards.length ? 'decide-plan' : state === 'waiting-for-user' ? 'resume' : null })

describe('Lead state facade', () => {
  it('ignores a readThread response that arrives after availability is dropped', async () => {
    const { createLeadState } = await load()
    let available = true, resolve!: (value: unknown) => void
    const request = vi.fn(() => new Promise(done => { resolve = done }))
    const facade = createLeadState({ request }, () => available)
    const initial = facade.state, changed = vi.fn()
    facade.subscribe(changed)
    const pending = facade.readThread()
    expect(request).toHaveBeenCalledWith('lead/thread/read', {})
    available = false
    resolve(projection(7))
    await pending
    expect(facade.state).toBe(initial)
    expect(changed).not.toHaveBeenCalled()
  })
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


it('returns one stable snapshot object per revision', async () => {
  const { createLeadState } = await load()
  const facade = createLeadState({ request: vi.fn() }, () => true)
  expect(facade.state).toBe(facade.state)
  facade.changed({ method: 'lead/changed', params: projection(2) })
  const snapshot = facade.state
  facade.changed({ method: 'lead/changed', params: projection(2) })
  expect(facade.state).toBe(snapshot)
  facade.changed({ method: 'lead/changed', params: projection(3) })
  expect(facade.state).not.toBe(snapshot)
})
it('refuses settings update and resume locally before the first read', async () => {
  const { createLeadState } = await load(), request = vi.fn()
  const facade = createLeadState({ request }, () => true)
  await expect(facade.updateSettings({ credential: { provider: 'anthropic', key: null } })).rejects.toMatchObject({ code: 'lead-unavailable' })
  await expect(facade.resume()).rejects.toMatchObject({ code: 'lead-unavailable' })
  expect(request).not.toHaveBeenCalled()
})
it('keeps a typed projection failure from changed notifications', async () => {
  const { createLeadState } = await load()
  const facade = createLeadState({ request: vi.fn() }, () => true)
  facade.changed({ method: 'lead/changed', params: projection(2) })
  facade.changed({ method: 'lead/changed', params: { version: 1, revision: 3, error: 'lead-projection-failed' } })
  expect(facade.state.error).toBe('lead-projection-failed')
  expect(facade.state.wayOut).toBe(null)
  facade.changed({ method: 'lead/changed', params: projection(2) })
  expect(facade.state.error).toBe('lead-projection-failed')
  facade.changed({ method: 'lead/changed', params: projection(4) })
  expect(facade.state.error).toBe(null)
})

it('a successful projection at the error revision clears the error and allows credential deletion', async () => {
  const { createLeadState } = await load()
  const request = vi.fn(async () => projection(7))
  const facade = createLeadState({ request }, () => true)
  facade.changed({ method: 'lead/changed', params: { version: 1, revision: 7, error: 'lead-projection-failed' } })
  expect(facade.state.error).toBe('lead-projection-failed')
  await facade.readThread()
  expect(facade.state.error).toBeNull()
  await facade.updateSettings({ credential: { provider: 'anthropic', key: null } })
  expect(request).toHaveBeenLastCalledWith('lead/settings/update', { expectedRevision: 7, credential: { provider: 'anthropic', key: null } })
})

it('copies requestInFlight into state and clears it on the next idle projection', async () => {
  const { createLeadState } = await load()
  const facade = createLeadState({ request: vi.fn() }, () => true)
  facade.changed({ method: 'lead/changed', params: { ...projection(1), requestInFlight: true } })
  expect(facade.state.requestInFlight).toBe(true)
  facade.changed({ method: 'lead/changed', params: projection(2) })
  expect(facade.state.requestInFlight).toBe(false)
})

it('does not read again after an accepted Send loses the capability', async () => {
  const { createLeadState } = await load()
  let available = true
  const request = vi.fn(async () => { available = false; return { messageId: 'message-1', revision: 1 } })
  const facade = createLeadState({ request }, () => available)
  await expect(facade.send('Inspect', 'send-1')).rejects.toMatchObject({ code: 'lead-unavailable' })
  expect(request).toHaveBeenCalledTimes(1)
  expect(request).toHaveBeenCalledWith('lead/thread/send', { text: 'Inspect', idempotencyKey: 'send-1' })
})

it.each(['code', 'wireCode'])('retries a stale name-only update once using a fresh read (%s)', async field => {
  const { createLeadState } = await load()
  const request = vi.fn().mockRejectedValueOnce({ [field]: 'lead-revision-stale' }).mockResolvedValueOnce(projection(9)).mockResolvedValueOnce({ ...projection(10), settings: { ...settings, name: 'lex' } })
  const facade = createLeadState({ request }, () => true)
  facade.changed({ method: 'lead/changed', params: projection(2) })
  await facade.updateSettings({ name: 'lex' })
  expect(request.mock.calls).toEqual([['lead/settings/update', { expectedRevision: 2, name: 'lex' }], ['lead/settings/read', {}], ['lead/settings/update', { expectedRevision: 9, name: 'lex' }]])
  expect(facade.state.settings.name).toBe('lex')
})
it.each([{ caps: settings.caps }, { policy: settings.policy }, { credential: { provider: 'anthropic', key: null } }, { name: 'lex', caps: settings.caps }])('never retries an authority or credential update %j', async update => {
  const { createLeadState } = await load(), request = vi.fn().mockRejectedValue({ code: 'lead-revision-stale' })
  const facade = createLeadState({ request }, () => true); facade.changed({ method: 'lead/changed', params: projection(2) })
  await expect(facade.updateSettings(update)).rejects.toMatchObject({ code: 'lead-revision-stale' }); expect(request).toHaveBeenCalledOnce()
})

it('applies live worker approval changes without advancing the journal revision', async () => {
  const { createLeadState } = await load()
  const facade = createLeadState({ request: vi.fn() }, () => true)
  facade.changed({ method: 'lead/changed', params: projection(2) })
  const card = { version: 1, id: 'worker-live', revision: 1, type: 'waiting', kind: 'worker-approval' }
  facade.changed({ method: 'lead/changed', params: projection(2, 'running', [card]) })
  expect(facade.state.thread.cards).toEqual([card])
  expect(facade.state.revision).toBe(2)
  facade.changed({ method: 'lead/changed', params: projection(2) })
  expect(facade.state.thread.cards).toEqual([])
})

it('a delayed read cannot undo a newer live approval projection at the same journal revision', async () => {
  const { createLeadState } = await load()
  let resolve!: (value: unknown) => void
  const facade = createLeadState({ request: () => new Promise(done => { resolve = done }) }, () => true)
  facade.changed({ method: 'lead/changed', params: projection(2) })
  const pending = facade.readThread()
  const card = { version: 1, id: 'worker-live', revision: 1, type: 'waiting', kind: 'worker-approval' }
  facade.changed({ method: 'lead/changed', params: projection(2, 'running', [card]) })
  resolve(projection(2))
  await pending
  expect(facade.state.thread.cards).toEqual([card])
})
