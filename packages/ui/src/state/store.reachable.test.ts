import { beforeEach, expect, it, vi } from 'vitest'

import { runtimeId, sessionId, type HostMethodName } from '@harnessdesk/protocol'

import { AppStore } from './store'

/**
 * Three host capabilities that had no caller, and now do.
 *
 * Each was implemented end to end — declared on the wire, validated,
 * answered by the host, covered by a server test — and unreachable from the
 * app, which is a shape no test in the repository could see. `credentials/
 * delete` meant a key could be stored and never removed; `team/inbound` meant
 * a room could be silenced only in whole; `capability/list` meant nothing
 * ever asked the one question only the host can answer.
 *
 * `script/check-reachable.mjs` is the gate that keeps a fourth from
 * appearing. These are the other half: that the caller sends what the host
 * validates, which a grep for the method name cannot tell.
 */

let store: AppStore
let sent: { method: string; params: unknown }[]

beforeEach(() => {
  store = new AppStore('ws://localhost:0/')
  sent = []
  vi.spyOn(store.transport, 'request').mockImplementation((async (
    method: HostMethodName,
    params: unknown,
  ) => {
    sent.push({ method, params })
    if (method === 'credentials/list') {
      return [{ ref: 'cred_a', name: 'Proxy key', createdAt: 1_700_000_000_000, agent: null }]
    }
    if (method === 'capability/list') return []
    return null
  }) as never)
})

it('forgetting a stored key names it by reference, and says whether it went', async () => {
  const keys = await store.listCredentials()
  expect(keys).toEqual([{ ref: 'cred_a', name: 'Proxy key', createdAt: 1_700_000_000_000, agent: null }])

  expect(await store.deleteCredential('cred_a')).toBe(true)
  expect(sent.at(-1)).toEqual({ method: 'credentials/delete', params: { ref: 'cred_a' } })
})

it('a refusal to forget a key is reported rather than swallowed', async () => {
  vi.spyOn(store.transport, 'request').mockRejectedValue(new Error('the keychain is locked'))
  /* `false`, and a notice — not a thrown error and not a silent `undefined`.
     The row stays where it is, which is the only honest outcome: the secret
     is still on the machine. */
  expect(await store.deleteCredential('cred_a')).toBe(false)
  expect(store.getSnapshot().notices.at(-1)?.message).toContain('the keychain is locked')
})

it('one member is set to hold, by runtime and conversation rather than by room', async () => {
  await store.setTeamInbound(runtimeId('codex'), sessionId('01a04ec8-90f2-70b0'), 'hold')
  /* No room in the params, and that is the point: inbound is a property of a
     conversation, so the same setting holds wherever that conversation is a
     member. `team/messaging` is the room-wide switch and takes a room. */
  expect(sent).toEqual([
    {
      method: 'team/inbound',
      params: { runtime: 'codex', sessionId: '01a04ec8-90f2-70b0', mode: 'hold' },
    },
  ])
})

it('asking what applies here sends the scope, and one absent part is left out', async () => {
  await store.listCapabilities('tool', { workspaceRoot: '/repo', runtime: runtimeId('codex') })
  /* Absent, not `undefined`: the validator refuses a key it does not know the
     shape of, and `{ sessionId: undefined }` is a key. */
  expect(sent).toEqual([
    { method: 'capability/list', params: { kind: 'tool', workspaceRoot: '/repo', runtime: 'codex' } },
  ])
  expect(Object.keys((sent[0] as { params: object }).params)).not.toContain('sessionId')
})

it('a host that refuses the capability question answers with nothing, not a throw', async () => {
  vi.spyOn(store.transport, 'request').mockRejectedValue(new Error('no plugin host'))
  expect(await store.listCapabilities('tool', {})).toEqual([])
  expect(store.getSnapshot().notices.at(-1)?.message).toContain('no plugin host')
})
