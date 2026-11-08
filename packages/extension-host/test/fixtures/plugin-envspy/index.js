/**
 * Reports what its process was started with, and the config it was applied
 * with, so a test can see what reached a plugin's process and what survives
 * a restart of it.
 */
export const plugin = {
  name: 'envspy',
  inject: ['tools'],
  apply(ctx, config) {
    ctx.tools.register({
      name: 'spy',
      description: 'Answers with the process and config it sees.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => JSON.stringify({
        secret: process.env.HD_TEST_PARENT_SECRET ?? null,
        nodeOptions: process.env.NODE_OPTIONS ?? null,
        pid: process.pid,
        greeting: config?.greeting ?? null,
      }),
    })
    ctx.tools.register({
      name: 'spy_exit',
      description: 'Ends its own process.',
      inputSchema: { type: 'object', properties: {} },
      execute: () => process.exit(3),
    })
  },
}
