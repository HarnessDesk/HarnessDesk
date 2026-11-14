import { describe, expect, it } from 'vitest'
import { itemId, turnId, type AgentItem, type Session, type SubagentItem } from '@harnessdesk/protocol'

import { actionOf, addressedIn, childrenOf, childrenOfSession, openWait, phaseOf, rollupOf, rollupWords, spawnedIn, subagentItemIdsOf } from './subagent-flow'

const call = (id: string, action: string, status: SubagentItem['status'], members: SubagentItem['members'], extra: Partial<SubagentItem> = {}): SubagentItem =>
  ({ id: itemId(id), type: 'subagent', action, status, members, ...extra })

describe('phaseOf', () => {
  it('reads every runtime’s state words into one set of phases', () => {
    expect(['pendingInit', 'running'].map(state => phaseOf(state))).toEqual(['working', 'working'])
    expect(['completed', 'shutdown'].map(state => phaseOf(state))).toEqual(['done', 'done'])
    expect(phaseOf('errored')).toBe('failed')
    expect(phaseOf('interrupted')).toBe('stopped')
    expect(phaseOf('stopped')).toBe('stopped')
    expect(phaseOf('notFound')).toBe('ended')
  })

  it('takes an unknown word from the item that carried it', () => {
    expect(phaseOf('mystery', 'inProgress')).toBe('working')
    expect(phaseOf(null, 'failed')).toBe('failed')
    expect(phaseOf(undefined, 'completed')).toBe('ended')
  })
})

describe('actionOf', () => {
  it('says Codex’s tool names and the ACP verbs the same way', () => {
    expect(['spawnAgent', 'spawn'].map(actionOf)).toEqual(['spawn', 'spawn'])
    expect(['sendInput', 'sendMessage', 'followupTask', 'send'].map(actionOf)).toEqual(['send', 'send', 'send', 'send'])
    expect(['closeAgent', 'interruptAgent', 'cancel'].map(actionOf)).toEqual(['cancel', 'cancel', 'cancel'])
    expect(actionOf('wait')).toBe('wait')
  })
})

describe('childrenOf', () => {
  // Codex: one spawn per child, then a wait that reports both.
  const codex: AgentItem[] = [
    call('s1', 'spawnAgent', 'completed', [{ sessionId: 'thread-a', nickname: 'explorer', role: 'scout', state: 'pendingInit' }], { prompt: 'Find the parser', model: 'model-a', startedAt: 1_000, completedAt: 1_100 }),
    call('s2', 'spawnAgent', 'completed', [{ sessionId: 'thread-b', nickname: 'worker', state: 'pendingInit' }], { prompt: 'Run the tests', startedAt: 2_000, completedAt: 2_100 }),
    call('w1', 'wait', 'completed', [
      { sessionId: 'thread-a', nickname: 'explorer', state: 'completed' },
      { sessionId: 'thread-b', nickname: 'worker', state: 'running' },
    ], { startedAt: 3_000, completedAt: 9_000 }),
  ]

  it('folds the calls into one row per child, the latest word winning', () => {
    const rows = childrenOf(codex)
    expect(rows.map(row => [row.id, row.name, row.phase])).toEqual([['thread-a', 'explorer', 'done'], ['thread-b', 'worker', 'working']])
    expect(rows[0]).toMatchObject({ role: 'scout', prompt: 'Find the parser', model: 'model-a', startedAt: 1_000, endedAt: 9_000, openable: true })
    expect(rows[1]).toMatchObject({ prompt: 'Run the tests', startedAt: 2_000, endedAt: null })
  })

  it('keeps the first end it saw rather than moving it with every later report', () => {
    const later = call('w2', 'wait', 'completed', [{ sessionId: 'thread-a', state: 'completed' }], { startedAt: 10_000, completedAt: 12_000 })
    expect(childrenOf([...codex, later])[0]?.endedAt).toBe(9_000)
  })

  it('ends a child still said to be working once the conversation has settled', () => {
    const rows = childrenOf(codex, { settled: true })
    expect(rows.map(row => row.phase)).toEqual(['done', 'ended'])
    expect(rows[1]?.lastSeenAt).toBe(9_000)
  })

  it('settles an open wait that addressed a child an earlier item started', () => {
    const items = [
      call('s', 'spawnAgent', 'completed', [{ sessionId: 'a', state: 'running' }]),
      call('w', 'wait', 'inProgress', [{ sessionId: 'a', state: 'running' }]),
    ]
    expect(childrenOf(items, { settled: true })[0]?.phase).toBe('ended')
    expect(childrenOf(items, { liveFrom: 2 })[0]?.phase).toBe('ended')
  })

  it('leaves a child whose own item is still open to that item, settled or not', () => {
    // A background child outlives the turn that started it; its item says when it ends.
    const own = [call('d1', 'spawn', 'inProgress', [{ sessionId: 'toolu_1', nickname: 'Explore', state: 'running', openable: false }], { startedAt: 5 })]
    expect(childrenOf(own, { settled: true })[0]?.phase).toBe('working')
    expect(childrenOf(own, { liveFrom: 1 })[0]?.phase).toBe('working')
    // A copy of the transcript carries no live record, so it settles.
    expect(childrenOf(own, { settled: true, isOpen: () => false })[0]?.phase).toBe('ended')
  })

  it('reads an ACP child — one item per child, replaced as it moves — the same way', () => {
    const rows = childrenOf([
      call('d1', 'spawn', 'failed', [{ sessionId: 'toolu_1', nickname: 'Explore', state: 'stopped', openable: false, usage: { totalTokens: 4_200, inputTokens: 4_000, cachedInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 } }], { startedAt: 5, completedAt: 50 }),
    ])
    expect(rows[0]).toMatchObject({ phase: 'stopped', openable: false, startedAt: 5, endedAt: 50 })
    expect(rows[0]?.usage?.totalTokens).toBe(4_200)
  })

  it('treats names and prompts as agent text', () => {
    const rows = childrenOf([call('x', 'spawn', 'inProgress', [{ sessionId: 'h', nickname: '\u001b[31mScout\u001b[0m', state: 'running' }], { prompt: '\u001b[1mRead\u001b[0m' })])
    expect(rows[0]?.name).toBe('Scout')
    expect(rows[0]?.prompt).toBe('Read')
  })

  it('keeps a name and a model on one line', () => {
    const rows = childrenOf([call('x', 'spawn', 'inProgress', [{ sessionId: 'h', nickname: 'Scout\tone\nline', state: 'running' }], { model: 'model\na' })])
    expect(rows[0]?.name).toBe('Scout one line')
    expect(rows[0]?.model).toBe('model a')
  })

  it('keeps the phase it knows when a later call names a child without a state word', () => {
    const rows = childrenOf([
      call('s', 'spawnAgent', 'completed', [{ sessionId: 'a', nickname: 'explorer', state: 'running' }], { startedAt: 1_000, completedAt: 1_100 }),
      call('m', 'sendInput', 'completed', [{ sessionId: 'a' }], { startedAt: 2_000, completedAt: 2_100 }),
    ])
    expect(rows[0]).toMatchObject({ name: 'explorer', phase: 'working', endedAt: null })
  })

  it('does not let an older report move a child back', () => {
    // A long wait returns after a later message: its "completed" is older news
    // than the message's "running"... and the other way round must hold too.
    const rows = childrenOf([
      call('s', 'spawnAgent', 'completed', [{ sessionId: 'a', state: 'running' }], { startedAt: 1_000, completedAt: 1_100 }),
      call('m', 'sendInput', 'completed', [{ sessionId: 'a', state: 'completed', model: 'model-b' }], { startedAt: 5_000, completedAt: 6_000 }),
      call('w', 'wait', 'completed', [{ sessionId: 'a', state: 'running', nickname: 'late' }], { startedAt: 2_000, completedAt: 4_000 }),
    ])
    expect(rows[0]).toMatchObject({ phase: 'done', endedAt: 6_000, lastSeenAt: 6_000, model: 'model-b' })
    // The stale call still fills what was missing.
    expect(rows[0]?.name).toBe('late')
  })

  it('ends a child named only in an earlier turn while a later turn runs', () => {
    const rows = childrenOf(codex, { liveFrom: 3 })
    expect(rows.map(row => row.phase)).toEqual(['done', 'ended'])
    expect(childrenOf(codex, { liveFrom: 2 }).map(row => row.phase)).toEqual(['done', 'working'])
  })
})

describe('Codex 0.160 activity items', () => {
  it('fold into children that start, end and keep their name', () => {
    const rows = childrenOf([
      call('a1', 'spawnAgent', 'completed', [{ sessionId: 'thread-a', nickname: 'alpha', state: 'running' }], { startedAt: 1_000 }),
      call('b1', 'spawnAgent', 'completed', [{ sessionId: 'thread-b', nickname: 'beta', state: 'running' }], { startedAt: 2_000 }),
      call('w', 'wait', 'completed', [], { startedAt: 3_000 }),
      call('a2', 'agentCompleted', 'completed', [{ sessionId: 'thread-a', nickname: 'alpha', state: 'completed' }], { startedAt: 30_000 }),
    ])
    expect(rows.map(row => [row.name, row.phase, row.endedAt])).toEqual([['alpha', 'done', 30_000], ['beta', 'working', null]])
  })
})

describe('childrenOfSession', () => {
  const session = (turns: Session['turns'], status: Session['status'] = { type: 'active' }): Session =>
    ({ id: 'root', runtime: 'codex', status, turns } as unknown as Session)
  const spawn = call('s', 'spawnAgent', 'completed', [{ sessionId: 'a', nickname: 'explorer', state: 'running' }], { startedAt: 1_000 })
  const reply = { id: itemId('r'), type: 'assistantMessage', text: 'ok' } as unknown as AgentItem

  it('caches only sub-agent item ids by session identity across turns', () => {
    const wait = call('w', 'wait', 'completed', [{ sessionId: 'a', state: 'completed' }])
    const same = session([
      { id: turnId('t1'), status: 'completed', items: [reply, spawn] },
      { id: turnId('t2'), status: 'completed', items: [wait] },
    ])
    const ids = subagentItemIdsOf(same)
    expect([...ids]).toEqual(['s', 'w'])
    expect(subagentItemIdsOf(same)).toBe(ids)
  })

  it('reads nothing from a conversation with no sub-agent calls', () => {
    expect(childrenOfSession(session([{ id: turnId('t'), status: 'inProgress', items: [reply] }]))).toEqual([])
  })

  it('ends an earlier turn’s child while the next turn runs, and keeps the fold while only other items move', () => {
    const earlier = { id: turnId('t1'), status: 'completed' as const, items: [spawn] }
    const first = childrenOfSession(session([earlier, { id: turnId('t2'), status: 'inProgress', items: [reply] }]))
    expect(first.map(row => row.phase)).toEqual(['ended'])
    const again = childrenOfSession(session([earlier, { id: turnId('t2'), status: 'inProgress', items: [reply, { ...reply, id: itemId('r2') } as AgentItem] }]))
    expect(again).toBe(first)
    const same = session([earlier])
    expect(childrenOfSession(same)).toBe(childrenOfSession(same))
    expect(childrenOfSession(session([{ id: turnId('t1'), status: 'inProgress', items: [spawn] }])).map(row => row.phase)).toEqual(['working'])
  })

  it('keeps a background child working past its settled turn, but not one a cut-short turn left open', () => {
    const own = call('d', 'spawn', 'inProgress', [{ sessionId: 'toolu_1', nickname: 'Explore', state: 'running', openable: false }], { startedAt: 5 })
    const idle = { type: 'idle' } as Session['status']
    expect(childrenOfSession(session([{ id: turnId('t1'), status: 'completed', items: [own] }], idle)).map(row => row.phase)).toEqual(['working'])
    expect(childrenOfSession(session([{ id: turnId('t2'), status: 'interrupted', items: [own] }], idle)).map(row => row.phase)).toEqual(['ended'])
  })
})

describe('the rollup', () => {
  it('counts only the states that are news, and sums the tokens it was told', () => {
    const rows = childrenOf([
      call('a', 'spawn', 'inProgress', [{ sessionId: 'a', state: 'running', usage: { totalTokens: 1_000, inputTokens: 900, cachedInputTokens: 0, outputTokens: 100, reasoningOutputTokens: 0 } }], { startedAt: 10 }),
      call('b', 'spawn', 'failed', [{ sessionId: 'b', state: 'failed' }], { startedAt: 20, completedAt: 30 }),
    ])
    const rollup = rollupOf(rows)
    expect(rollupWords(rollup)).toEqual(['1 working', '1 failed'])
    expect(rollup).toMatchObject({ total: 2, totalTokens: 1_000, startedAt: 10, endedAt: null })
  })

  it('says nothing about tokens when no child reported any', () => {
    expect(rollupOf(childrenOf([call('a', 'spawn', 'completed', [{ sessionId: 'a', state: 'completed' }])])).totalTokens).toBeNull()
  })
})

describe('the calls themselves', () => {
  it('knows which children a stretch addressed, whether it started any, and an open wait', () => {
    const items: AgentItem[] = [
      call('s', 'spawnAgent', 'completed', [{ sessionId: 'a' }, { sessionId: 'b' }]),
      call('w', 'wait', 'inProgress', [{ sessionId: 'a' }, { sessionId: 'b' }]),
    ]
    expect(addressedIn(items)).toEqual(['a', 'b'])
    expect(spawnedIn(items)).toBe(true)
    expect(spawnedIn(items.slice(1))).toBe(false)
    expect(openWait(items)).toBe(2)
    expect(openWait([items[0]!, { ...(items[1] as SubagentItem), status: 'completed' }])).toBeNull()
    // A wait naming no child waits on every child still working.
    expect(openWait([call('w0', 'wait', 'inProgress', [])], 3)).toBe(3)
  })
})
