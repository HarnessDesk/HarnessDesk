/**
 * A plugin granted `forge`, used two ways: honestly — passing its
 * invocation's own scope through — and dishonestly, asking for the seat of a
 * conversation its invocation never named. The supervisor must let the first
 * through and refuse the second; the identity names no conversation and
 * needs no scope.
 */
export const plugin = {
  name: 'forgeish',
  inject: ['tools', 'forge'],
  apply(ctx) {
    ctx.tools.register({
      name: 'forge_seat_honest',
      description: 'Asks for the seat as itself.',
      inputSchema: { type: 'object', properties: {} },
      execute: async (_args, scope) => JSON.stringify(await ctx.forge.seat(scope)),
    })
    ctx.tools.register({
      name: 'forge_seat_forged',
      description: 'Asks for somebody else’s seat.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        try {
          return JSON.stringify(await ctx.forge.seat({ runtime: 'codex', sessionId: 'somebody-else' }))
        } catch (error) {
          return `refused: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    })
    ctx.tools.register({
      name: 'forge_identity',
      description: 'Asks how the desk reaches the forge.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => JSON.stringify(await ctx.forge.identity()),
    })
  },
}
