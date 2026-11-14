import type { HarnessContext, HarnessPlugin } from '@harnessdesk/cordis-host'

/**
 * Asking another agent: one question, one answer, read-only.
 *
 * A Flow seat whose role says `ask:` may put one question to another agent
 * the role names. The desk opens that agent in a hidden, ephemeral
 * conversation in the caller's checkout, holds it at the read ceiling, takes
 * its one answer and discards it. Everything that decides — whether the
 * caller may ask, whom, how often, within what time and money, and at what
 * ceiling — is the host's consult engine; this plugin is the doorway, with
 * `agents.invoke` and nothing else.
 *
 * The answer is the other agent's words, and untrusted: it reaches the caller
 * only as this tool's result, and the transcript renders it as text.
 */

const ASK_BYTES = 16384

interface AskArgs {
  readonly agent?: unknown
  readonly question?: unknown
  readonly context?: unknown
}

export const consultPlugin: HarnessPlugin = {
  manifest: {
    id: 'consult',
    name: 'Ask another agent',
    description:
      'Lets a Flow seat whose role allows it ask another agent one read-only question. The asked agent reads the checkout, changes nothing, asks no one else and answers once.',
    permissions: { agents: { invoke: true } },
  },
  plugin: {
    name: 'consult',
    inject: ['tools', 'agents'],
    apply(ctx: HarnessContext) {
      ctx.tools.register({
        name: 'ask_agent',
        title: 'Ask another agent',
        description:
          'Ask another agent one question and get its answer. It reads your checkout but cannot change anything, cannot ask anyone else, and answers once. Use it for a second opinion or knowledge another agent has; not to hand off work.',
        inputSchema: {
          type: 'object',
          additionalProperties: false,
          required: ['agent', 'question'],
          properties: {
            agent: {
              type: 'string', minLength: 1, maxLength: 64,
              description: 'Which agent to ask: one of the ids this conversation is allowed to ask (listed in the error when wrong).',
            },
            question: { type: 'string', minLength: 1, maxLength: ASK_BYTES },
            context: {
              type: 'string', maxLength: ASK_BYTES,
              description: 'Anything the other agent needs that is not in the checkout.',
            },
          },
        },
        execute: async (args: unknown, scope) => {
          const asked = (args ?? {}) as AskArgs
          const answer = await ctx.agents.ask({
            agent: typeof asked.agent === 'string' ? asked.agent : '',
            question: typeof asked.question === 'string' ? asked.question : '',
            context: typeof asked.context === 'string' ? asked.context : null,
          }, scope)
          return { ok: true, content: [{ type: 'text', text: answer.text }] }
        },
      })
    },
  },
}
