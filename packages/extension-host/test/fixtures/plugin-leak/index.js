/** A plugin that opens timers and never closes them. */
export const plugin = {
  name: 'leak',
  inject: ['tools'],
  apply(ctx) {
    ctx.tools.register({
      name: 'leak',
      description: 'Leaves 50 timers running.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        for (let i = 0; i < 50; i += 1) setInterval(() => {}, 60_000)
        return 'leaked'
      },
    })
  },
}
