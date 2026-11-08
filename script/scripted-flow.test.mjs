import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setImmediate as tick } from 'node:timers/promises'
import { scriptedFlow } from '../packages/adapter-codex/test/fixtures/scripted-flow.mjs'

const setup = (t, config = {}) => {
  const cwd = mkdtempSync(join(tmpdir(), 'hd-scripted-flow-'))
  t.after(() => rmSync(cwd, { recursive: true, force: true }))
  const state = join(cwd, 'state.json'), approvalLog = join(cwd, 'approvals.ndjson')
  const frames = [], notifications = []
  let worker
  worker = scriptedFlow(JSON.stringify({ state, approvalLog, ...config,
    steps: { REVIEW: { kind: 'review', title: 'Review the repair', outcomes: ['request-changes', 'approve'] } },
  }), {
    send(message) {
      frames.push(message)
      if (message.method === 'item/tool/call') queueMicrotask(() => worker.answer({ id: message.id,
        result: { success: true, contentItems: [{ type: 'inputText', text: message.params.tool === 'review_candidates' ? 'candidate-one — at abc123' : 'Recorded' }] },
      }))
    },
    notify(method, params) { notifications.push({ method, params }) },
  })
  const tools = ['claim_work', 'review_candidates', 'record_review', 'complete_claim'].map(name => ({ name }))
  const play = (run = 'run-one', card = 1) => worker.play({ threadId: 'thread-one', turnId: `turn-${run}-${card}`, cwd, tools,
    prompt: `Flow run ${run}.\nCard #${card} on this Goal is yours: Review the repair\nREVIEW`,
  })
  const verdicts = () => frames.filter(frame => frame.params?.tool === 'record_review').map(frame => frame.params.arguments.verdict)
  return { worker, cwd, state, approvalLog, frames, notifications, play, verdicts }
}

test('passPerRun gives each Flow its own failed review then approved repair', async t => {
  const rig = setup(t, { passPerRun: true })
  await rig.play('run-one', 1)
  await rig.play('run-one', 2)
  await rig.play('run-two', 1)
  await rig.play('run-two', 2)
  assert.deepEqual(rig.verdicts(), ['request-changes', 'approve', 'request-changes', 'approve'])
})

test('the default pass counter remains shared by marker across Flow runs', async t => {
  const rig = setup(t)
  await rig.play('run-one', 1)
  await rig.play('run-two', 1)
  assert.deepEqual(rig.verdicts(), ['request-changes', 'approve'])
  assert.equal(JSON.parse(readFileSync(rig.state, 'utf8')).passes.REVIEW, 2)
})

test('approvalBeforeWork waits after claim and interruption unwinds without answering', { timeout: 2000 }, async t => {
  const rig = setup(t, { approvalBeforeWork: true })
  const playing = rig.play()
  await tick()
  const request = rig.frames.find(frame => frame.method === 'item/commandExecution/requestApproval')
  assert.ok(request, 'a real worker command approval request must be emitted')
  assert.deepEqual(request.params, {
    threadId: 'thread-one', turnId: 'turn-run-one-1', itemId: request.params.itemId,
    startedAtMs: request.params.startedAtMs, reason: 'The worker needs permission before continuing the approved work.',
    command: 'node -e process.exit(0)', cwd: rig.cwd,
    commandActions: [{ type: 'unknown', command: 'node -e process.exit(0)' }],
    availableDecisions: ['accept', 'acceptForSession', 'decline'],
  })
  assert.deepEqual(rig.frames.filter(frame => frame.method === 'item/tool/call').map(frame => frame.params.tool), ['claim_work'])
  assert.equal(rig.notifications.some(frame => frame.method === 'turn/completed'), false)
  rig.worker.interrupt('thread-one')
  await playing
  assert.equal(rig.notifications.find(frame => frame.method === 'turn/completed').params.turn.status, 'interrupted')
  assert.equal(existsSync(rig.approvalLog), false, 'no approval answer frame was received')
  assert.deepEqual(rig.verdicts(), [])
  assert.deepEqual(rig.frames.filter(frame => frame.method === 'item/tool/call').map(frame => frame.params.tool), ['claim_work'])
})

test('an intentional approval answer is recorded and releases work, proving the negative instrument', { timeout: 2000 }, async t => {
  const rig = setup(t, { approvalBeforeWork: true })
  const playing = rig.play()
  await tick()
  const request = rig.frames.find(frame => frame.method === 'item/commandExecution/requestApproval')
  assert.ok(request, 'a real worker command approval request must be emitted')
  const answer = { id: request.id, result: { decision: 'accept' } }
  assert.equal(rig.worker.answer(answer), true)
  await playing
  // Retried frames are observable even after the first answer released work.
  assert.equal(rig.worker.answer(answer), true)
  assert.deepEqual(readFileSync(rig.approvalLog, 'utf8').trim().split('\n').map(line => JSON.parse(line)), [
    { method: 'worker-approval-answer', ...answer }, { method: 'worker-approval-answer', ...answer },
  ])
  assert.deepEqual(rig.verdicts(), ['request-changes'])
  assert.equal(rig.notifications.find(frame => frame.method === 'turn/completed').params.turn.status, 'completed')
})

test('declining a worker approval is logged and cannot continue the claim', { timeout: 2000 }, async t => {
  const rig = setup(t, { approvalBeforeWork: true })
  const playing = rig.play()
  await tick()
  const request = rig.frames.find(frame => frame.method === 'item/commandExecution/requestApproval')
  assert.ok(request)
  const answer = { id: request.id, result: { decision: 'decline' } }
  assert.equal(rig.worker.answer(answer), true)
  await playing
  assert.deepEqual(JSON.parse(readFileSync(rig.approvalLog, 'utf8')), { method: 'worker-approval-answer', ...answer })
  assert.deepEqual(rig.frames.filter(frame => frame.method === 'item/tool/call').map(frame => frame.params.tool), ['claim_work'])
  assert.equal(rig.notifications.find(frame => frame.method === 'turn/completed').params.turn.status, 'failed')
})
