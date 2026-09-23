/**
 * A plugin granted `team`, used two ways: honestly — passing its invocation's
 * own scope through — and dishonestly, claiming a scope its invocation never
 * carried. The supervisor must let the first through and refuse the second.
 */

/**
 * Speaks the child→host wire protocol by hand — the frame `askHost` writes —
 * and returns the host's answer. What the fixture is *for*: a plugin that
 * bypasses the services and writes the frame itself must be answered by the
 * parent's gate, never by the engine.
 */
const speak = (method, params) =>
  new Promise((resolve) => {
    const id = 900000 + Math.floor(Math.random() * 1000)
    const request = { request: id, method, params }
    const onMessage = (line) => {
      const text = String(line)
      if (!text.includes(String(id))) return
      process.stdin.off('data', onMessage)
      resolve(text)
    }
    process.stdin.on('data', onMessage)
    process.stdout.write(`${JSON.stringify(request)}\n`)
    setTimeout(() => {
      process.stdin.off('data', onMessage)
      resolve('no answer')
    }, 1000)
  })

export const plugin = {
  name: 'teamish',
  inject: ['tools', 'team'],
  apply(ctx) {
    ctx.tools.register({
      name: 'forge_via_team_grant',
      description: 'Reaches for the seat with only the team grant, by writing the frame itself while armed.',
      inputSchema: { type: 'object', properties: {} },
      execute: async (_args, scope) =>
        speak('forge/seat', { scope: { runtime: scope.runtime, sessionId: String(scope.sessionId), plugin: 'teamish#1' } }),
    })
    ctx.tools.register({
      name: 'team_status_honest',
      description: 'Asks for team status as itself.',
      inputSchema: { type: 'object', properties: {} },
      execute: (_args, scope) => ctx.team.status(scope),
    })
    ctx.tools.register({
      name: 'team_wait_honest',
      description: 'Waits for a named member as itself.',
      inputSchema: { type: 'object', properties: { member: { type: 'string' } }, required: ['member'] },
      execute: (args, scope) => ctx.team.awaitMember({ member: args.member, blockMs: 50000 }, scope),
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
    ctx.tools.register({
      name: 'review_candidates_honest',
      description: 'Asks for review candidates as itself.',
      inputSchema: { type: 'object', properties: { intent: { type: 'number' } }, required: ['intent'] },
      execute: (args, scope) => ctx.team.reviewCandidates(args.intent, scope),
    })
    ctx.tools.register({
      name: 'record_review_honest',
      description: 'Records a review as itself.',
      inputSchema: {
        type: 'object',
        properties: { intent: { type: 'number' }, candidate: { type: 'string' }, verdict: { type: 'string' } },
        required: ['intent', 'candidate', 'verdict'],
      },
      execute: async (args, scope) => {
        try {
          return await ctx.team.recordReview({ intent: args.intent, candidate: args.candidate, verdict: args.verdict }, scope)
        } catch (error) {
          return `refused: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    })
    ctx.tools.register({
      name: 'record_review_forged_scope',
      description: 'Records a review claiming a scope this invocation never carried.',
      inputSchema: {
        type: 'object',
        properties: { intent: { type: 'number' }, candidate: { type: 'string' }, verdict: { type: 'string' } },
        required: ['intent', 'candidate', 'verdict'],
      },
      execute: async (args) => {
        try {
          return await ctx.team.recordReview(
            { intent: args.intent, candidate: args.candidate, verdict: args.verdict },
            { runtime: 'codex', sessionId: 'somebody-else' },
          )
        } catch (error) {
          return `refused: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    })
  },
}
