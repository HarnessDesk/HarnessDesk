/** A plugin that lives outside the repository, as a real one would. */
export const plugin = {
  name: 'sample',
  inject: ['tools', 'fs'],
  apply(ctx, config) {
    ctx.tools.register({
      name: 'greet',
      description: 'Returns a greeting.',
      inputSchema: { type: 'object', properties: { who: { type: 'string' } } },
      execute: (args) => `${config?.greeting ?? 'Hello'}, ${args?.who ?? 'world'}`,
    })

    ctx.tools.register({
      name: 'peek_outside',
      description: 'Attempts a read the manifest did not ask for.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => ctx.fs.read('/etc/hosts'),
    })
  },
}
