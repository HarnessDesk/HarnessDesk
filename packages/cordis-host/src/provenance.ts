import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * What caused the plugin code that is running right now.
 *
 * A plugin's permissions say what *it* may do. They cannot say who asked, and
 * for one grant that difference is the whole point: `workspace.write`.
 *
 * [the editor-plane decision](../../../docs/decisions.md#writing-a-file-belongs-to-the-editor-plane)
 * settled that no write tool is projected to agents — an agent's edits belong
 * to its own runtime, with its own approval, because a client that offers to
 * write on an agent's behalf is a client that has to be trusted with it. But a
 * plugin may both contribute a tool *every agent can call* and hold
 * `workspace.write`, and `applyEdits` checked only the plugin's grants. An
 * agent could therefore write a file by asking a plugin to, with no approval
 * anywhere on the path: the privilege was laundered through the plugin.
 *
 * So the cause travels with the call. It is not guesswork — the two entry
 * points already say it plainly, and always have:
 *
 *   `tool/invoke`   only agents call tools
 *   `command/run`   a person typed it, or pressed a button that names it
 *   `hooks/run`     the host, on an event
 *
 * `AsyncLocalStorage` rather than a parameter because the plugin's own code
 * sits between the entry point and `ctx.editor`, and threading an argument
 * through third-party code is not something we can require or check.
 */
export type Actor = 'human' | 'agent' | 'system' | 'plugin'

const store = new AsyncLocalStorage<Actor>()

/** Runs `body` with the cause recorded, for anything it reaches. */
export const asActor = <T>(actor: Actor, body: () => T): T => store.run(actor, body)

/**
 * Who caused the call in flight.
 *
 * `plugin` when nothing set it: a plugin acting on its own initiative — a
 * timer, a file watcher — which the editor-plane decision already allows. The default is
 * deliberately the permissive one, because the restriction here is about a
 * *specific* cause rather than about a missing one, and a default of `agent`
 * would refuse every ordinary plugin write.
 */
export const currentActor = (): Actor => store.getStore() ?? 'plugin'
