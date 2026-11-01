import { appendFileSync, existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

// The adapter sends desk context and the card order as separate text parts.
// Keep that boundary so a first-line card order remains a first line.
export const scriptedFlowPrompt = input => (input ?? [])
  .filter(part => part.type === 'text')
  .map(part => part.text)
  .join('\n\n')
  .trim()

/** Camera-only turns still use the real host tools and their evidence gates. */
export function scriptedFlow(raw, { send, notify }) {
  if (!raw) return null
  const script = JSON.parse(raw)
  if (typeof script.state !== 'string' || !script.steps || !Object.keys(script.steps).length) {
    throw new Error('FAKE_CODEX_FLOW needs a state file and scripted steps')
  }
  for (const step of Object.values(script.steps)) {
    if (!['write', 'review'].includes(step.kind) || !Array.isArray(step.outcomes) || !step.outcomes.length ||
        step.outcomes.some((one) => typeof one !== 'string' || !one) ||
        (step.kind === 'write' && (typeof step.file !== 'string' || !/^[\w-][\w.-]*$/.test(step.file.replaceAll('{{intent}}', '1'))))) {
      throw new Error('Invalid FAKE_CODEX_FLOW step')
    }
  }
  const pending = new Map()
  const approvalRequests = new Set()
  const active = new Set()
  const turns = new Map()
  let sequence = 0
  const call = (tools, threadId, turnId, name, args) => {
    const tool = tools.find((one) => one.name === name)
    if (!tool) throw new Error(`The seated thread has no ${name} tool`)
    const id = `rig-tool-${++sequence}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${name} timed out`)) }, 10000)
      pending.set(id, { resolve, reject, timer, name })
      send({ id, method: 'item/tool/call', params: {
        threadId, turnId, callId: id, namespace: tool.namespace ?? null, tool: name, arguments: args,
      } })
    })
  }
  const requestApproval = async (threadId, turnId, cwd, signal) => {
    signal.throwIfAborted()
    const id = `rig-approval-${++sequence}`, itemId = `rig-command-${sequence}`, startedAtMs = Date.now()
    const command = script.approvalCommand ?? 'node -e process.exit(0)'
    const commandActions = [{ type: 'unknown', command }]
    const item = { type: 'commandExecution', id: itemId, command, cwd, processId: null, source: 'agent', status: 'inProgress',
      commandActions, aggregatedOutput: null, exitCode: null, durationMs: null }
    notify('item/started', { threadId, turnId, item, startedAtMs })
    await new Promise((resolve, reject) => {
      const abort = () => { pending.delete(id); reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      pending.set(id, { kind: 'approval', resolve, reject, cleanup: () => signal.removeEventListener('abort', abort) })
      approvalRequests.add(id)
      send({ id, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId, startedAtMs,
        reason: 'The worker needs permission before continuing the approved work.', command, cwd, commandActions,
        availableDecisions: ['accept', 'acceptForSession', 'decline'] } })
    })
    signal.throwIfAborted()
    notify('item/completed', { threadId, turnId, item: { ...item, status: 'completed', aggregatedOutput: '', exitCode: 0, durationMs: Date.now() - startedAtMs }, completedAtMs: Date.now() })
  }
  return {
    interrupt(threadId) { turns.get(threadId)?.abort() },
    answer(message) {
      const approval = approvalRequests.has(message.id)
      if (approval && script.approvalLog) appendFileSync(script.approvalLog, `${JSON.stringify({ method: 'worker-approval-answer', ...message })}\n`)
      const waiter = pending.get(message.id)
      if (!waiter) return approval
      pending.delete(message.id)
      if (waiter.kind === 'approval') {
        waiter.cleanup()
        if (message.error || !['accept', 'acceptForSession'].includes(message.result?.decision)) waiter.reject(new Error('The worker command approval was declined'))
        else waiter.resolve()
        return true
      }
      clearTimeout(waiter.timer)
      const text = (message.result?.contentItems ?? []).filter((one) => one.type === 'inputText').map((one) => one.text).join('\n')
      if (message.error || !message.result?.success || /^(Refused:|Nothing to commit|There is nothing to review)/.test(text)) {
        waiter.reject(new Error(`${waiter.name}: ${message.error?.message ?? text}`))
      } else waiter.resolve(text)
      return true
    },
    async play({ threadId, turnId, cwd, tools, prompt }) {
      const controller = new AbortController()
      turns.set(threadId, controller)
      const check = () => controller.signal.throwIfAborted()
      const card = /^Card #(\d+) on this (?:Goal|Team) is yours: (.*)$/m.exec(prompt)
      const entry = Object.entries(script.steps).find(([marker, step]) => prompt.split('\n').includes(marker) || step.title === card?.[2])
      notify('turn/started', { threadId, turn: { id: turnId, items: [], status: 'inProgress', error: null } })
      let error = null
      try {
        // A Seat's standing brief arrives before it is bound to a card. Finish
        // that turn with an acknowledgement; only the later card order may do work.
        if (!card || !entry) {
          const item = { id: `rig-standing-${turnId}`, type: 'agentMessage', text: 'Ready for the next card.' }
          notify('item/started', { threadId, turnId, item })
          notify('item/completed', { threadId, turnId, item })
        }
        if (card && entry) {
          const intent = Number(card[1])
          const [marker, step] = entry
          const run = /Flow run ([^.]+)\./.exec(prompt)?.[1]
          if (!run) throw new Error('The card order has no Flow run')
          const key = `${run}:${intent}`
          if (active.has(key)) throw new Error('The scripted card is already running')
          const stored = existsSync(script.state) ? JSON.parse(readFileSync(script.state, 'utf8')) : { passes: {}, done: [] }
          if (!stored.done.includes(key)) {
            active.add(key)
            try {
              const passKey = script.passPerRun === true ? JSON.stringify([run, marker]) : marker
              const pass = stored.passes[passKey] ?? 0
              const outcome = step.outcomes[Math.min(pass, step.outcomes.length - 1)]
              const file = step.file?.replaceAll('{{intent}}', String(intent))
              await call(tools, threadId, turnId, 'claim_work', { intent, files: step.kind === 'write' ? [file] : [] })
              check()
              if (script.approvalBeforeWork === true) await requestApproval(threadId, turnId, cwd, controller.signal)
              check()
              if (script.delayMs) await delay(script.delayMs, undefined, { signal: controller.signal })
              if (script.gates) {
                const until = Date.now() + 90000
                while (!existsSync(join(script.gates, marker))) {
                  if (Date.now() > until) throw new Error(`The scripted ${marker} camera gate was not released`)
                  await delay(50, undefined, { signal: controller.signal })
                }
              }
              check()
              if (step.kind === 'write') {
                if (step.publish && execFileSync('git', ['branch', '--show-current'], { cwd, encoding: 'utf8' }).trim() !== `rig-write-review-${intent}`) {
                  throw new Error('The scripted publisher needs its preselected local feature branch')
                }
                const path = join(cwd, file)
                if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('The scripted file is a symlink')
                writeFileSync(path, step.contents?.replaceAll('{{intent}}', String(intent)) ?? `Retryable statuses: ${pass === 0 ? '503, 504' : '502, 503, 504'}\n`)
                await call(tools, threadId, turnId, 'commit_work', { intent, message: 'rig: record the scripted retry change' })
                check()
                if (step.publish) {
                  execFileSync('git', ['push', '-u', 'origin', 'HEAD'], { cwd, stdio: 'pipe' })
                  await call(tools, threadId, turnId, 'pr_create', { title: 'Repair checkout retry', body: 'Handle retryable checkout responses.' })
                  check()
                }
              } else {
                const candidates = await call(tools, threadId, turnId, 'review_candidates', { intent })
                check()
                const candidate = /^(\S+) — at [0-9a-f]+/m.exec(candidates)?.[1]
                if (!candidate) throw new Error(`No observed review candidate: ${candidates}`)
                await call(tools, threadId, turnId, 'record_review', { intent, candidate, verdict: outcome })
                check()
              }
              await call(tools, threadId, turnId, 'complete_claim', {
                intent, outcome, note: step.note ?? `Scripted ${outcome}.`,
                context: step.context ?? (outcome === 'request-changes' ? 'Add 502 to the committed retry status list.' : 'The committed retry status list is ready for the next step.'),
              })
              // Read again: sibling threads can finish while this one awaited
              // its tools. Never overwrite another card's completion or pass.
              const latest = existsSync(script.state) ? JSON.parse(readFileSync(script.state, 'utf8')) : { passes: {}, done: [] }
              latest.passes[passKey] = pass + 1
              latest.done.push(key)
              // Other fake processes read this file while completing sibling
              // attempts. Publish the whole snapshot, never a truncated JSON.
              const temporary = `${script.state}.${process.pid}.tmp`
              writeFileSync(temporary, `${JSON.stringify(latest)}\n`)
              renameSync(temporary, script.state)
              const item = { id: `rig-answer-${intent}`, type: 'agentMessage', text: `Verdict: ${outcome}` }
              notify('item/started', { threadId, turnId, item })
              notify('item/completed', { threadId, turnId, item })
            } finally { active.delete(key) }
          }
        }
      } catch (cause) { if (!controller.signal.aborted) error = { message: cause.message } }
      if (turns.get(threadId) === controller) turns.delete(threadId)
      notify('turn/completed', { threadId, turn: { id: turnId, items: [], status: controller.signal.aborted ? 'interrupted' : error ? 'failed' : 'completed', error } })
      notify('thread/status/changed', { threadId, status: { type: 'idle' } })
    },
  }
}
