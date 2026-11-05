import assert from 'node:assert/strict'
import test from 'node:test'
import { leadChatCandidates } from '../src/lead/chat-candidates.js'
import { FakeRuntime } from './fixtures/fake-runtime.js'

test('candidate reads refresh reached limits after reset and never expose backend ids', async () => {
  const runtime = new FakeRuntime()
  const choices = await leadChatCandidates([runtime], undefined, new Map([[runtime.info.id, { reached: 'Weekly' }]]))
  assert.equal(choices.length, 1, 'the provider now reports fresh available credit')
  assert.equal(choices[0]?.name, runtime.info.presentation.name)
  assert.match(choices[0]!.key, /^agent-[a-f0-9]{16}$/)
})

test('an unresponsive sign-in read is bounded and cannot block another candidate', async () => {
  const unavailable = new FakeRuntime({ capabilities: { account: true } })
  unavailable.getAccount = () => new Promise(() => {})
  const choices = await leadChatCandidates([unavailable], undefined, new Map(), 5)
  assert.deepEqual(choices, [])
})
