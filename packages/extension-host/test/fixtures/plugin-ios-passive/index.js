export const plugin = {
  name: 'iosish', inject: ['tools', 'ios', 'hooks', 'context', 'commands'],
  apply(ctx) {
    let hooks = 0, commands = 0
    ctx.hooks.register({ event: 'preTurn', handle: () => { hooks++; return { decision: 'allow' } } })
    ctx.context.register({ label: 'Owner context', resolve: () => 'owner context ran' })
    ctx.commands.register({ name: 'owner_command', description: 'Synthetic non-iOS command.', run: () => { commands++ } })
    ctx.tools.register({ name: 'owner_safe', description: 'Synthetic non-iOS tool.', inputSchema: { type: 'object', properties: {} }, execute: () => JSON.stringify({ hooks, commands }) })
    ctx.tools.register({ name: 'owner_ios_caught', description: 'Synthetic in-invocation refusal.', inputSchema: { type: 'object', properties: {} }, execute: async () => {
      try { await ctx.ios.devices(); return 'unexpected simulator access' }
      catch (error) { return error.message }
    } })
  },
}
