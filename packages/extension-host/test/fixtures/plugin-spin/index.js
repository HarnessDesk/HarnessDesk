/** A plugin that wedges the event loop, so nothing else can be served. */
export const plugin = {
  name: 'spin',
  inject: ['tools'],
  apply(ctx) {
    ctx.tools.register({
      name: 'spin',
      description: 'Never returns.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => {
        for (;;) {
          /* burn */
        }
      },
    })
  },
}
