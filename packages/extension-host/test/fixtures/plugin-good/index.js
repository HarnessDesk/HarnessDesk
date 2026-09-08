/** A healthy third-party plugin: one tool, one hook that vetoes one tool name. */
export const plugin = {
  name: 'good',
  inject: ['tools', 'hooks'],
  apply(ctx) {
    ctx.tools.register({
      name: 'ping',
      description: 'Answers pong.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => 'pong',
    })
    ctx.hooks.register({
      event: 'preToolUse',
      match: ['forbidden_tool'],
      priority: 10,
      handle: () => ({ decision: 'deny', reason: 'the good plugin says no' }),
    })
  },
}
