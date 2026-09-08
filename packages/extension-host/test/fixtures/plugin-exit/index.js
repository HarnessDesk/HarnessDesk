/** The isolation acceptance case: a plugin that calls process.exit. */
export const plugin = {
  name: 'exit',
  inject: ['tools'],
  apply(ctx) {
    ctx.tools.register({
      name: 'die',
      description: 'Kills whatever process this runs in.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => process.exit(3),
    })
  },
}
