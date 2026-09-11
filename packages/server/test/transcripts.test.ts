import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  runtimeId,
  sessionId,
  turnId,
  type AgentItem,
  type Session,
  type SessionUsage,
  type Turn,
} from '@harnessdesk/protocol'

import { TranscriptStore } from '../src/transcripts.js'

/**
 * The store exists because backends forget their own steps. The property
 * under test: a read that comes back thinner than what the host watched is
 * filled in from what the host watched — and nothing else changes.
 */

const item = (id: string, type: AgentItem['type']): AgentItem =>
  ({ id, type, text: 'x', command: 'ls', cwd: '/', origin: 'agent', actions: [], status: 'completed', summary: [], content: [] }) as unknown as AgentItem

const turn = (id: string, items: AgentItem[], extra: Partial<Turn> = {}): Turn => ({
  id: turnId(id),
  items,
  status: 'completed',
  ...extra,
})

const session = (turns: Turn[], itemsLoaded = true): Session => ({
  id: sessionId('s1'),
  runtime: runtimeId('codex'),
  cwd: '/repo',
  status: { type: 'idle' },
  createdAt: 1,
  updatedAt: 2,
  turns,
  itemsLoaded,
})

const tokens = { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 }
const usage: SessionUsage = { total: tokens, last: tokens, contextUsed: 55_200, contextWindow: 272_000 }

const withStore = async (fn: (store: TranscriptStore, dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'hd-transcripts-'))
  try {
    await fn(new TranscriptStore(dir), dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a thinner read is filled in from the turns the host recorded', async () => {
  await withStore(async (store) => {
    const full = session([
      turn('t1', [item('u', 'userMessage'), item('r', 'reasoning'), item('c', 'command'), item('a', 'assistantMessage')], {
        durationMs: 100,
      }),
    ])
    store.record(full, { now: true })
    await store.flush()

    const thin = session([turn('t1', [item('u', 'userMessage'), item('a', 'assistantMessage')], { durationMs: 120, diff: 'd' })])
    const enriched = await store.enrich(thin)
    assert.equal(enriched.turns[0]?.items.length, 4)
    // The backend's own facts about the turn win.
    assert.equal(enriched.turns[0]?.durationMs, 120)
    assert.equal(enriched.turns[0]?.diff, 'd')
  })
})

test('a turn the backend no longer lists is not brought back', async () => {
  await withStore(async (store) => {
    store.record(session([turn('t1', [item('u', 'userMessage'), item('c', 'command')]), turn('t2', [item('u2', 'userMessage')])]), {
      now: true,
    })
    await store.flush()
    const rolledBack = session([turn('t1', [item('u', 'userMessage')])])
    const enriched = await store.enrich(rolledBack)
    assert.equal(enriched.turns.length, 1)
    assert.equal(enriched.turns[0]?.items.length, 2)
  })
})

/**
 * A publication is the host's own item: no backend read ever carries one.
 * So the rule that a read which knows as much is returned untouched has one
 * exception — the host's rows are put back where they stood, whichever list
 * stands. The control below it is the same read without a publication,
 * which is still returned untouched.
 */
test('a publication the host recorded is carried into a read that already knows as much', async () => {
  await withStore(async (store) => {
    const publication = {
      ...item('p', 'publication'),
      reference: { kind: 'pullRequest', repo: 'acme/widgets', number: 7, url: 'https://github.com/acme/widgets/pull/7', via: 'gh' },
    } as unknown as AgentItem
    store.record(session([turn('t1', [item('u', 'userMessage'), publication, item('a', 'assistantMessage')])]), { now: true })
    await store.flush()
    // The backend knows three items too — one of them a step it stored and never streamed.
    const asMuch = session([turn('t1', [item('u', 'userMessage'), item('a', 'assistantMessage'), item('x', 'reasoning')])])
    const enriched = await store.enrich(asMuch)
    assert.deepEqual(
      enriched.turns[0]?.items.map((entry) => entry.type),
      ['userMessage', 'publication', 'assistantMessage', 'reasoning'],
      'the backend’s list, with the host’s row put back at its place',
    )
    // The control: without a publication, as much is as much.
    store.record(session([turn('t2', [item('u2', 'userMessage'), item('a2', 'assistantMessage')])]), { now: true })
    await store.flush()
    const plain = session([turn('t2', [item('u2', 'userMessage'), item('a2', 'assistantMessage')])])
    assert.equal(await store.enrich(plain), plain)
  })
})

test('a read that already knows as much is returned untouched', async () => {
  await withStore(async (store) => {
    const full = session([turn('t1', [item('u', 'userMessage'), item('c', 'command')])])
    store.record(full, { now: true })
    await store.flush()
    const same = session([turn('t1', [item('u', 'userMessage'), item('c', 'command')])])
    assert.equal(await store.enrich(same), same)
    const unknown = session([turn('t9', [item('u', 'userMessage')])])
    assert.equal(await store.enrich(unknown), unknown)
  })
})

test('nothing is written for sessions without loaded items, and writes settle', async () => {
  await withStore(async (store, dir) => {
    store.record(session([], false))
    store.record(session([turn('t1', [])]))
    await store.flush()
    await assert.rejects(readdir(join(dir, 'codex')))

    store.record(session([turn('t1', [item('u', 'userMessage')])]))
    store.record(session([turn('t1', [item('u', 'userMessage'), item('c', 'command')])]))
    await store.flush()
    const files = await readdir(join(dir, 'codex'))
    assert.deepEqual(files, ['s1.json'])
    const enriched = await store.enrich(session([turn('t1', [item('u', 'userMessage')])]))
    assert.equal(enriched.turns[0]?.items.length, 2)
  })
})

/**
 * Every adapter keeps its usage on the live session handle, which a restart
 * takes with it — and no backend answers a read with the tokens it reported
 * earlier. The host's own record is the only thing left, so it carries them.
 */

test('the last tokens are remembered across a restart, whichever agent reported them', async () => {
  await withStore(async (store) => {
    const watched = { ...session([turn('t1', [item('u', 'userMessage'), item('a', 'assistantMessage')])]), usage }
    store.record(watched, { now: true })
    await store.flush()

    // A cold read: the process that heard the tokens is gone, and the backend
    // says nothing about them.
    const cold = session([turn('t1', [item('u', 'userMessage')])])
    assert.equal(cold.usage, undefined)
    assert.deepEqual((await store.enrich(cold)).usage, usage)
  })
})

test('a runtime that still has the figures is never argued with', async () => {
  await withStore(async (store) => {
    store.record({ ...session([turn('t1', [item('u', 'userMessage')])]), usage }, { now: true })
    await store.flush()

    const fresher: SessionUsage = { ...usage, contextUsed: 61_000 }
    const live = { ...session([turn('t1', [item('u', 'userMessage')])]), usage: fresher }
    assert.deepEqual((await store.enrich(live)).usage, fresher)
  })
})

test('tokens from before a conversation moved on elsewhere are not shown', async () => {
  await withStore(async (store) => {
    store.record({ ...session([turn('t1', [item('u', 'userMessage'), item('a', 'assistantMessage')])]), usage }, {
      now: true,
    })
    await store.flush()

    // Continued in Codex Desktop or the Claude CLI while HarnessDesk was shut:
    // the stored figure describes a context that no longer exists.
    const movedOn = session([
      turn('t1', [item('u', 'userMessage')]),
      turn('t2', [item('u2', 'userMessage')]),
    ])
    assert.equal((await store.enrich(movedOn)).usage, undefined)
    // The transcript is still enriched — only the number is withheld.
    assert.equal((await store.enrich(movedOn)).turns[0]?.items.length, 2)
  })
})

test('a transcript written before usage was stored still reads as a transcript', async () => {
  await withStore(async (store) => {
    store.record(session([turn('t1', [item('u', 'userMessage'), item('c', 'command')])]), { now: true })
    await store.flush()
    const enriched = await store.enrich(session([turn('t1', [item('u', 'userMessage')])]))
    assert.equal(enriched.turns[0]?.items.length, 2)
    assert.equal(enriched.usage, undefined)
  })
})

/**
 * The search half: one store, every agent, the words themselves. What is
 * pinned is the scope — spoken words only, tool noise never — and that a hit
 * introduces itself well enough to be a result row on its own.
 */

const said = (id: string, type: 'userMessage' | 'assistantMessage', text: string): AgentItem =>
  (type === 'assistantMessage'
    ? { id, type, text }
    : { id, type, content: [{ type: 'text', text }] }) as unknown as AgentItem

const talk = (
  runtime: string,
  id: string,
  lines: [('userMessage' | 'assistantMessage'), string][],
  extra: Partial<Session> = {},
): Session => ({
  id: sessionId(id),
  runtime: runtimeId(runtime),
  cwd: `/repo/${id}`,
  title: `About ${id}`,
  status: { type: 'idle' },
  createdAt: 1,
  updatedAt: 100,
  turns: [turn('t1', lines.map(([type, text], index) => said(`i${index}`, type, text)))],
  itemsLoaded: true,
  ...extra,
})

test('search reads every agent’s transcripts and says where the words were', async () => {
  await withStore(async (store) => {
    store.record(talk('codex', 'a', [['userMessage', 'please fix the flaky websocket test']]), { now: true })
    store.record(talk('claude', 'b', [['assistantMessage', 'The WebSocket reconnect had a race.']]), { now: true })
    store.record(talk('claude', 'c', [['userMessage', 'rename the settings page']]), { now: true })
    await store.flush()

    const hits = await store.search('websocket')
    assert.equal(hits.length, 2)
    assert.deepEqual(new Set(hits.map((hit) => String(hit.summary.runtime))), new Set(['codex', 'claude']))
    for (const hit of hits) {
      assert.match(hit.line.slice(hit.start, hit.end).toLowerCase(), /^websocket$/)
      assert.notEqual(hit.summary.title, null)
      assert.match(hit.summary.cwd, /^\/repo\//)
      assert.equal(hit.summary.updatedAt, 100)
    }
  })
})

test('tool output and reasoning are not the conversation', async () => {
  await withStore(async (store) => {
    const noisy: Session = {
      ...talk('codex', 'noisy', [['userMessage', 'run the suite']]),
      turns: [
        turn('t1', [
          said('u', 'userMessage', 'run the suite'),
          { id: 'r', type: 'reasoning', text: 'zanzibar appears in my thoughts' } as unknown as AgentItem,
          { id: 'c', type: 'command', command: 'echo zanzibar', output: 'zanzibar' } as unknown as AgentItem,
        ]),
      ],
    }
    store.record(noisy, { now: true })
    await store.flush()
    assert.deepEqual(await store.search('zanzibar'), [])
    assert.equal((await store.search('suite')).length, 1)
  })
})

test('a long line is clipped around the match, offsets recomputed', async () => {
  await withStore(async (store) => {
    const line = `${'x'.repeat(300)} the treasure is buried here ${'y'.repeat(300)}`
    store.record(talk('codex', 'long', [['assistantMessage', line]]), { now: true })
    await store.flush()
    const [hit] = await store.search('treasure')
    assert.ok(hit)
    assert.ok(hit.line.length < 220)
    assert.equal(hit.line.slice(hit.start, hit.end), 'treasure')
    assert.match(hit.line, /^…/)
    assert.match(hit.line, /…$/)
  })
})

test('search survives an empty store, an empty query, and a corrupt file', async () => {
  await withStore(async (store, dir) => {
    assert.deepEqual(await store.search('anything'), [])
    store.record(talk('codex', 'good', [['userMessage', 'a fine conversation']]), { now: true })
    await store.flush()
    assert.deepEqual(await store.search('   '), [])
    const { writeFile: write } = await import('node:fs/promises')
    await write(join(dir, 'codex', 'bad.json'), 'not json at all')
    const hits = await store.search('fine conversation')
    assert.equal(hits.length, 1)
  })
})

test('a transcript stamped by a newer format is never overwritten', async () => {
  await withStore(async (store, dir) => {
    const { mkdir, readFile: read, writeFile: write } = await import('node:fs/promises')
    await mkdir(join(dir, 'codex'), { recursive: true })
    const future = JSON.stringify({ version: 2, somethingNewer: true })
    await write(join(dir, 'codex', 's1.json'), future)

    store.record(session([turn('t1', [item('u', 'userMessage')])]), { now: true })
    await store.flush()
    assert.equal(
      await read(join(dir, 'codex', 's1.json'), 'utf8'),
      future,
      'the newer file is byte-for-byte untouched',
    )
  })
})

test('a file from before the metadata still makes a presentable hit', async () => {
  await withStore(async (store, dir) => {
    store.record(talk('codex', 'old', [['userMessage', 'the first words spoken']]), { now: true })
    await store.flush()
    // Strip the file back to the old format: no title, preview, cwd.
    const file = join(dir, 'codex', 'old.json')
    const { readFile: read, writeFile: write } = await import('node:fs/promises')
    const parsed = JSON.parse(await read(file, 'utf8')) as Record<string, unknown>
    delete parsed['title']
    delete parsed['preview']
    delete parsed['cwd']
    delete parsed['updatedAt']
    await write(file, JSON.stringify(parsed))

    const [hit] = await store.search('first words')
    assert.ok(hit)
    assert.equal(hit.summary.title, null)
    assert.equal(hit.summary.preview, 'the first words spoken')
    assert.equal(hit.summary.cwd, '')
    assert.ok(hit.summary.updatedAt > 0)
  })
})

test('a replay that segments the conversation differently is not doubled', async () => {
  await withStore(async (store) => {
    // Live: one turn — the prompt, a tool call, the answer — plus the tokens.
    const live = {
      ...session([
        turn('t1', [item('u', 'userMessage'), item('toolu_1', 'toolCall'), item('a', 'assistantMessage')], {
          durationMs: 100,
        }),
      ]),
      usage,
    }
    store.record(live, { now: true })
    await store.flush()

    // Reopened: the same conversation replayed as three turns — two notices
    // the live stream never showed, then the work, renumbered. The id "t1"
    // now names a notice; matching on it pasted the work onto the notice
    // while the replay's own copy stood beside it, the conversation twice.
    const replay = session([
      turn('t1', [item('n1', 'notice')]),
      turn('t2', [item('n2', 'notice')]),
      turn('t3', [item('u3', 'userMessage'), item('toolu_1', 'toolCall'), item('a3', 'assistantMessage')]),
    ])
    const enriched = await store.enrich(replay)
    assert.equal(enriched.turns.length, 3)
    assert.equal(enriched.turns[0]?.items.length, 1, 'the notice keeps its own items')
    assert.equal(enriched.turns[0]?.items[0]?.type, 'notice')
    assert.equal(enriched.turns[2]?.items.length, 3)
    // The tokens follow the content too: the stored last turn is the replayed
    // last turn, whatever number it wears now.
    assert.deepEqual(enriched.usage, usage)
  })
})

test('a stored turn whose calls the read placed elsewhere never matches by id', async () => {
  await withStore(async (store) => {
    store.record(
      session([
        turn('t1', [item('u', 'userMessage'), item('toolu_a', 'toolCall'), item('extra', 'reasoning'), item('a', 'assistantMessage')]),
      ]),
      { now: true },
    )
    await store.flush()

    // The read split the stored turn across two of its own: neither half may
    // take the whole stored turn, or the shared items double.
    const split = session([
      turn('t1', [item('u', 'userMessage'), item('toolu_a', 'toolCall')]),
      turn('t2', [item('a', 'assistantMessage')]),
    ])
    const enriched = await store.enrich(split)
    assert.equal(enriched.turns[0]?.items.length, 2)
    assert.equal(enriched.turns[1]?.items.length, 1)
  })
})

test('a conversation the backend refuses is recovered from the store alone', async () => {
  await withStore(async (store) => {
    store.record(
      {
        ...session([turn('t1', [item('u', 'userMessage'), item('a', 'assistantMessage')])]),
        title: 'Plan the website',
        usage,
      },
      { now: true },
    )
    await store.flush()

    const recovered = await store.recover(runtimeId('codex'), sessionId('s1'))
    assert.ok(recovered, 'the stored transcript stands in')
    assert.equal(recovered.turns.length, 1)
    assert.equal(recovered.turns[0]?.items.length, 2)
    assert.equal(recovered.title, 'Plan the website')
    assert.equal(recovered.status.type, 'idle')
    assert.equal(recovered.itemsLoaded, true)
    assert.deepEqual(recovered.usage, usage)

    assert.equal(await store.recover(runtimeId('codex'), sessionId('never-seen')), null, 'nothing invents a transcript')
  })
})

test('forgetting a session cancels the write still queued for it', async () => {
  // #36: the queue was keyed with a NUL and forget() looked for a space, so a
  // deleted conversation's transcript was written back a moment later.
  await withStore(async (store, dir) => {
    store.record(session([turn('t1', [item('i1', 'assistantMessage')])]))
    await store.forget(runtimeId('codex'), sessionId('s1'))
    await new Promise((resolve) => setTimeout(resolve, 1_200))
    assert.deepEqual(await readdir(dir, { recursive: true }), [])
  })
})

test('dropping turns trims what the store kept from the end, after a write still waiting, and forgets one with none left (review of #236, round 1)', async () => {
  await withStore(async (store) => {
    const three = session([turn('t1', [item('a', 'assistantMessage')]), turn('t2', [item('b', 'assistantMessage')]), turn('t3', [item('c', 'assistantMessage')])])
    // Recorded and not yet written: the settle delay is still running.
    store.record(three)
    await store.dropTurns(three.runtime, three.id, 1)
    assert.deepEqual((await store.recover(three.runtime, three.id))?.turns.map((entry) => String(entry.id)), ['t1', 't2'])
    // A rollback of nothing changes nothing.
    await store.dropTurns(three.runtime, three.id, 0)
    assert.equal((await store.recover(three.runtime, three.id))?.turns.length, 2)
    await store.dropTurns(three.runtime, three.id, 2)
    assert.equal(await store.recover(three.runtime, three.id), null)
  })
})
