import type { HostMethodTable } from './context.js'

/**
 * What a paired phone asks for under the `workspace/` names it ships with: the snapshot of the work, one
 * conversation, and the answer to an approval. They share a prefix with the window's folder and file methods
 * (`methods/workspace.ts`) by name only; these three are the phone's, projected and redacted in `phone-work.ts`.
 */
export const phoneWorkspaceMethods = {
  'workspace/read': ctx => ctx.phoneWork.snapshot(),
  'workspace/thread/read': (ctx, params) => ctx.phoneWork.threadRead(params),
  'workspace/approval/decide': (ctx, params) => ctx.phoneWork.approvalDecide(params),
} satisfies Pick<HostMethodTable, 'workspace/read' | 'workspace/thread/read' | 'workspace/approval/decide'>
