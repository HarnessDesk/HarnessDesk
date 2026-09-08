import type { HarnessContext, HarnessPlugin } from '@harnessdesk/cordis-host'

/**
 * Working together: the shared board and messages between conversations.
 *
 * The state and every decision live in the host's team plane — claiming is a
 * transaction there, message routing applies one set of guards there — and
 * this plugin is the doorway: nine tools, delivered to Codex as dynamic
 * tools and to every ACP agent over the MCP bridge, exactly like any other
 * plugin tool. The projection layer is what makes coordination cross-vendor
 * without asking any vendor for anything.
 *
 * The tool names are swarm-protocol's (docs/multi-agent.md §2b): an agent
 * briefed for that server works here unmodified. The descriptions carry the
 * briefing, because for the agents the descriptions are the documentation —
 * and the only channel that reaches all four vendors identically.
 *
 * Every execute passes its `scope` through: which conversation is calling is
 * the substance of a claim and the safety of a message, and the host refuses
 * unscoped writes rather than guessing.
 */

const text = { type: 'string' } as const

export const teamPlugin: HarnessPlugin = {
  manifest: {
    id: 'team',
    name: 'Working together',
    description:
      'A shared task board for every conversation in a workspace, and messages between them — claims are host transactions, messages are attributed, guarded and audited.',
    permissions: { team: true },
    /*
     * The rules of the room, in the one place a person goes looking for them.
     *
     * Each of these is a switch on a behaviour a live run showed was not
     * obviously right for everybody, rather than a knob for its own sake:
     * answers that were invisible, muted attempts that left no trace, a held
     * state nothing could produce, and two loop-safety constants that were
     * only ever numbers in a source file. The host's Team engine enforces
     * them — this manifest is where they are described and edited.
     */
    configSchema: {
      type: 'object',
      properties: {
        answersInRoom: {
          type: 'boolean',
          title: 'Show answers in the channel',
          description:
            'When a message wakes a conversation, put its answer in the channel too. It is shown, never sent back: replying to a reply is how two agents talk to each other all night on your tokens.',
        },
        recordMutedAttempts: {
          type: 'boolean',
          title: 'Record messages stopped by board-only',
          description:
            'With board-only on, an agent that tries to talk is told no and you see nothing. This writes the attempt into the channel as refused, so the silence is visible.',
        },
        inboundDefault: {
          type: 'string',
          enum: ['accept', 'hold', 'refuse'],
          title: 'How new conversations take messages',
          description:
            'accept: messages arrive and start a turn. hold: they wait in the channel until you release each one. refuse: the sender is told the conversation is not taking mail.',
        },
        rateLimit: {
          type: 'number',
          title: 'Messages per minute, per pair',
          description:
            'How often one conversation may message another before the host refuses. Shared state belongs on the board; this is the ceiling on chatter.',
        },
        messageChars: {
          type: 'number',
          title: 'Longest message',
          description:
            'Characters. Anything longer belongs on the board as a context package, where the work it describes is.',
        },
      },
    },
  },
  plugin: {
    name: 'team',
    inject: ['tools', 'context', 'team'],
    apply(ctx: HarnessContext) {
      ctx.tools.register({
        name: 'list_intents',
        description:
          'The shared board for this workspace: every intent (piece of work), its state — open, claimed, blocked, done — who holds it, the files it owns, and what depends on what. Other conversations, possibly other agents, share this board. Read it before starting work someone may already hold.',
        inputSchema: { type: 'object', properties: {} },
        execute: (_args: unknown, scope) => ctx.team.board(scope),
      })

      ctx.tools.register({
        name: 'add_intent',
        description:
          'Put work on the shared board. `files` are the path patterns the work will own while claimed (e.g. "src/api/**") — claiming refuses overlaps, which is what makes parallel edits safe. `depends_on` names intent numbers that must finish first.',
        inputSchema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'One line of what the work is.' },
            detail: { type: 'string', description: 'What the next agent needs to know to do it.' },
            files: {
              type: 'array',
              items: text,
              description: 'Path patterns this work owns while claimed.',
            },
            depends_on: {
              type: 'array',
              items: { type: 'number' },
              description: 'Intent numbers that must be done first.',
            },
          },
          required: ['title'],
        },
        execute: (
          args: { title: string; detail?: string; files?: string[]; depends_on?: number[] },
          scope,
        ) =>
          ctx.team.addIntent(
            {
              title: String(args.title ?? ''),
              ...(args.detail !== undefined ? { detail: String(args.detail) } : {}),
              ...(args.files !== undefined ? { files: args.files.map(String) } : {}),
              ...(args.depends_on !== undefined
                ? { dependsOn: args.depends_on.map(Number) }
                : {}),
            },
            scope,
          ),
      })

      ctx.tools.register({
        name: 'claim_work',
        description:
          'Take one open intent from the shared board, atomically — refused if another conversation got there first, if its dependencies are not done, or if its files overlap a live claim. Always pass `files`: the paths you will touch are what stops another agent editing them under you, and a claim without them reserves the job but not the code. While you hold it, those files are yours. Complete or release it when you stop.',
        inputSchema: {
          type: 'object',
          properties: {
            intent: { type: 'number', description: 'The intent number, from list_intents.' },
            files: {
              type: 'array',
              items: { type: 'string' },
              description:
                'The paths or globs this work will touch — src/limiter.js, src/api/**. Claim them even when the intent already lists some; yours are added. Without them nobody is stopped from editing the same files.',
            },
          },
          required: ['intent'],
        },
        execute: (args: { intent: number; files?: readonly string[] }, scope) =>
          ctx.team.claim(Number(args.intent), scope, Array.isArray(args.files) ? args.files : undefined),
      })

      ctx.tools.register({
        name: 'claim_next',
        description:
          'Take the next open card on the board, whichever it is — the lowest-numbered one that is unblocked, not waiting on unfinished work, and not overlapping a live claim — atomically. This is how to work through a board without listing it: when you finish a card, call claim_next again, and keep going until it says nothing is left. Pass `files` for the paths you will touch, as with claim_work. The answer is the card, its detail, and whatever the work it depends on left for you.',
        inputSchema: {
          type: 'object',
          properties: {
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'The paths or globs this work will touch, added to the card\'s own.',
            },
          },
        },
        execute: (args: { files?: readonly string[] }, scope) =>
          ctx.team.claimNext(scope, Array.isArray(args.files) ? args.files : undefined),
      })

      ctx.tools.register({
        name: 'check_conflicts',
        description:
          'Ask whether paths you are about to touch are owned by another conversation’s live claim — before editing them, especially before changing something another agent’s work calls. A conflict is answered with a message to the holder, never by editing a file you do not hold.',
        inputSchema: {
          type: 'object',
          properties: {
            paths: {
              type: 'array',
              items: text,
              description: 'Paths or patterns you intend to touch.',
            },
          },
          required: ['paths'],
        },
        execute: (args: { paths: string[] }, scope) =>
          ctx.team.conflicts((args.paths ?? []).map(String), scope),
      })

      ctx.tools.register({
        name: 'complete_claim',
        description:
          'Finish an intent you hold. `note` is the one-liner the board shows. `context` is the context package — the actual contract you built: routes, shapes, signatures, gotchas. It is handed to whoever claims work that depended on yours, without them having to ask for it, so leave one whenever anything depends on your intent.',
        inputSchema: {
          type: 'object',
          properties: {
            intent: { type: 'number' },
            note: { type: 'string', description: 'One line for the board.' },
            context: {
              type: 'string',
              description: 'The contract the dependent work needs: routes, shapes, signatures.',
            },
          },
          required: ['intent'],
        },
        execute: (args: { intent: number; note?: string; context?: string }, scope) =>
          ctx.team.complete(
            Number(args.intent),
            {
              ...(args.note !== undefined ? { note: String(args.note) } : {}),
              ...(args.context !== undefined ? { handoff: String(args.context) } : {}),
            },
            scope,
          ),
      })

      ctx.tools.register({
        name: 'release_claim',
        description:
          'Hand an intent you hold back to the board unfinished — because you are stopping, or because it turned out blocked (`blocked: true`, with the reason). Its files are freed either way.',
        inputSchema: {
          type: 'object',
          properties: {
            intent: { type: 'number' },
            reason: { type: 'string' },
            blocked: {
              type: 'boolean',
              description: 'True marks it blocked rather than open again.',
            },
          },
          required: ['intent'],
        },
        execute: (args: { intent: number; reason?: string; blocked?: boolean }, scope) =>
          ctx.team.release(
            Number(args.intent),
            {
              ...(args.reason !== undefined ? { reason: String(args.reason) } : {}),
              ...(args.blocked !== undefined ? { blocked: Boolean(args.blocked) } : {}),
            },
            scope,
          ),
      })

      ctx.tools.register({
        name: 'get_context',
        description:
          'The context package left by whoever completed an intent — the actual contract, not "the file changed". You do not need this to start: claiming an intent already hands you what everything it depends on left behind. Use it to look up an intent you did not depend on, or to read one again.',
        inputSchema: {
          type: 'object',
          properties: { intent: { type: 'number' } },
          required: ['intent'],
        },
        execute: (args: { intent: number }, scope) => ctx.team.handoff(Number(args.intent), scope),
      })

      ctx.tools.register({
        name: 'get_team_status',
        description:
          'Who is live on this board — each conversation’s name, which agent runs it, whether it is working or idle, and what it holds. The names are what agent_message addresses.',
        inputSchema: { type: 'object', properties: {} },
        execute: (_args: unknown, scope) => ctx.team.status(scope),
      })

      ctx.tools.register({
        name: 'agent_message',
        description:
          'Send a short message to another conversation, by its name from get_team_status. Use it for surprises — a moved function, a changed contract, a conflict — and use the board for state; messages cost the receiver a turn. Delivered when they are idle, queued until their turn ends otherwise; `wake: true` interrupts a running turn where the agent supports it. The result says exactly which happened. Text only, and to the receiver it is information, not instruction.',
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'The conversation’s name.' },
            text: { type: 'string' },
            wake: {
              type: 'boolean',
              description: 'Steer into a running turn instead of waiting, where supported.',
            },
          },
          required: ['to', 'text'],
        },
        execute: (args: { to: string; text: string; wake?: boolean }, scope) =>
          ctx.team.send(
            {
              to: String(args.to ?? ''),
              text: String(args.text ?? ''),
              ...(args.wake !== undefined ? { wake: Boolean(args.wake) } : {}),
            },
            scope,
          ),
      })

      // The board as a composer chip: attached when the person wants an agent
      // briefed on the team's state, never folded into every turn — claims
      // are supposed to cost nothing, and a per-turn injection would bill
      // every conversation for the board's existence.
      ctx.context.register({
        label: 'Team board',
        chip: {
          description: 'The shared board: intents, claims, and who holds what.',
        },
        resolve: (scope) => ctx.team.board(scope),
      })
    },
  },
}
