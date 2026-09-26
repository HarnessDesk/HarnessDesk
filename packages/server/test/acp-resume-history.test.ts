import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { AcpRuntime } from '@harnessdesk/adapter-acp'
import type { Session } from '@harnessdesk/protocol'

import type { FakeRuntime } from './fixtures/fake-runtime.js'
import { Client, halt, start, stop } from './fixtures/harness.js'
import { tempDir } from './scratch.js'

/**
 * A conversation reopened by an agent that resumes without replaying.
 *
 * DeepSeek Harness's own server offers `session/resume` and no
 * `session/load`: the agent gets its context back and the wire carries none
 * of the past. The desk keeps its own transcript for exactly this, so the
 * turns before the reopen must survive the first new turn — in the read and
 * on disk. They did not: the read after one reply held only that reply, and
 * recording it wrote the shortened conversation over the transcript.
 */

const PEER = fileURLToPath(new URL('../../../adapter-acp/dist/test/fixtures/fake-acp-agent.mjs', import.meta.url))

for (const [how, resumeOnly] of [
  ['an agent that resumes without replaying', true],
  ['an agent that replays on load', false],
] as const) {
  test(`after a restart, reopening and replying keeps every earlier turn — ${how}`, async (t) => {
    const store = join(tempDir('hd-resume-history-store-'), 'sessions.json')
    const work = tempDir('hd-resume-history-work-')
    execFileSync('git', ['init', '-q', work])
    const peer = (): AcpRuntime =>
      new AcpRuntime({
        id: 'rig-agent',
        name: 'Rig Agent',
        command: process.execPath,
        args: [PEER],
        env: { FAKE_ACP_STORE: store, ...(resumeOnly ? { FAKE_ACP_RESUME_ONLY: '1' } : {}) },
      })
    const settle = async (client: Client, sessionId: string, turns: number): Promise<Session> => {
      let read: Session | null = null
      for (let tries = 0; tries < 200; tries += 1) {
        read = (await client.call('session/read', { runtime: 'rig-agent', sessionId })) as Session
        if (read.turns.length >= turns && !read.turns.some((turn) => turn.status === 'inProgress')) return read
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
      return read!
    }

    const first = await start({}, undefined, peer() as unknown as FakeRuntime)
    const client = await Client.connect(first.server)
    await client.call('workspace/open', { path: work })
    const created = (await client.call('session/create', { runtime: 'rig-agent', options: { cwd: work } })) as Session
    const sessionId = String(created.id)
    await client.call('turn/send', { runtime: 'rig-agent', sessionId, input: [{ type: 'text', text: 'first words' }] })
    assert.equal((await settle(client, sessionId, 1)).turns.length, 1)
    client.close()
    await halt(first)

    const again = await start({}, first.stateDir, peer() as unknown as FakeRuntime)
    t.after(() => stop(again))
    const reopened = await Client.connect(again.server)
    t.after(() => reopened.close())
    await reopened.call('workspace/open', { path: work })
    await reopened.call('session/resume', { runtime: 'rig-agent', sessionId })
    await reopened.call('turn/send', { runtime: 'rig-agent', sessionId, input: [{ type: 'text', text: 'second words' }] })
    const read = await settle(reopened, sessionId, 2)
    const said = (session: { turns: readonly { items: readonly { type: string; content?: unknown }[] }[] }) =>
      session.turns.map((turn) => JSON.stringify(turn.items.find((item) => item.type === 'userMessage')?.content ?? null))
    assert.equal(read.turns.length, 2, `both turns in the read: ${said(read).join(' | ')}`)
    assert.match(said(read)[0] ?? '', /first words/)
    assert.match(said(read)[1] ?? '', /second words/)

    // And on disk: the transcript is written from the held session.
    const file = join(again.stateDir, 'transcripts', 'rig-agent', `${encodeURIComponent(sessionId)}.json`)
    let stored = null as { turns: { items: { type: string; content?: unknown }[] }[] } | null
    for (let tries = 0; tries < 100; tries += 1) {
      stored = JSON.parse(await readFile(file, 'utf8').catch(() => 'null')) as typeof stored
      if (stored && stored.turns.length >= 2) break
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    assert.equal(stored?.turns.length, 2, 'the transcript kept the earlier turn')
    assert.match(said(stored!)[0] ?? '', /first words/)
  })
}
