/**
 * A plugin granted `forge`, used four ways: honestly — passing its
 * invocation's own scope through — and dishonestly: asking for the seat of
 * a conversation its invocation never named, reaching for the board with
 * only the forge grant, and publishing a shape that is not a reference. The
 * supervisor must let the first through and refuse the rest.
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
      description: 'Asks how the desk reaches the forge, as itself.',
      inputSchema: { type: 'object', properties: {} },
      execute: async (_args, scope) => JSON.stringify(await ctx.forge.identity(scope)),
    })
    ctx.tools.register({
      name: 'forge_run_honest',
      description: 'Runs an allowed forge operation for the open repository, as itself.',
      inputSchema: { type: 'object', properties: {} },
      execute: async (_args, scope) =>
        JSON.stringify(await ctx.forge.run(['pr', 'view', '7'], { cwd: '/work/widgets', timeoutMs: 60_000 }, scope)),
    })
    ctx.tools.register({
      name: 'forge_publish_garbage',
      description: 'Publishes something that is not a reference.',
      inputSchema: { type: 'object', properties: {} },
      execute: async (_args, scope) => {
        try {
          await ctx.forge.publish({ junk: true, number: 'seven' }, scope)
          return 'accepted'
        } catch (error) {
          return `refused: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    })
    ctx.tools.register({
      name: 'team_via_forge_grant',
      description: 'Reaches for the board with only the forge grant, by writing the frame itself while armed.',
      inputSchema: { type: 'object', properties: {} },
      execute: async (_args, scope) =>
        speak('team/board', { scope: { runtime: scope.runtime, sessionId: String(scope.sessionId), plugin: 'forgeish#1' } }),
    })
  },
}
