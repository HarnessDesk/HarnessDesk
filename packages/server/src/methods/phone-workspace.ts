import { sessionMethods } from './sessions.js'
import type { HostMethodTable } from './context.js'

/**
 * What a paired phone asks for under the `workspace/` names it ships with: the snapshot of the work, one
 * conversation, session controls, approval answers and wrapping a Team the person accepted. They share a prefix with the window's folder and file
 * methods (`methods/workspace.ts`) by name only; the phone's projection and action adapters live in `phone-work.ts`.
 */
export const phoneWorkspaceMethods = {
  'workspace/read': ctx => ctx.phoneWork.snapshot(),
  'workspace/sessions/list': (ctx, params) => ctx.phoneWork.sessionsList(params),
  // Current model membership is checked by PhoneWork before allocation and returns a phone problem.
  'workspace/session/start': (ctx, params) => ctx.phoneWork.sessionStart(params),
  'workspace/session/send': (ctx, params) => ctx.phoneWork.sessionSend(params),
  'workspace/session/rename': (ctx, params) => sessionMethods['session/setTitle'](ctx, { ...ctx.phoneWork.sessionAddress(params.id), title: params.title }),
  'workspace/session/archive': (ctx, params) => sessionMethods['session/archive'](ctx, { ...ctx.phoneWork.sessionAddress(params.id), archived: params.archived }),
  'workspace/session/pin': (ctx, params) => sessionMethods['session/pin'](ctx, { ...ctx.phoneWork.sessionAddress(params.id), pinned: params.pinned }),
  'workspace/session/delete': (ctx, params) => sessionMethods['session/delete'](ctx, ctx.phoneWork.sessionAddress(params.id)),
  'workspace/stop': (ctx, params) => ctx.phoneWork.stop(params),
  'workspace/thread/read': (ctx, params) => ctx.phoneWork.threadRead(params),
  'workspace/approval/decide': (ctx, params) => ctx.phoneWork.approvalDecide(params),
  'workspace/team/wrap': (ctx, params) => ctx.phoneWork.teamWrap(params),
} satisfies Pick<HostMethodTable, 'workspace/read' | 'workspace/sessions/list' | 'workspace/session/start' | 'workspace/session/send' | 'workspace/session/rename' | 'workspace/session/archive' | 'workspace/session/pin' | 'workspace/session/delete' | 'workspace/stop' | 'workspace/thread/read' | 'workspace/approval/decide' | 'workspace/team/wrap'>
