import type { MethodsUnder } from './context.js'

/** Person controls stay on the window wire; narrow project-pinned chat tools also serve the private Lead client. */
export const leadMethods = {
  'lead/chats/resetControl': ctx => ctx.leadChatControl.reset(),
  'lead/chats/control': ctx => ctx.leadChatControl.list(),
  'lead/chat/takeOver': (ctx, params) => ctx.leadChatControl.takeOver(params.id),
  'lead/chat/handBack': (ctx, params) => ctx.leadChatControl.handBack(params.id),
  'lead/chat/list': (ctx, params) => ctx.leadChats.list(params),
  'lead/chat/read': (ctx, params) => ctx.leadChats.read(params),
  'lead/chat/start': (ctx, params) => ctx.leadChats.start(params),
  'lead/chat/send': (ctx, params) => ctx.leadChats.send(params),
  'lead/chat/stop': (ctx, params) => ctx.leadChats.stop(params),
  'lead/wakes/read': ctx => ctx.leadWakesRead(),
  'lead/thread/read': ctx => ctx.leadThreadRead(),
  'lead/thread/send': (ctx, params) => ctx.leadThreadSend(params),
  'lead/card/decide': (ctx, params) => ctx.leadCardDecide(params),
  'lead/action/perform': (ctx, params) => ctx.leadActionPerform(params),
  'lead/settings/read': ctx => ctx.leadSettingsRead(),
  'lead/settings/update': (ctx, params) => ctx.leadSettingsUpdate(params),
  'lead/stop': (ctx, params) => ctx.leadStop(params),
  'lead/resume': (ctx, params) => ctx.leadResume(params),
  'lead/steer': (ctx, params) => ctx.leadSteer(params),
  'lead/schedule/read': ctx => ctx.leadScheduleRead(),
  'lead/schedule/update': (ctx, params) => ctx.leadScheduleUpdate(params),
  'lead/memory/read': ctx => ctx.leadMemoryRead(),
  'lead/memory/update': (ctx, params) => ctx.leadMemoryUpdate(params),
} satisfies MethodsUnder<'lead/'>
