import assert from 'node:assert/strict'
import { test } from 'node:test'
import { itemId, runtimeId, sessionId, turnId, type Session } from '@harnessdesk/protocol'
import * as transcripts from '../src/recovery-descriptor.js'

const api = transcripts as unknown as { recoveryDescriptor?: (session: Session) => { identity: string; turnIdentities: readonly string[]; turns: readonly { id: string; items: readonly { id: string; type: string }[] }[] } }

test('a recovery descriptor keeps turn and item structure without transcript payload', () => {
  assert.equal(typeof api.recoveryDescriptor, 'function', 'structural descriptor is available')
  const session: Session = { runtime: runtimeId('fake'), id: sessionId('s'), cwd: '/sensitive/path', createdAt: 1, updatedAt: 2,
    status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('t'), status: 'completed', items: [
      { id: itemId('u'), type: 'userMessage', content: [{ type: 'text', text: 'private prompt', deskContext: { prefixLength: 0 } }] },
      { id: itemId('c'), type: 'command', command: 'secret command', cwd: '/sensitive/path', origin: 'agent', actions: [], output: 'private output', status: 'completed' },
    ] }] }
  const descriptor = api.recoveryDescriptor!(session)
  assert.equal(descriptor.turns.length, 1)
  assert.deepEqual(descriptor.turns[0]!.items.map(item => item.type), ['userMessage', 'command'])
  for (const id of [descriptor.turns[0]!.id, ...descriptor.turns[0]!.items.map(item => item.id)]) assert.match(id, /^[a-f0-9]{64}$/)
  assert.match(descriptor.identity, /^[a-f0-9]{64}$/)
  const text = JSON.stringify(descriptor)
  for (const secret of ['private prompt', 'private output', 'secret command', '/sensitive/path']) assert.ok(!text.includes(secret))
  const changed: Session = { ...session, turns: [{ ...session.turns[0]!, items: [session.turns[0]!.items[0]!] }] }
  assert.notEqual(api.recoveryDescriptor!(changed).identity, descriptor.identity)
})

test('descriptor does not retain notice keys, error text, paths or reasoning payload', () => {
  assert.equal(typeof api.recoveryDescriptor, 'function')
  const session: Session = { runtime: runtimeId('fake'), id: sessionId('s'), cwd: '/x', createdAt: 1, updatedAt: 2,
    status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('notice:private-id'), status: 'failed', error: { message: 'private failure' }, items: [
      { id: itemId('notice:private-id'), type: 'notice', text: 'private notice', contentKey: 'private key', lastEventId: 'private event' },
      { id: itemId('error:private failure'), type: 'error', message: 'private failure' },
      { id: itemId('f'), type: 'fileChange', status: 'completed', changes: [{ path: '/private/file', kind: { type: 'add' }, diff: 'private diff' }] },
      { id: itemId('r'), type: 'reasoning', summary: ['private summary'], content: ['private reasoning'] },
    ] }] }
  const text = JSON.stringify(api.recoveryDescriptor!(session))
  for (const secret of ['private-id', 'private failure', 'private notice', 'private key', 'private event', '/private/file', 'private diff', 'private summary', 'private reasoning']) assert.ok(!text.includes(secret), secret)
})

test('descriptor capacity refuses new or larger entries without discarding existing recovery facts', async () => {
  const module = await import('../src/recovery-descriptor.js') as unknown as { DescriptorCache?: new (maxBytes: number) => { put(key: string, descriptor: object): boolean; get(key: string): object | undefined; remove(key: string): void; readonly size: number; readonly bytes: number } }
  assert.equal(typeof module.DescriptorCache, 'function')
  const cache = new module.DescriptorCache!(100)
  const one = { id: 'first' }, two = { id: 'second' }
  assert.equal(cache.put('one', one), true)
  assert.equal(cache.put('two', two), true)
  assert.equal(cache.put('three', { id: 'third' }), false)
  assert.equal(cache.put('one', { id: 'x'.repeat(200) }), false)
  assert.deepEqual(cache.get('one'), one)
  assert.deepEqual(cache.get('two'), two)
  assert.equal(cache.size, 2)
  assert.equal(cache.bytes, Buffer.byteLength(JSON.stringify({ key: 'one', descriptor: one })) + Buffer.byteLength(JSON.stringify({ key: 'two', descriptor: two })))
  cache.remove('one')
  assert.equal(cache.put('three', { id: 'third' }), true)
})

test('descriptor user matching hints follow the reducer raw and folded normalization', async () => {
  const { wrapContext } = await import('@harnessdesk/protocol')
  const session: Session = { runtime: runtimeId('fake'), id: sessionId('s'), cwd: '/x', createdAt: 1, updatedAt: 2,
    status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('t'), status: 'completed', items: [{ id: itemId('u'), type: 'userMessage',
      content: [{ type: 'text', text: `${wrapContext('Other', 'typed words')}\n\nKeep it`, deskContext: { prefixLength: 0 } }] }] }] }
  const replay: Session = { ...session, turns: [{ ...session.turns[0]!, items: [{ id: itemId('u'), type: 'userMessage',
    content: [{ type: 'text', text: 'Keep it' }], context: [{ label: 'Other', text: 'typed words' }] }] }] }
  const a = api.recoveryDescriptor!(session).turns[0]!.items[0] as unknown as { rawTextHint: string; foldedTextHint: string }
  const b = api.recoveryDescriptor!(replay).turns[0]!.items[0] as unknown as { rawTextHint: string; candidateFoldedHint?: string }
  assert.notEqual(a.rawTextHint, b.rawTextHint)
  assert.equal(a.foldedTextHint, b.candidateFoldedHint, 'folded context must use the same normalization as preserveDeskContext')
})

test('descriptor context matching follows stable IDs, resegmentation and one-use reducer order', async () => {
  const { preserveDeskContext, wrapContext } = await import('@harnessdesk/protocol')
  const module = await import('../src/recovery-descriptor.js') as unknown as { matchContextHints?: (candidates: readonly object[], held: readonly object[]) => readonly (number | null)[] }
  assert.equal(typeof module.matchContextHints, 'function')
  const raw = `${wrapContext('Other', 'typed words')}\n\nKeep it`
  const held = [
    { id: itemId('one'), type: 'userMessage' as const, content: [{ type: 'text' as const, text: raw, deskContext: { prefixLength: 0 } }] },
    { id: itemId('two'), type: 'userMessage' as const, content: [{ type: 'text' as const, text: raw, deskContext: { prefixLength: 1 } }] },
  ]
  const candidates = [
    { id: itemId('two'), type: 'userMessage' as const, content: [{ type: 'text' as const, text: 'Keep it' }], context: [{ label: 'Other', text: 'typed words' }] },
    { id: itemId('new'), type: 'userMessage' as const, content: [{ type: 'text' as const, text: 'Keep it' }], context: [{ label: 'Other', text: 'typed words' }] },
    { id: itemId('extra'), type: 'userMessage' as const, content: [{ type: 'text' as const, text: 'Keep it' }], context: [{ label: 'Other', text: 'typed words' }] },
  ]
  const session = (items: typeof held | typeof candidates): Session => ({ runtime: runtimeId('fake'), id: sessionId('s'), cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('t'), status: 'completed', items }] })
  const heldHints = api.recoveryDescriptor!(session(held)).turns[0]!.items
  const replayHints = api.recoveryDescriptor!(session(candidates)).turns[0]!.items
  const expected = preserveDeskContext(candidates, held).map(item => item.type === 'userMessage' && item.content[0]?.type === 'text' ? item.content[0].deskContext?.prefixLength ?? null : null)
  const matched = module.matchContextHints!(replayHints, heldHints)
  assert.deepEqual(matched.map(index => index === null ? null : held[index]!.content[0]!.deskContext!.prefixLength), expected)
  assert.deepEqual(matched, [1, 0, null])
})

test('descriptor cache snapshots and returns copies so callers cannot bypass byte accounting', async () => {
  const { DescriptorCache } = await import('../src/recovery-descriptor.js')
  const session: Session = { runtime: runtimeId('fake'), id: sessionId('s'), cwd: '/x', createdAt: 1, updatedAt: 2,
    status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('t'), status: 'completed', items: [] }] }
  const descriptor = api.recoveryDescriptor!(session)
  const cache = new DescriptorCache(1024)
  assert.equal(cache.put('generation', descriptor as ReturnType<typeof import('../src/recovery-descriptor.js').recoveryDescriptor>), true)
  const before = cache.bytes
  ;(descriptor.turns as unknown as unknown[]).push({ id: 'untracked', items: [] })
  assert.equal((cache.get('generation')!.turns).length, 1)
  const returned = cache.get('generation')!
  ;(returned.turns as unknown as unknown[]).push({ id: 'untracked', items: [] })
  assert.equal(cache.get('generation')!.turns.length, 1)
  assert.equal(cache.bytes, before)
})

test('descriptor context match decisions agree with the real reducer across varied identity and text cases', async () => {
  const { preserveDeskContext, wrapContext } = await import('@harnessdesk/protocol')
  const { matchContextHints } = await import('../src/recovery-descriptor.js')
  let seed = 0x924125
  const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
  const strings = ['one', 'two', 'Keep it', `${wrapContext('Other', 'typed words')}\n\nKeep it`]
  const make = (index: number) => next() % 5 === 0 ? { id: itemId(`i${next() % 4}`), type: 'assistantMessage' as const, text: 'answer' } :
    { id: itemId(`i${next() % 4}`), type: 'userMessage' as const,
      content: [{ type: 'text' as const, text: strings[next() % strings.length]!, ...(next() % 3 === 0 ? { deskContext: { prefixLength: index } } : {}) }],
      ...(next() % 3 === 0 ? { context: [{ label: 'Other', text: 'typed words' }] } : {}) }
  const session = (items: readonly import('@harnessdesk/protocol').AgentItem[]): Session => ({ runtime: runtimeId('fake'), id: sessionId('s'), cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('t'), status: 'completed', items }] })
  for (let run = 0; run < 300; run++) {
    const held = Array.from({ length: next() % 8 }, (_, i) => make(i + 1))
    const candidates = Array.from({ length: next() % 8 }, (_, i) => make(i + 100))
    const result = preserveDeskContext(candidates, held)
    const expected = result.map((item, index) => {
      if (item === candidates[index] || item.type !== 'userMessage') return null
      const found = held.findIndex(entry => entry.type === 'userMessage' && entry.content === item.content)
      return found < 0 ? null : found
    })
    const heldHints = api.recoveryDescriptor!(session(held)).turns[0]!.items
    const replayHints = api.recoveryDescriptor!(session(candidates)).turns[0]!.items
    assert.deepEqual(matchContextHints(replayHints, heldHints), expected, `sequence ${run}`)
  }
})

test('descriptor notice plan matches the canonical reducer replacement and missing-row order', async () => {
  const { preserveNoticeItems } = await import('@harnessdesk/protocol')
  const module = await import('../src/recovery-descriptor.js') as unknown as { planNoticeHints?: (items: readonly object[], held: readonly object[], keep: boolean) => { replacements: readonly (number | null)[]; appended: readonly number[] } }
  assert.equal(typeof module.planNoticeHints, 'function')
  const held = [
    { id: itemId('n1'), type: 'notice' as const, text: 'old one', kind: 'conversation:warning' },
    { id: itemId('n2'), type: 'notice' as const, text: 'old two', kind: 'runtime:note' },
  ]
  const items = [
    { id: itemId('n1'), type: 'userMessage' as const, content: [{ type: 'text' as const, text: 'old one' }] },
    { id: itemId('other'), type: 'assistantMessage' as const, text: 'new' },
  ]
  const session = (items: readonly import('@harnessdesk/protocol').AgentItem[]): Session => ({ runtime: runtimeId('fake'), id: sessionId('s'), cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true, turns: [{ id: turnId('t'), status: 'completed', items }] })
  const plan = module.planNoticeHints!(api.recoveryDescriptor!(session(items)).turns[0]!.items, api.recoveryDescriptor!(session(held)).turns[0]!.items, true)
  const output = items.map((item, index) => plan.replacements[index] == null ? item : held[plan.replacements[index]!]!)
  output.push(...plan.appended.map(index => held[index]!))
  assert.deepEqual(output, preserveNoticeItems(items, held, true))
})

test('descriptor turn shape follows a fuller completion with notices and desk provenance', async () => {
  const { reduceSession } = await import('@harnessdesk/protocol')
  const module = await import('../src/recovery-descriptor.js') as unknown as { PendingTurnShape?: new (turn: object) => { apply(event: import('@harnessdesk/protocol').AgentEvent): void; snapshot(): object } }
  assert.equal(typeof module.PendingTurnShape, 'function')
  const id = sessionId('s'), tid = turnId('t')
  const original: Session = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: tid, status: 'inProgress', items: [
      { id: itemId('u'), type: 'userMessage', content: [{ type: 'text', text: 'prompt', deskContext: { prefixLength: 0 } }] },
      { id: itemId('n'), type: 'notice', kind: 'runtime:note', text: 'warning', contentKey: 'warning-key' },
    ] }] }
  const event: import('@harnessdesk/protocol').AgentEvent = { type: 'turn/completed', sessionId: id, turn: { id: tid, status: 'completed', items: [
    { id: itemId('u'), type: 'userMessage', content: [{ type: 'text', text: 'prompt' }] },
    { id: itemId('a'), type: 'assistantMessage', text: 'answer' },
    { id: itemId('extra'), type: 'assistantMessage', text: 'extra' },
  ] } }
  const model = new module.PendingTurnShape!(api.recoveryDescriptor!(original).turns[0]!)
  model.apply(event)
  assert.deepEqual(model.snapshot(), api.recoveryDescriptor!(reduceSession(original, event)).turns[0])
})

test('turn-shape completion matches the real reducer across sizes, notices, errors and user contexts', async () => {
  const { reduceSession, wrapContext } = await import('@harnessdesk/protocol')
  const { PendingTurnShape } = await import('../src/recovery-descriptor.js')
  const id = sessionId('s'), tid = turnId('t')
  let seed = 0x4135ab; const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
  const make = () => {
    const itemIdValue = itemId(`i${next() % 6}`), choice = next() % 4
    if (choice === 0) return { id: itemIdValue, type: 'notice' as const, text: 'notice', ...(next() % 2 ? { kind: 'runtime:note' } : {}), contentKey: `k${next() % 3}` }
    if (choice === 1) return { id: itemIdValue, type: 'error' as const, message: `error${next() % 3}` }
    if (choice === 2) return { id: itemIdValue, type: 'assistantMessage' as const, text: 'reply' }
    const contextual = next() % 2 === 0
    return { id: itemIdValue, type: 'userMessage' as const, content: [{ type: 'text' as const,
      text: contextual ? `${wrapContext('Other', 'typed words')}\n\nKeep it` : 'Keep it', ...(contextual ? { deskContext: { prefixLength: 0 } } : {}) }],
      ...(!contextual && next() % 2 ? { context: [{ label: 'Other', text: 'typed words' }] } : {}) }
  }
  for (let run = 0; run < 300; run++) {
    const original: Session = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
      turns: [{ id: tid, status: 'inProgress', items: Array.from({ length: next() % 7 }, make), ...(next() % 2 ? { error: { message: `error${next() % 3}` } } : {}) }] }
    const event: import('@harnessdesk/protocol').AgentEvent = { type: 'turn/completed', sessionId: id, turn: { id: tid, status: 'completed',
      items: Array.from({ length: next() % 7 }, make), ...(next() % 2 ? { error: { message: `error${next() % 3}` } } : {}) } }
    const model = new PendingTurnShape(api.recoveryDescriptor!(original).turns[0]! as ConstructorParameters<typeof PendingTurnShape>[0])
    model.apply(event)
    assert.deepEqual(model.snapshot(), api.recoveryDescriptor!(reduceSession(original, event)).turns[0], `sequence ${run}`)
  }
})

test('turn shape tracks interleaved starts, item replacements, indexed deltas and completion', async () => {
  const { reduceSession } = await import('@harnessdesk/protocol')
  const { PendingTurnShape } = await import('../src/recovery-descriptor.js')
  const id = sessionId('s'), tid = turnId('t')
  const original: Session = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: tid, status: 'completed', items: [{ id: itemId('r'), type: 'reasoning', summary: [], content: [] }] }] }
  const events: import('@harnessdesk/protocol').AgentEvent[] = [
    { type: 'turn/started', sessionId: id, turn: { id: tid, status: 'inProgress', items: [] } },
    { type: 'item/delta', sessionId: id, turnId: tid, itemId: itemId('r'), delta: { kind: 'reasoningSummary', index: 2, text: 'thought' } },
    { type: 'item/started', sessionId: id, turnId: tid, item: { id: itemId('new'), type: 'assistantMessage', text: 'answer', startedAt: 5 } },
    { type: 'item/completed', sessionId: id, turnId: tid, item: { id: itemId('new'), type: 'assistantMessage', text: 'complete' } },
    { type: 'turn/completed', sessionId: id, turn: { id: tid, status: 'completed', items: [] } },
  ]
  const model = new PendingTurnShape(api.recoveryDescriptor!(original).turns[0]! as ConstructorParameters<typeof PendingTurnShape>[0])
  for (const event of events) model.apply(event)
  assert.deepEqual(model.snapshot(), api.recoveryDescriptor!(events.reduce(reduceSession, original)).turns[0])
})

test('turn shape tracks the reducer across mixed event sequences', async () => {
  const { reduceSession, wrapContext } = await import('@harnessdesk/protocol')
  const { PendingTurnShape, PendingTurnOverlay } = await import('../src/recovery-descriptor.js')
  const id = sessionId('s'), tid = turnId('t')
  let seed = 0x8237ab; const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
  const make = () => {
    const iid = itemId(`i${next() % 6}`), choice = next() % 5
    if (choice === 0) return { id: iid, type: 'notice' as const, text: 'notice', kind: next() % 2 ? 'runtime:note' : undefined, contentKey: `k${next() % 3}` }
    if (choice === 1) return { id: iid, type: 'error' as const, message: `error${next() % 3}` }
    if (choice === 2) return { id: iid, type: 'assistantMessage' as const, text: 'reply', ...(next() % 2 ? { startedAt: 7 } : {}) }
    if (choice === 3) return { id: iid, type: 'reasoning' as const, summary: [], content: [] }
    const contextual = next() % 2 === 0
    return { id: iid, type: 'userMessage' as const, content: [{ type: 'text' as const, text: contextual ? `${wrapContext('Other', 'typed words')}\n\nKeep it` : 'Keep it', ...(contextual ? { deskContext: { prefixLength: 0 } } : {}) }],
      ...(!contextual && next() % 2 ? { context: [{ label: 'Other', text: 'typed words' }] } : {}) }
  }
  for (let run = 0; run < 200; run++) {
    let state: Session = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
      turns: [{ id: tid, status: 'completed', items: Array.from({ length: next() % 5 }, make) }] }
    const base = state.turns[0]!
    const description = api.recoveryDescriptor!(state).turns[0]! as ConstructorParameters<typeof PendingTurnShape>[0]
    const model = new PendingTurnShape(description)
    const overlay = new PendingTurnOverlay(description, api.recoveryDescriptor!(state).turnIdentities[0]!)
    for (let step = 0; step < 40; step++) {
      const choice = next() % 5
      const event: import('@harnessdesk/protocol').AgentEvent = choice === 0
        ? { type: 'turn/started', sessionId: id, turn: { id: tid, status: 'inProgress', items: [] } }
        : choice === 1 ? { type: 'turn/completed', sessionId: id, turn: { id: tid, status: 'completed', items: Array.from({ length: next() % 6 }, make), ...(next() % 3 === 0 ? { error: { message: `error${next() % 3}` } } : {}) } }
        : choice === 2 ? { type: 'item/delta', sessionId: id, turnId: tid, itemId: itemId(`i${next() % 6}`), delta: { kind: 'reasoningSummary', index: next() % 3, text: 'part' } }
        : { type: choice === 3 ? 'item/started' : 'item/completed', sessionId: id, turnId: tid, item: make() }
      model.apply(event); overlay.apply(event); state = reduceSession(state, event)
      assert.deepEqual(model.snapshot(), api.recoveryDescriptor!(state).turns[0], `shape sequence ${run}, event ${step}`)
      assert.deepEqual(overlay.materialize(base), state.turns[0], `body sequence ${run}, event ${step}`)
    }
  }
})

test('a symbolic pending turn reconstructs the full reducer result without retaining the saved payload', async () => {
  const { reduceSession } = await import('@harnessdesk/protocol')
  const module = await import('../src/recovery-descriptor.js') as unknown as { PendingTurnOverlay?: new (turn: object, baseIdentity: string) => { apply(event: import('@harnessdesk/protocol').AgentEvent): void; materialize(turn: import('@harnessdesk/protocol').Turn): import('@harnessdesk/protocol').Turn } }
  assert.equal(typeof module.PendingTurnOverlay, 'function')
  const id = sessionId('s'), tid = turnId('t')
  const original: Session = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: tid, status: 'inProgress', items: [
      { id: itemId('u'), type: 'userMessage', content: [{ type: 'text', text: 'saved prompt', deskContext: { prefixLength: 0 } }] },
      { id: itemId('n'), type: 'notice', kind: 'runtime:note', text: 'saved notice', contentKey: 'notice-key' },
    ] }] }
  const events: import('@harnessdesk/protocol').AgentEvent[] = [
    { type: 'item/started', sessionId: id, turnId: tid, item: { id: itemId('a'), type: 'assistantMessage', text: '', startedAt: 7 } },
    { type: 'item/delta', sessionId: id, turnId: tid, itemId: itemId('a'), delta: { kind: 'assistantText', text: 'answer' } },
    { type: 'turn/completed', sessionId: id, turn: { id: tid, status: 'completed', items: [
      { id: itemId('u'), type: 'userMessage', content: [{ type: 'text', text: 'saved prompt' }] },
      { id: itemId('a'), type: 'assistantMessage', text: 'answer' },
      { id: itemId('extra'), type: 'assistantMessage', text: 'extra' },
      { id: itemId('x'), type: 'assistantMessage', text: 'x' },
    ] } },
  ]
  const overlay = new module.PendingTurnOverlay!(api.recoveryDescriptor!(original).turns[0]!, api.recoveryDescriptor!(original).turnIdentities[0]!)
  for (const event of events) overlay.apply(event)
  const expected = events.reduce(reduceSession, original).turns[0]!
  assert.deepEqual(overlay.materialize(original.turns[0]!), expected)
})

test('symbolic turn completion filters repeated errors even when the newer item list wins', async () => {
  const { reduceSession } = await import('@harnessdesk/protocol')
  const { PendingTurnOverlay } = await import('../src/recovery-descriptor.js')
  const id = sessionId('s'), tid = turnId('t')
  const original: Session = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: tid, status: 'inProgress', items: [{ id: itemId('old'), type: 'assistantMessage', text: 'old' }] }] }
  const event: import('@harnessdesk/protocol').AgentEvent = { type: 'turn/completed', sessionId: id, turn: { id: tid, status: 'failed', error: { message: 'failed' }, items: [
    { id: itemId('err'), type: 'error', message: 'failed' }, { id: itemId('other'), type: 'assistantMessage', text: 'other' },
  ] } }
  const overlay = new PendingTurnOverlay(api.recoveryDescriptor!(original).turns[0]! as ConstructorParameters<typeof PendingTurnOverlay>[0], api.recoveryDescriptor!(original).turnIdentities[0]!)
  overlay.apply(event)
  assert.deepEqual(overlay.materialize(original.turns[0]!), reduceSession(original, event).turns[0])
})

test('symbolic turn refuses a changed base even when turn and item identities match', async () => {
  const { PendingTurnOverlay } = await import('../src/recovery-descriptor.js')
  const original: Session = { runtime: runtimeId('fake'), id: sessionId('s'), cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: turnId('t'), status: 'completed', items: [{ id: itemId('i'), type: 'assistantMessage', text: 'original' }] }] }
  const overlay = new PendingTurnOverlay(api.recoveryDescriptor!(original).turns[0]! as ConstructorParameters<typeof PendingTurnOverlay>[0], api.recoveryDescriptor!(original).turnIdentities[0]!)
  const changed = { ...original.turns[0]!, items: [{ id: itemId('i'), type: 'assistantMessage' as const, text: 'changed elsewhere' }] }
  assert.throws(() => overlay.materialize(changed), /base/i)
})

test('pending turn overlay reports protected output while metadata stays per logical item', async () => {
  const { PendingTurnOverlay } = await import('../src/recovery-descriptor.js')
  const id = sessionId('s'), tid = turnId('t')
  const original: Session = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: tid, status: 'inProgress', items: [{ id: itemId('a'), type: 'assistantMessage', text: 'saved' }] }] }
  const overlay = new PendingTurnOverlay(api.recoveryDescriptor!(original).turns[0]! as ConstructorParameters<typeof PendingTurnOverlay>[0], api.recoveryDescriptor!(original).turnIdentities[0]!)
  for (let i = 0; i < 1000; i++) overlay.apply({ type: 'item/delta', sessionId: id, turnId: tid, itemId: itemId('a'), delta: { kind: 'assistantText', text: 'é' } })
  const stats = overlay as unknown as { readonly protectedBytes?: number; readonly structureCount?: number }
  assert.equal(typeof stats.protectedBytes, 'number')
  assert.ok(stats.protectedBytes! >= 2000)
  assert.ok(stats.structureCount! <= 4, 'metadata cannot grow once per delta event')
})

test('symbolic turn preserves reducer behavior for repeated completion and identical delta bytes', async () => {
  const { reduceSession } = await import('@harnessdesk/protocol')
  const { PendingTurnOverlay } = await import('../src/recovery-descriptor.js')
  const id = sessionId('s'), tid = turnId('t')
  const original: Session = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: tid, status: 'inProgress', items: [{ id: itemId('a'), type: 'assistantMessage', text: 'old' }] }] }
  const delta: import('@harnessdesk/protocol').AgentEvent = { type: 'item/delta', sessionId: id, turnId: tid, itemId: itemId('a'), delta: { kind: 'assistantText', text: 'x' } }
  const complete: import('@harnessdesk/protocol').AgentEvent = { type: 'turn/completed', sessionId: id, turn: { id: tid, status: 'completed', items: [] } }
  const events = [delta, delta, complete, complete]
  const descriptor = api.recoveryDescriptor!(original)
  const overlay = new PendingTurnOverlay(descriptor.turns[0]! as ConstructorParameters<typeof PendingTurnOverlay>[0], descriptor.turnIdentities[0]!)
  for (const event of events) overlay.apply(event)
  assert.deepEqual(overlay.materialize(original.turns[0]!), events.reduce(reduceSession, original).turns[0])
})

test('symbolic session reconstructs interleaved existing and new turns from the verified base', async () => {
  const { reduceSession } = await import('@harnessdesk/protocol')
  const module = await import('../src/recovery-descriptor.js') as unknown as { PendingSessionOverlay?: new (descriptor: object) => { apply(event: import('@harnessdesk/protocol').AgentEvent): void; materialize(session: Session): Session } }
  assert.equal(typeof module.PendingSessionOverlay, 'function')
  const id = sessionId('s'), a = turnId('a'), b = turnId('b')
  const original: Session = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: a, status: 'completed', items: [{ id: itemId('a'), type: 'assistantMessage', text: 'saved' }] }] }
  const events: import('@harnessdesk/protocol').AgentEvent[] = [
    { type: 'item/delta', sessionId: id, turnId: a, itemId: itemId('a'), delta: { kind: 'assistantText', text: ' update' } },
    { type: 'turn/started', sessionId: id, turn: { id: b, status: 'inProgress', items: [] } },
    { type: 'item/started', sessionId: id, turnId: b, item: { id: itemId('b'), type: 'assistantMessage', text: '' } },
    { type: 'item/delta', sessionId: id, turnId: b, itemId: itemId('b'), delta: { kind: 'assistantText', text: 'new' } },
    { type: 'turn/completed', sessionId: id, turn: { id: b, status: 'completed', items: [] } },
    { type: 'session/status', sessionId: id, status: { type: 'idle' } },
  ]
  const overlay = new module.PendingSessionOverlay!(api.recoveryDescriptor!(original))
  for (const event of events) overlay.apply(event)
  assert.deepEqual(overlay.materialize(original), events.reduce(reduceSession, original))
})

test('symbolic sessions match reducer across mixed multi-turn and metadata events', async () => {
  const { reduceSession } = await import('@harnessdesk/protocol')
  const { PendingSessionOverlay, recoveryDescriptor } = await import('../src/recovery-descriptor.js')
  const id = sessionId('s'), ids = [turnId('a'), turnId('b'), turnId('c')]
  let seed = 0x16cb45; const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
  for (let run = 0; run < 100; run++) {
    const original: Session = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
      turns: [{ id: ids[0]!, status: 'completed', items: [{ id: itemId('old'), type: 'assistantMessage', text: 'old' }] }] }
    let state = original; const overlay = new PendingSessionOverlay(recoveryDescriptor(original))
    for (let step = 0; step < 40; step++) {
      const tid = ids[next() % ids.length]!, iid = itemId(`i${next() % 4}`), choice = next() % 7
      const event: import('@harnessdesk/protocol').AgentEvent = choice === 0 ? { type: 'turn/started', sessionId: id, turn: { id: tid, status: 'inProgress', items: [] } } :
        choice === 1 ? { type: 'turn/completed', sessionId: id, turn: { id: tid, status: 'completed', items: [] } } :
        choice === 2 ? { type: 'item/delta', sessionId: id, turnId: tid, itemId: iid, delta: { kind: 'assistantText', text: 'x' } } :
        choice === 3 ? { type: 'item/started', sessionId: id, turnId: tid, item: { id: iid, type: 'assistantMessage', text: 'new' } } :
        choice === 4 ? { type: 'session/title', sessionId: id, title: `title${next() % 3}` } :
        choice === 5 ? { type: 'session/detached', sessionId: id } : { type: 'session/status', sessionId: id, status: { type: 'idle' } }
      overlay.apply(event); state = reduceSession(state, event)
      assert.deepEqual(overlay.materialize(original), state, `sequence ${run}, event ${step}`)
    }
  }
})

test('ambient notices and errors without this session do not alter a pending session', async () => {
  const { reduceSession } = await import('@harnessdesk/protocol')
  const { PendingSessionOverlay, recoveryDescriptor } = await import('../src/recovery-descriptor.js')
  const original: Session = { runtime: runtimeId('fake'), id: sessionId('s'), cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: turnId('t'), status: 'completed', items: [] }] }
  const events: import('@harnessdesk/protocol').AgentEvent[] = [
    { type: 'notice', class: 'info', level: 'warning', message: 'ambient' },
    { type: 'error', error: { code: 'unknown', message: 'ambient' } },
  ]
  const overlay = new PendingSessionOverlay(recoveryDescriptor(original))
  for (const event of events) overlay.apply(event)
  assert.deepEqual(overlay.materialize(original), events.reduce(reduceSession, original))
})

test('symbolic session coalesces notices and errors on the last saved turn', async () => {
  const { reduceSession } = await import('@harnessdesk/protocol')
  const { PendingSessionOverlay, recoveryDescriptor } = await import('../src/recovery-descriptor.js')
  const id = sessionId('s'), tid = turnId('t')
  const original: Session = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: tid, status: 'completed', items: [{ id: itemId('a'), type: 'assistantMessage', text: 'saved' }] }] }
  const events: import('@harnessdesk/protocol').AgentEvent[] = [
    { type: 'notice', sessionId: id, class: 'conversation', id: 'n1', level: 'warning', message: 'warning', at: 1 },
    { type: 'notice', sessionId: id, class: 'conversation', id: 'n2', level: 'warning', message: 'warning', at: 2 },
    { type: 'notice', sessionId: id, class: 'conversation', id: 'n2', level: 'warning', message: 'warning', at: 2 },
    { type: 'error', sessionId: id, error: { code: 'unknown', message: 'failure' } },
    { type: 'error', sessionId: id, error: { code: 'unknown', message: 'failure' } },
  ]
  const overlay = new PendingSessionOverlay(recoveryDescriptor(original))
  for (const event of events) overlay.apply(event)
  assert.deepEqual(overlay.materialize(original), events.reduce(reduceSession, original))
})

test('symbolic session migrates newly pending notice rows into a later turn', async () => {
  const { reduceSession } = await import('@harnessdesk/protocol')
  const { PendingSessionOverlay, recoveryDescriptor } = await import('../src/recovery-descriptor.js')
  const id = sessionId('s'), tid = turnId('t')
  const original: Session = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true, turns: [] }
  const events: import('@harnessdesk/protocol').AgentEvent[] = [
    { type: 'notice', sessionId: id, class: 'conversation', id: 'n1', level: 'warning', message: 'warning', at: 1 },
    { type: 'notice', sessionId: id, class: 'conversation', id: 'n2', level: 'warning', message: 'warning', at: 2 },
    { type: 'turn/started', sessionId: id, turn: { id: tid, status: 'inProgress', items: [] } },
    { type: 'item/started', sessionId: id, turnId: tid, item: { id: itemId('a'), type: 'assistantMessage', text: 'new' } },
  ]
  const overlay = new PendingSessionOverlay(recoveryDescriptor(original))
  for (const event of events) overlay.apply(event)
  assert.deepEqual(overlay.materialize(original), events.reduce(reduceSession, original))
})

test('symbolic session migrates saved notice rows into a new turn without keeping their payload', async () => {
  const { reduceSession } = await import('@harnessdesk/protocol')
  const { PendingSessionOverlay, recoveryDescriptor } = await import('../src/recovery-descriptor.js')
  const id = sessionId('s'), tid = turnId('real')
  const original: Session = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: turnId('notice:old'), status: 'completed', items: [{ id: itemId('n'), type: 'notice', kind: 'runtime:note', contentKey: 'same', text: 'saved notice' }] }] }
  const events: import('@harnessdesk/protocol').AgentEvent[] = [
    { type: 'notice', sessionId: id, class: 'conversation', id: 'n2', level: 'warning', message: 'saved notice', contentKey: 'same', at: 10 },
    { type: 'turn/started', sessionId: id, turn: { id: tid, status: 'inProgress', items: [] } },
    { type: 'turn/completed', sessionId: id, turn: { id: tid, status: 'completed', items: [] } },
  ]
  const overlay = new PendingSessionOverlay(recoveryDescriptor(original))
  for (const event of events) overlay.apply(event)
  assert.deepEqual(overlay.materialize(original), events.reduce(reduceSession, original))
})

test('symbolic session start replaces metadata and keeps only unmatched notice turns', async () => {
  const { reduceSession } = await import('@harnessdesk/protocol')
  const { PendingSessionOverlay, recoveryDescriptor } = await import('../src/recovery-descriptor.js')
  const id = sessionId('s')
  const original: Session = { runtime: runtimeId('fake'), id, cwd: '/old', createdAt: 1, updatedAt: 1, title: 'old', status: { type: 'idle' }, itemsLoaded: true,
    turns: [
      { id: turnId('notice:n'), status: 'completed', items: [{ id: itemId('n'), type: 'notice', kind: 'runtime:note', text: 'notice' }] },
      { id: turnId('old'), status: 'completed', items: [{ id: itemId('o'), type: 'assistantMessage', text: 'old' }] },
    ] }
  const fresh: Session = { runtime: original.runtime, id, cwd: '/new', createdAt: 2, updatedAt: 2, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: turnId('fresh'), status: 'completed', items: [{ id: itemId('f'), type: 'assistantMessage', text: 'fresh' }] }] }
  const events: import('@harnessdesk/protocol').AgentEvent[] = [
    { type: 'session/title', sessionId: id, title: 'pending' },
    { type: 'session/started', session: fresh },
  ]
  const overlay = new PendingSessionOverlay(recoveryDescriptor(original))
  for (const event of events) overlay.apply(event)
  assert.deepEqual(overlay.materialize(original), events.reduce(reduceSession, original))
})

test('symbolic session follows reducer through notices, errors, starts and repeated turns', async () => {
  const { reduceSession } = await import('@harnessdesk/protocol')
  const { PendingSessionOverlay, recoveryDescriptor } = await import('../src/recovery-descriptor.js')
  const id = sessionId('s'), tids = [turnId('a'), turnId('b'), turnId('notice:n')]
  let seed = 0x72491; const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
  for (let run = 0; run < 100; run++) {
    const original: Session = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
      turns: [{ id: tids[0]!, status: 'completed', items: [{ id: itemId('old'), type: 'assistantMessage', text: 'old' }] }] }
    let state = original; const overlay = new PendingSessionOverlay(recoveryDescriptor(original))
    for (let step = 0; step < 30; step++) {
      const tid = tids[next() % tids.length]!, iid = itemId(`i${next() % 4}`), choice = next() % 9
      const event: import('@harnessdesk/protocol').AgentEvent = choice === 0 ? { type: 'turn/started', sessionId: id, turn: { id: tid, status: 'inProgress', items: [] } } :
        choice === 1 ? { type: 'turn/completed', sessionId: id, turn: { id: tid, status: 'completed', items: [] } } :
        choice === 2 ? { type: 'item/delta', sessionId: id, turnId: tid, itemId: iid, delta: { kind: 'assistantText', text: 'x' } } :
        choice === 3 ? { type: 'item/started', sessionId: id, turnId: tid, item: { id: iid, type: 'assistantMessage', text: 'new' } } :
        choice === 4 ? { type: 'notice', sessionId: id, class: 'conversation', id: `n${next() % 4}`, level: 'warning', message: `m${next() % 2}` } :
        choice === 5 ? { type: 'error', sessionId: id, error: { code: 'unknown', message: `e${next() % 3}`, retrying: next() % 2 === 0 } } :
        choice === 6 ? { type: 'session/detached', sessionId: id } :
        choice === 7 ? { type: 'session/started', session: { ...original, title: 'fresh', turns: [{ id: tid, status: 'completed', items: [] }] } } :
        { type: 'session/title', sessionId: id, title: `title${next() % 3}` }
      overlay.apply(event); state = reduceSession(state, event)
      assert.deepEqual(overlay.materialize(original), state, `sequence ${run}, event ${step}`)
    }
  }
})

test('symbolic session reports pending protected bytes and structural cardinality', async () => {
  const { PendingSessionOverlay, recoveryDescriptor } = await import('../src/recovery-descriptor.js')
  const id = sessionId('s'), tid = turnId('t')
  const original: Session = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: tid, status: 'inProgress', items: [{ id: itemId('a'), type: 'assistantMessage', text: 'saved' }] }] }
  const overlay = new PendingSessionOverlay(recoveryDescriptor(original))
  for (let i = 0; i < 1000; i++) overlay.apply({ type: 'item/delta', sessionId: id, turnId: tid, itemId: itemId('a'), delta: { kind: 'assistantText', text: 'é' } })
  const stats = overlay as unknown as { readonly protectedBytes?: number; readonly structureCount?: number }
  assert.equal(typeof stats.protectedBytes, 'number')
  assert.ok(stats.protectedBytes! >= 2000)
  assert.ok(stats.structureCount! <= 5)
})

test('symbolic session start must match Host registry reconciliation, not raw reducer replacement', async () => {
  const { SessionRegistry } = await import('../src/registry.js')
  const { PendingSessionOverlay, recoveryDescriptor } = await import('../src/recovery-descriptor.js')
  const id = sessionId('s'), tid = turnId('t'), runtime = runtimeId('fake')
  const original: Session = { runtime, id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: tid, status: 'completed', items: [
      { id: itemId('a'), type: 'assistantMessage', text: 'saved one' },
      { id: itemId('b'), type: 'assistantMessage', text: 'saved two' },
    ] }] }
  const fresh: Session = { ...original, turns: [{ id: tid, status: 'completed', items: [{ id: itemId('a'), type: 'assistantMessage', text: 'source one' }] }] }
  const registry = new SessionRegistry(); registry.upsert(original, null)
  const overlay = new PendingSessionOverlay(recoveryDescriptor(original))
  const event: import('@harnessdesk/protocol').AgentEvent = { type: 'session/started', session: fresh }
  registry.apply(runtime, event); overlay.applyHostStarted(fresh, [], [])
  assert.deepEqual(overlay.materialize(original), registry.get(runtime, id)!.session)
})

test('symbolic Host completion retains a saved publication once when a fuller source list wins', async () => {
  const { reduceSession } = await import('@harnessdesk/protocol')
  const { publicationsIn, withPublications } = await import('../src/publications.js')
  const module = await import('../src/recovery-descriptor.js') as unknown as { PendingTurnOverlay: new (turn: object, identity: string) => { applyHostCompletion?: (event: import('@harnessdesk/protocol').AgentEvent) => void; materialize(turn: import('@harnessdesk/protocol').Turn): import('@harnessdesk/protocol').Turn } }
  const id = sessionId('s'), tid = turnId('t')
  const publication = { id: itemId('pub'), type: 'publication', reference: { kind: 'pullRequest', repo: 'acme/widgets', number: 7, url: 'https://example.com/acme/widgets/pull/7', via: 'gh' } } as unknown as import('@harnessdesk/protocol').AgentItem
  const original: Session = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: tid, status: 'inProgress', items: [{ id: itemId('a'), type: 'assistantMessage', text: 'old' }, publication] }] }
  const event: import('@harnessdesk/protocol').AgentEvent = { type: 'turn/completed', sessionId: id, turn: { id: tid, status: 'completed', items: [
    { id: itemId('x'), type: 'assistantMessage', text: 'one' }, { id: itemId('y'), type: 'assistantMessage', text: 'two' }, { id: itemId('z'), type: 'assistantMessage', text: 'three' },
  ] } }
  const descriptor = api.recoveryDescriptor!(original)
  const overlay = new module.PendingTurnOverlay(descriptor.turns[0]!, descriptor.turnIdentities[0]!)
  assert.equal(typeof overlay.applyHostCompletion, 'function')
  overlay.applyHostCompletion!(event)
  const reduced = reduceSession(original, event).turns[0]!
  const expected = { ...reduced, items: withPublications(reduced.items, publicationsIn(original.turns[0]!.items)) }
  assert.deepEqual(overlay.materialize(original.turns[0]!), expected)
})

test('symbolic turn read matches Host merge semantics for equal-size lists and metadata fallback', async () => {
  const { mergeRead } = await import('@harnessdesk/protocol')
  const module = await import('../src/recovery-descriptor.js') as unknown as { PendingTurnOverlay: new (turn: object, identity: string) => { reconcileRead?: (turn: import('@harnessdesk/protocol').Turn) => void; materialize(turn: import('@harnessdesk/protocol').Turn): import('@harnessdesk/protocol').Turn } }
  const id = sessionId('s'), tid = turnId('t')
  const original: Session = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: tid, status: 'completed', startedAt: 7, diff: 'old diff', plan: [{ step: 'old plan', status: 'pending' }], items: [{ id: itemId('a'), type: 'assistantMessage', text: 'old' }] }] }
  const fresh: Session = { ...original, turns: [{ id: tid, status: 'completed', items: [{ id: itemId('b'), type: 'assistantMessage', text: 'new' }] }] }
  const descriptor = api.recoveryDescriptor!(original), overlay = new module.PendingTurnOverlay(descriptor.turns[0]!, descriptor.turnIdentities[0]!)
  assert.equal(typeof overlay.reconcileRead, 'function')
  overlay.reconcileRead!(fresh.turns[0]!)
  assert.deepEqual(overlay.materialize(original.turns[0]!), mergeRead(original, fresh, () => false).turns[0])
})

test('symbolic turn reads match mergeRead across metadata and item interleavings', async () => {
  const { mergeRead, reduceSession } = await import('@harnessdesk/protocol')
  const { PendingTurnOverlay, recoveryDescriptor } = await import('../src/recovery-descriptor.js')
  const id = sessionId('s'), tid = turnId('t')
  let seed = 0x3e81ca; const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
  const makeTurn = (): import('@harnessdesk/protocol').Turn => ({ id: tid, status: next() % 2 ? 'completed' : 'inProgress',
    items: Array.from({ length: next() % 5 }, (_, i) => ({ id: itemId(`i${i}`), type: 'assistantMessage' as const, text: `value${next() % 4}` })),
    ...(next() % 3 === 0 ? { diff: null } : next() % 2 ? { diff: `diff${next() % 4}` } : {}),
    ...(next() % 2 ? { plan: [{ step: `plan${next() % 4}`, status: 'pending' as const }] } : {}),
    ...(next() % 2 ? { startedAt: next() % 5 } : {}), ...(next() % 3 === 0 ? { error: { message: 'e' } } : {}) })
  for (let run = 0; run < 120; run++) {
    const original: Session = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true, turns: [makeTurn()] }
    const descriptor = recoveryDescriptor(original), overlay = new PendingTurnOverlay(descriptor.turns[0]!, descriptor.turnIdentities[0]!)
    let state = original
    for (let step = 0; step < 25; step++) {
      if (next() % 2) {
        const read: Session = { ...state, turns: [makeTurn()] }
        overlay.reconcileRead(read.turns[0]!); state = mergeRead(state, read, () => false)
      } else {
        const event: import('@harnessdesk/protocol').AgentEvent = next() % 2
          ? { type: 'turn/diff', sessionId: id, turnId: tid, diff: `event${next() % 3}` }
          : { type: 'item/completed', sessionId: id, turnId: tid, item: { id: itemId(`i${next() % 5}`), type: 'assistantMessage', text: 'new' } }
        overlay.apply(event); state = reduceSession(state, event)
      }
      assert.deepEqual(overlay.materialize(original.turns[0]!), state.turns[0], `sequence ${run}, event ${step}`)
    }
  }
})

test('symbolic Host reconciliation matches real registry over interleaved reads and events', async () => {
  const { SessionRegistry } = await import('../src/registry.js')
  const { PendingSessionOverlay, recoveryDescriptor } = await import('../src/recovery-descriptor.js')
  const runtime = runtimeId('fake'), id = sessionId('s'), tids = [turnId('a'), turnId('b'), turnId('notice:n')]
  let seed = 0x6a93b; const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
  for (let run = 0; run < 80; run++) {
    const original: Session = { runtime, id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
      turns: [{ id: tids[0]!, status: 'completed', items: [{ id: itemId('old'), type: 'assistantMessage', text: 'old' }] }] }
    const registry = new SessionRegistry(), record = registry.upsert(original, null), overlay = new PendingSessionOverlay(recoveryDescriptor(record.session))
    for (let step = 0; step < 35; step++) {
      const tid = tids[next() % tids.length]!, iid = itemId(`i${next() % 4}`), choice = next() % 7
      const event: import('@harnessdesk/protocol').AgentEvent = choice === 0 ? { type: 'turn/started', sessionId: id, turn: { id: tid, status: 'inProgress', items: [] } } :
        choice === 1 ? { type: 'turn/completed', sessionId: id, turn: { id: tid, status: 'completed', items: [] } } :
        choice === 2 ? { type: 'item/delta', sessionId: id, turnId: tid, itemId: iid, delta: { kind: 'assistantText', text: 'x' } } :
        choice === 3 ? { type: 'item/started', sessionId: id, turnId: tid, item: { id: iid, type: 'assistantMessage', text: 'new' } } :
        choice === 4 ? { type: 'notice', sessionId: id, class: 'conversation', id: `n${next() % 4}`, level: 'warning', message: `m${next() % 2}` } :
        choice === 5 ? { type: 'session/started', session: { ...original, status: next() % 2 ? { type: 'active' } : { type: 'idle' },
          itemsLoaded: next() % 3 !== 0, partialHistory: next() % 2 === 0, turns: [{ id: tid, status: next() % 2 ? 'inProgress' : 'completed', items: [{ id: iid, type: 'assistantMessage', text: 'read' }] }] } } :
        { type: 'session/title', sessionId: id, title: `title${next() % 3}` }
      overlay.applyHostEvent(event, [...record.watched], [...record.running], record.seatedAs)
      registry.apply(runtime, event)
      assert.deepEqual(overlay.materialize(original), registry.get(runtime, id)!.session, `sequence ${run}, event ${step}`)
    }
  }
})

test('symbolic Host start preserves Host seating authority over runtime settings', async () => {
  const { SessionRegistry } = await import('../src/registry.js')
  const { PendingSessionOverlay, recoveryDescriptor } = await import('../src/recovery-descriptor.js')
  const runtime = runtimeId('fake'), id = sessionId('s')
  const original: Session = { runtime, id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: turnId('a'), status: 'completed', items: [] }] }
  const registry = new SessionRegistry(), record = registry.upsert(original, null)
  const overlay = new PendingSessionOverlay(recoveryDescriptor(record.session))
  const fresh: Session = { ...original, settings: { cwd: '/x', model: 'synthetic', agent: 'forged-runtime-seat' } }
  const event: import('@harnessdesk/protocol').AgentEvent = { type: 'session/started', session: fresh }
  registry.apply(runtime, event)
  overlay.applyHostStarted(fresh, [...record.watched], [...record.running])
  assert.deepEqual(overlay.materialize(original), record.session)
})

test('symbolic Host event processing preserves publication through completion without repeating it', async () => {
  const { SessionRegistry } = await import('../src/registry.js')
  const { publicationsIn, withPublications } = await import('../src/publications.js')
  const { PendingSessionOverlay, recoveryDescriptor } = await import('../src/recovery-descriptor.js')
  const runtime = runtimeId('fake'), id = sessionId('s'), tid = turnId('t')
  const publication = { id: itemId('pub'), type: 'publication', reference: { kind: 'pullRequest', repo: 'acme/widgets', number: 7, url: 'https://example.com/acme/widgets/pull/7', via: 'gh' } } as unknown as import('@harnessdesk/protocol').AgentItem
  const original: Session = { runtime, id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: tid, status: 'completed', items: [{ id: itemId('a'), type: 'assistantMessage', text: 'old' }, publication] }] }
  const registry = new SessionRegistry(), record = registry.upsert(original, null), overlay = new PendingSessionOverlay(recoveryDescriptor(record.session))
  const event: import('@harnessdesk/protocol').AgentEvent = { type: 'turn/completed', sessionId: id, turn: { id: tid, status: 'completed', items: [
    { id: itemId('x'), type: 'assistantMessage', text: 'one' }, { id: itemId('y'), type: 'assistantMessage', text: 'two' }, { id: itemId('z'), type: 'assistantMessage', text: 'three' },
  ] } }
  const kept = publicationsIn(record.session.turns[0]!.items)
  registry.apply(runtime, event)
  record.session = { ...record.session, turns: record.session.turns.map(turn => turn.id === tid ? { ...turn, items: withPublications(turn.items, kept) } : turn) }
  const hostOverlay = overlay as unknown as { applyHostEvent?: (event: import('@harnessdesk/protocol').AgentEvent, watched: readonly typeof tid[], running: readonly typeof tid[]) => void }
  assert.equal(typeof hostOverlay.applyHostEvent, 'function')
  hostOverlay.applyHostEvent!(event, [], [])
  assert.deepEqual(overlay.materialize(original), record.session)
})

test('symbolic Host settings event cannot claim a Host-unassigned seat', async () => {
  const { SessionRegistry } = await import('../src/registry.js')
  const { PendingSessionOverlay, recoveryDescriptor } = await import('../src/recovery-descriptor.js')
  const runtime = runtimeId('fake'), id = sessionId('s')
  const original: Session = { runtime, id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: turnId('a'), status: 'completed', items: [] }] }
  const registry = new SessionRegistry(), record = registry.upsert(original, null), overlay = new PendingSessionOverlay(recoveryDescriptor(record.session))
  const event: import('@harnessdesk/protocol').AgentEvent = { type: 'session/settings', sessionId: id, settings: { cwd: '/x', model: 'synthetic', agent: 'forged-runtime-seat' } }
  registry.apply(runtime, event); overlay.applyHostEvent(event, [...record.watched], [...record.running], record.seatedAs)
  assert.deepEqual(overlay.materialize(original), record.session)
})

test('symbolic notice repetition updates every matching notice in the last turn', async () => {
  const { reduceSession } = await import('@harnessdesk/protocol')
  const { PendingSessionOverlay, recoveryDescriptor } = await import('../src/recovery-descriptor.js')
  const id = sessionId('s'), tid = turnId('t')
  const original: Session = { runtime: runtimeId('fake'), id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
    turns: [{ id: tid, status: 'completed', items: [
      { id: itemId('n1'), type: 'notice', kind: 'runtime:note', text: 'one', contentKey: 'same', count: 1 },
      { id: itemId('n2'), type: 'notice', kind: 'runtime:note', text: 'two', contentKey: 'same', count: 3 },
    ] }] }
  const event: import('@harnessdesk/protocol').AgentEvent = { type: 'notice', sessionId: id, class: 'conversation', id: 'n3', level: 'warning', message: 'new', contentKey: 'same', at: 10 }
  const overlay = new PendingSessionOverlay(recoveryDescriptor(original)); overlay.apply(event)
  assert.deepEqual(overlay.materialize(original), reduceSession(original, event))
})

test('symbolic Host overlay follows registry across mixed notices, errors, reads and turn replacements', async () => {
  const { SessionRegistry } = await import('../src/registry.js')
  const { PendingSessionOverlay, recoveryDescriptor } = await import('../src/recovery-descriptor.js')
  const runtime = runtimeId('fake'), id = sessionId('s'), tids = [turnId('a'), turnId('b'), turnId('notice:n')]
  let seed = 0x937ac; const next = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0 }
  const item = () => {
    const iid = itemId(`i${next() % 5}`), kind = next() % 4
    return kind === 0 ? { id: iid, type: 'assistantMessage' as const, text: `v${next() % 3}` } :
      kind === 1 ? { id: iid, type: 'error' as const, message: `e${next() % 3}` } :
      kind === 2 ? { id: iid, type: 'notice' as const, kind: 'runtime:note', text: 'note', contentKey: `k${next() % 2}` } :
      { id: iid, type: 'userMessage' as const, content: [{ type: 'text' as const, text: `v${next() % 3}`, ...(next() % 2 ? { deskContext: { prefixLength: 0 } } : {}) }] }
  }
  for (let run = 0; run < 120; run++) {
    const original: Session = { runtime, id, cwd: '/x', createdAt: 1, updatedAt: 1, status: { type: 'idle' }, itemsLoaded: true,
      turns: [{ id: tids[0]!, status: 'completed', items: [item()] }] }
    const registry = new SessionRegistry(), record = registry.upsert(original, null), overlay = new PendingSessionOverlay(recoveryDescriptor(record.session))
    for (let step = 0; step < 35; step++) {
      const tid = tids[next() % tids.length]!, iid = itemId(`i${next() % 5}`), choice = next() % 10
      const event: import('@harnessdesk/protocol').AgentEvent = choice === 0 ? { type: 'turn/started', sessionId: id, turn: { id: tid, status: 'inProgress', items: [] } } :
        choice === 1 ? { type: 'turn/completed', sessionId: id, turn: { id: tid, status: 'completed', items: Array.from({ length: next() % 4 }, item), ...(next() % 3 === 0 ? { error: { message: `e${next() % 3}` } } : {}) } } :
        choice === 2 ? { type: 'item/delta', sessionId: id, turnId: tid, itemId: iid, delta: { kind: 'assistantText', text: 'x' } } :
        choice === 3 ? { type: 'item/completed', sessionId: id, turnId: tid, item: item() } :
        choice === 4 ? { type: 'notice', sessionId: id, class: 'conversation', id: `n${next() % 4}`, level: 'warning', message: `m${next() % 2}`, contentKey: `k${next() % 2}` } :
        choice === 5 ? { type: 'error', sessionId: id, error: { code: 'unknown', message: `e${next() % 3}`, retrying: next() % 2 === 0 } } :
        choice === 6 ? { type: 'session/started', session: { ...original, itemsLoaded: next() % 3 !== 0, partialHistory: next() % 2 === 0,
          turns: [{ id: tid, status: 'completed', items: Array.from({ length: next() % 4 }, item) }] } } :
        choice === 7 ? { type: 'turn/diff', sessionId: id, turnId: tid, diff: `d${next() % 2}` } :
        choice === 8 ? { type: 'session/detached', sessionId: id } : { type: 'session/title', sessionId: id, title: `title${next() % 3}` }
      overlay.applyHostEvent(event, [...record.watched], [...record.running], record.seatedAs)
      registry.apply(runtime, event)
      assert.deepEqual(overlay.materialize(original), registry.get(runtime, id)!.session, `sequence ${run}, event ${step}`)
    }
  }
})

test('descriptor replacement reserves capacity without discarding the prior descriptor until commit', async () => {
  const module = await import('../src/recovery-descriptor.js') as unknown as { DescriptorCache: new (maxBytes: number) => { put(key: string, value: object): boolean; get(key: string): object | undefined; reserve?: (key: string, value: object) => symbol | null; commit?: (token: symbol) => boolean; cancel?: (token: symbol) => void; readonly bytes: number } }
  const cache = new module.DescriptorCache(160), old = { id: 'old' }, next = { id: 'new'.repeat(12) }
  assert.equal(cache.put('one', old), true)
  assert.equal(typeof cache.reserve, 'function')
  const token = cache.reserve!('one', next)
  assert.ok(token)
  assert.deepEqual(cache.get('one'), old, 'an in-flight release must retain the old descriptor')
  assert.equal(cache.put('one', { id: 'competing' }), false, 'same-owner replacement is fenced while reserved')
  assert.equal(cache.commit!(token!), true)
  assert.deepEqual(cache.get('one'), next)
  const before = cache.bytes
  assert.equal(cache.reserve!('one', { id: 'x'.repeat(500) }), null)
  assert.equal(cache.bytes, before)
  assert.deepEqual(cache.get('one'), next)
  const cancel = cache.reserve!('one', old)
  assert.ok(cancel); cache.cancel!(cancel!)
  assert.deepEqual(cache.get('one'), next)
})
