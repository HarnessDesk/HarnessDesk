import type { HostMethodTable } from './context.js'

/**
 * What a paired phone asks for under the `workspace/` names it ships with: the snapshot of the work, one
 * conversation, session controls and approval answers. They share a prefix with the window's folder and file
 * methods (`methods/workspace.ts`) by name only; the phone's projection and action adapters live in `phone-work.ts`.
 */
export const phoneWorkspaceMethods = {
  'workspace/read': ctx => ctx.phoneWork.snapshot(),
  'workspace/sessions/list': (ctx, params) => ctx.phoneWork.sessionsList(params),
  'workspace/session/start': (ctx, params) => ctx.phoneWork.sessionStart(params),
  'workspace/session/send': (ctx, params) => ctx.phoneWork.sessionSend(params),
  'workspace/stop': (ctx, params) => ctx.phoneWork.stop(params),
  'workspace/thread/read': (ctx, params) => ctx.phoneWork.threadRead(params),
  'workspace/approval/decide': (ctx, params) => ctx.phoneWork.approvalDecide(params),
} satisfies Pick<HostMethodTable, 'workspace/read' | 'workspace/sessions/list' | 'workspace/session/start' | 'workspace/session/send' | 'workspace/stop' | 'workspace/thread/read' | 'workspace/approval/decide'>
