import { CodexRpcError, type CodexAppServer, type CodexProtocol } from '@harnessdesk/codex'

/**
 * A thread's history: read, and undone, the way the thread keeps it.
 *
 * Codex keeps a thread's history one of two ways and says which in
 * `Thread.historyMode`. Measured on 0.145.0 and 0.155.0 with
 * `script/probe/paginated-history.mjs`:
 *
 * - **paginated** — every thread Codex has started since 0.151.0, bar an
 *   ephemeral one. It is paged with `thread/turns/list` and
 *   `thread/items/list` and undone with `thread/revert`. Codex refuses it
 *   `thread/rollback`, and answers every whole-history verb — `thread/read`
 *   with `includeTurns`, `thread/fork` and `thread/resume` without
 *   `excludeTurns` — with a `deprecationNotice`. The desk showed each of
 *   those as a toast naming wire methods.
 * - **legacy** — a thread an older Codex started, and every thread before
 *   0.151.0. It is read whole, which draws no notice: `thread/items/list`
 *   refuses it ("not supported yet"), and so does `thread/revert` ("only
 *   supports paginated threads"). It is undone with `thread/rollback`, which
 *   Codex announces as deprecated all the same, for every client but its own
 *   terminal. Codex has no replacement for a legacy thread, so that one
 *   notice stays.
 *
 * A thread that does not say is legacy, which is what every Codex before
 * paginated history had.
 */

type Thread = CodexProtocol.v2.Thread
type Turn = CodexProtocol.v2.Turn

/** The most either listing hands over at once (`THREAD_TURNS_MAX_LIMIT`, `THREAD_ITEMS_MAX_LIMIT`). */
const PAGE = 100

const paginated = (thread: Thread): boolean => thread.historyMode === 'paginated'

/**
 * Codex's refusal to list or read the turns of a thread that has none stored
 * yet, because it has not had its first message. Its own terminal client
 * reads these same words as "no turns" (`can_fallback_from_include_turns_error`).
 * A thread held live here can be refused with "list_turns is not supported
 * yet" instead. That one is not read as empty, because it is also what an
 * unreadable store says; the host answers it from the transcript it holds.
 */
const unmaterialized = (error: unknown): boolean =>
  error instanceof CodexRpcError && /unavailable before first user message/.test(error.message)

/**
 * Every item of a listing, following `nextCursor` until Codex says there is
 * no more, or until `enough` says the pages so far will do. A cursor handed
 * out twice would read the same pages forever; Codex's own server and its
 * terminal client both stop on one, and so does this, out loud, because a
 * history cut short must not pass for a whole one.
 */
const everyPage = async <T>(
  page: (cursor: string | null) => Promise<{ readonly data: readonly T[]; readonly nextCursor: string | null }>,
  what: string,
  enough: (read: readonly T[]) => boolean = () => false,
): Promise<T[]> => {
  const read: T[] = []
  const seen = new Set<string>()
  let cursor: string | null = null
  for (;;) {
    const next = await page(cursor)
    read.push(...next.data)
    cursor = next.nextCursor
    if (cursor === null || enough(read)) return read
    if (seen.has(cursor)) throw new Error(`Codex handed back the same page of this conversation's ${what} twice.`)
    seen.add(cursor)
  }
}

/**
 * Every turn of a thread, each holding all of its items, oldest first.
 *
 * A paginated thread is paged, as Codex's own terminal client pages one
 * (`hydrate_initial_thread_history`): its turns, without their items, then
 * every item of the thread, each filed under the turn it names. An item whose
 * turn the first listing did not hold belongs to a turn that started after
 * it, and is left for the next read. A legacy thread is read whole.
 */
export const readHistory = async (server: CodexAppServer, thread: Thread): Promise<Turn[]> => {
  try {
    if (!paginated(thread)) {
      return (await server.request('thread/read', { threadId: thread.id, includeTurns: true })).thread.turns
    }
    const turns = await everyPage(
      (cursor) =>
        server.request('thread/turns/list', {
          threadId: thread.id,
          cursor,
          limit: PAGE,
          sortDirection: 'asc',
          itemsView: 'notLoaded',
        }),
      'turns',
    )
    const items = new Map(turns.map((turn) => [turn.id, [] as CodexProtocol.v2.ThreadItem[]]))
    const entries = await everyPage(
      (cursor) => server.request('thread/items/list', { threadId: thread.id, cursor, limit: PAGE, sortDirection: 'asc' }),
      'items',
    )
    for (const entry of entries) items.get(entry.turnId)?.push(entry.item)
    return turns.map((turn) => ({ ...turn, items: items.get(turn.id) ?? [], itemsView: 'full' }))
  } catch (error) {
    if (unmaterialized(error)) return []
    throw error
  }
}

/**
 * Drops a thread's last `count` turns.
 *
 * A paginated thread is reverted to before the `count`th turn from its end,
 * counted in Codex's own turns — the ones the desk's transcript holds. More
 * turns than it has drops them all, as `thread/rollback` does, and a thread
 * with nothing stored has nothing to drop. A legacy thread is rolled back.
 */
export const undoTurns = async (server: CodexAppServer, thread: Thread, count: number): Promise<void> => {
  if (!paginated(thread)) {
    await server.request('thread/rollback', { threadId: thread.id, numTurns: count })
    return
  }
  let newest: Turn[]
  try {
    newest = await everyPage(
      (cursor) =>
        server.request('thread/turns/list', {
          threadId: thread.id,
          cursor,
          limit: Math.min(count, PAGE),
          sortDirection: 'desc',
          itemsView: 'notLoaded',
        }),
      'turns',
      (read) => read.length >= count,
    )
  } catch (error) {
    if (unmaterialized(error)) return
    throw error
  }
  const first = newest.slice(0, count).at(-1)
  if (!first) return
  try {
    await server.request('thread/revert', { threadId: thread.id, beforeTurnId: first.id })
  } catch (error) {
    // Before 0.148.0 Codex has no `thread/revert`, and it refuses a paginated
    // thread `thread/rollback` too. Its refusal lists every method it knows.
    if (error instanceof CodexRpcError && /unknown variant `thread\/revert`/.test(error.message)) {
      throw new Error(
        'This version of Codex cannot undo a turn in a conversation a newer Codex started. Update Codex to undo it.',
      )
    }
    throw error
  }
}
