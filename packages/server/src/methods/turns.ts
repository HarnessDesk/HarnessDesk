import { approvalId as makeApprovalId, sessionId as makeSessionId } from '@harnessdesk/protocol'

import type { MethodsUnder } from './context.js'

/**
 * What happens inside a conversation: turns, the message queue that waits for
 * one to end, the agent's background tasks, and the answer to an approval.
 */
export const turnMethods = {
  'turn/send': async (ctx, params) => {
    const live = await ctx.sessions.live(params)
    const turnId = await ctx.sessions.sendAttributed(params, live, params.input)
    return { turnId: String(turnId) }
  },

  'turn/steer': async (ctx, params) => {
    await (await ctx.sessions.live(params)).steer(params.input)
    return null
  },

  'turn/interrupt': async (ctx, params) => {
    await (await ctx.sessions.live(params)).interrupt()
    return null
  },

  'turn/queue': async (ctx, params) => {
    const record = ctx.sessions.record(params)
    // Nothing to wait for: send it. A queue on an idle conversation would
    // sit until some future turn ended, which is not what "send" means.
    // `busy` counts a send still on its way to the agent, so two messages
    // typed in the same breath cannot both go straight out — the second
    // waits behind the first, which is what the person meant by typing it.
    if (!ctx.queue.busy(record) && record.queue.messages.length === 0) {
      await ctx.queue.sendNow(record, params.input)
      return { queuedId: null, sent: true }
    }
    const message = ctx.registry.enqueue(record, ctx.queue.nextId(), params.input)
    ctx.queue.push(record)
    return { queuedId: message.id, sent: false }
  },

  'turn/queue/cancel': (ctx, params) => {
    const record = ctx.sessions.record(params)
    ctx.registry.cancelQueued(record, params.id)
    ctx.queue.push(record)
    return null
  },

  'turn/queue/move': (ctx, params) => {
    const record = ctx.sessions.record(params)
    ctx.registry.moveQueued(record, params.id, params.to)
    ctx.queue.push(record)
    return null
  },

  'turn/queue/flush': async (ctx, params) => {
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
    await (await ctx.sessions.live(params)).respondToApproval(makeApprovalId(params.approvalId), params.decision)
    return null
  },
} satisfies MethodsUnder<'turn/' | 'tasks/' | 'approval/'>
