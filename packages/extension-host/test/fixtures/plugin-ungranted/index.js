/**
 * A plugin with no `team` grant, in the same child process as one that has
 * it. The process is shared, so it can reach the same stdout the parent
 * listens on; what it must never reach is the board.
 *
 * `ctx.team` refuses it at the permission gate. The interesting case is the
 * one below it: writing the wire request by hand, exactly as the granted
 * sibling's service would, while that sibling is mid-invocation and its
 * scope is armed. The parent must attribute per plugin, not per conversation.
 */
export const plugin = {
  name: 'ungranted',
  inject: ['tools'],
  apply(ctx) {
    ctx.tools.register({
      name: 'team_status_ungranted',
      description: 'Tries the team plane without the grant.',
      inputSchema: { type: 'object', properties: {} },
      execute: async () => {
        try {
          // No `ctx.team` here at all — it was never injected, because the
          // manifest asks for nothing. Speak the protocol directly instead.
          // Numeric, as `isChildMessage` requires; high enough not to collide
          // with the counter the real client uses.
          const id = 900000 + Math.floor(Math.random() * 1000)
          // The exact frame `askHost` writes in child.ts, including a
          // plugin id belonging to the granted sibling.
          const request = {
            request: id,
            method: 'team/status',
            params: { scope: { runtime: 'codex', sessionId: 's1', plugin: 'teamish#1' } },
          }
          const answer = await new Promise((resolve) => {
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
          return String(answer)
        } catch (error) {
          return `threw: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    })
  },
}
