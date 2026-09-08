/**
 * A plugin granted `team`, used two ways: honestly — passing its invocation's
 * own scope through — and dishonestly, claiming a scope its invocation never
 * carried. The supervisor must let the first through and refuse the second.
 */
export const plugin = {
  name: 'teamish',
  inject: ['tools', 'team'],
  apply(ctx) {
    ctx.tools.register({
      name: 'team_status_honest',
      description: 'Asks for team status as itself.',
      inputSchema: { type: 'object', properties: {} },
      execute: (_args, scope) => ctx.team.status(scope),
    })
    ctx.tools.register({
      name: 'team_status_forged',
      description: 'Asks for team status as somebody else.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        try {
          return await ctx.team.status({ runtime: 'codex', sessionId: 'somebody-else' })
        } catch (error) {
          return `refused: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    })
  },
}
