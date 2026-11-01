import type { DispatchAdmission } from '../dispatch-admission.js'
import { recordDeskInput, approvalId as makeApprovalId, sessionId as makeSessionId } from '@harnessdesk/protocol'

import type { AgentSession, HostParams, HostResult } from '@harnessdesk/protocol'
import type { HostContext, MethodsUnder } from './context.js'

/** Host callers may scope the actual handle after dispatch reopens it. */
export async function sendTurn(ctx: HostContext, params: HostParams<'turn/send'>,
  admitLive?: DispatchAdmission<AgentSession>, person = false): Promise<HostResult<'turn/send'>> {
  const record = ctx.sessions.record(params)
  const personSeat = person ? ctx.queue.retiredPersonSeat(record) : null
  const turnId = await ctx.sessions.dispatch(params, live => {
    if (ctx.sessions.record(params) !== record) throw new Error('The conversation changed before its message could be sent.')
    return ctx.queue.sendNow(record, recordDeskInput(params.input), live, undefined, admitLive, personSeat)
  })
  return { turnId: String(turnId) }
}

/** Shared ordinary queue dispatch. Only host callers can supply the effect receipt. */
export async function queueTurn(ctx: HostContext, params: HostParams<'turn/queue'>, effectStarted?: () => void,
  admitLive?: DispatchAdmission<AgentSession>, person = false): Promise<HostResult<'turn/queue'>> {
  ctx.sessions.assertDispatchable(params)
  const record = ctx.sessions.record(params)
  const personSeat = person ? ctx.queue.retiredPersonSeat(record) : null
  if (admitLive && record.live) {
    await admitLive(record.live)
    ctx.sessions.assertDispatchable(params)
    if (ctx.sessions.record(params) !== record) throw new Error('The conversation changed before its message could be queued.')
  }
  // Nothing to wait for: send it. A queue on an idle conversation would
  // sit until some future turn ended, which is not what "send" means.
  // `busy` counts a send still on its way to the agent, so two messages
  // typed in the same breath cannot both go straight out — the second
  // waits behind the first, which is what the person meant by typing it.
  if (!ctx.queue.busy(record) && record.queue.messages.length === 0) {
    await ctx.queue.sendNow(record, recordDeskInput(params.input), undefined, effectStarted, admitLive, personSeat)
    return { queuedId: null, sent: true }
  }
  admitLive?.assertDispatch?.()
  const message = ctx.registry.enqueue(record, ctx.queue.nextId(), recordDeskInput(params.input), effectStarted, admitLive, personSeat ?? undefined)
  ctx.queue.push(record)
  return { queuedId: message.id, sent: false }
}

/**
 * What happens inside a conversation: turns, the message queue that waits for
 * one to end, the agent's background tasks, and the answer to an approval.
 */
export const turnMethods = {
  'turn/send': (ctx, params) => sendTurn(ctx, params, undefined, true),

  'turn/steer': async (ctx, params) => {
    await ctx.sessions.dispatch(params, live => live.steer(recordDeskInput(params.input)))
    return null
  },

  'turn/interrupt': async (ctx, params) => {
    await (await ctx.sessions.live(params)).interrupt()
    return null
  },

  'turn/queue': (ctx, params) => queueTurn(ctx, params, undefined, undefined, true),

  'turn/queue/cancel': (ctx, params) => {
    const record = ctx.sessions.record(params)
    ctx.registry.cancelQueued(record, params.id)
    ctx.queue.push(record)
    return null
  },

  'turn/queue/update': (ctx, params) => {
    const record = ctx.sessions.record(params)
    ctx.queue.update(record, params.id, recordDeskInput(params.input))
    return null
  },

  'turn/queue/move': (ctx, params) => {
    const record = ctx.sessions.record(params)
    ctx.registry.moveQueued(record, params.id, params.to)
    ctx.queue.push(record)
    return null
  },

  'turn/queue/flush': async (ctx, params) => {
    ctx.sessions.assertDispatchable(params)
    const record = ctx.sessions.record(params)
    if (ctx.queue.busy(record)) {
      throw new Error('A turn is still running. Stop it first, or add to it instead.')
    }
    ctx.registry.resumeQueue(record)
    ctx.queue.push(record)
    await ctx.queue.drain(record)
    return null
  },

  'turn/queue/clear': (ctx, params) => {
    const record = ctx.sessions.record(params)
    ctx.registry.clearQueue(record)
    ctx.queue.push(record)
    return null
  },

  /**
   * What the agent has running in the background.
   *
   * The runtime is asked rather than the record read: a pane opening on a
   * conversation is exactly the moment the held copy is most likely to be
   * empty, because nothing has happened since this host started. What
   * comes back is held, so a reload does not have to ask again.
   */
  'tasks/list': async (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    if (!runtime.tasks) return []
    const tasks = await runtime.tasks.list(makeSessionId(params.sessionId))
    const record = ctx.registry.get(params.runtime, makeSessionId(params.sessionId))
    if (record) record.tasks = tasks
    return tasks
  },

  'tasks/stop': async (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    if (!runtime.tasks) return { stopped: false }
    const stopped = await runtime.tasks.stop(makeSessionId(params.sessionId), params.taskId)
    // Killing something the agent started is worth a line: the agent will
    // find the task gone and has no way to know a person did it.
    ctx.logger.info('a background task was stopped from the interface', {
      runtime: params.runtime,
      session: params.sessionId,
      task: params.taskId,
      stopped,
    })
    return { stopped }
  },

  /**
   * Drops the finished rows. Running work is never touched: this is the
   * panel's "Clear", and a button that quietly killed live jobs would be
   * the worst kind of surprise. The host forgets its own copy whether or
   * not the runtime can forget its one.
   */
  'tasks/clear': async (ctx, params) => {
    const runtime = ctx.runtimes.resolve(params)
    await runtime.tasks?.clear?.(makeSessionId(params.sessionId)).catch(() => undefined)
    const record = ctx.registry.get(params.runtime, makeSessionId(params.sessionId))
    if (record) {
      record.tasks = record.tasks.filter((task) => task.state === 'running')
      ctx.push({
        method: 'event',
        params: {
          runtime: params.runtime,
          event: { type: 'session/tasks', sessionId: record.session.id, tasks: record.tasks },
        },
      })
    }
    return null
  },

  'approval/respond': async (ctx, params) => {
    // These host paths may settle an approval themselves. They mark entry into
    // delivery, so only a failure before that boundary proves nothing was sent.
    let delivering = false
    const delivery = () => { delivering = true }
    try {
      if (ctx.ceilings.answerHeld(params.runtime, params.sessionId, params.approvalId, params.decision, delivery)) return null
      if (await ctx.questions.answerStopped(params.runtime, params.sessionId, params.approvalId, params.decision, delivery)) return null
    } catch (error) {
      if (!delivering) throw Object.assign(error instanceof Error ? error : new Error('Approval preflight failed.'), { approvalNotDelivered: true })
      throw error
    }
    const sessionId = makeSessionId(params.sessionId), approvalId = makeApprovalId(params.approvalId)
    const assertPending = (): void => {
      if (!ctx.registry.hasApproval(params.runtime, sessionId, approvalId)) {
        throw new Error(`No approval is pending with id ${params.approvalId}`)
      }
    }
    // Stop can settle the host's copy even when the agent keeps its request.
    const live = await (async () => {
      try {
        assertPending()
        const live = await ctx.sessions.live(params)
        // Reopening may have overlapped the settlement; never send a stale decision.
        assertPending()
        return live
      } catch (error) {
        // Host-only receipt: the runtime responder was never called. A responder
        // rejection below cannot make this guarantee and must remain uncertain.
        throw Object.assign(error instanceof Error ? error : new Error('Approval preflight failed.'), { approvalNotDelivered: true })
      }
    })()
    await live.respondToApproval(approvalId, params.decision)
    return null
  },
} satisfies MethodsUnder<'turn/' | 'tasks/' | 'approval/'>
