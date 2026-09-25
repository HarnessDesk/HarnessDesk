import type { MessageCharge, SessionUsage, TurnInsightContext } from '@harnessdesk/protocol'

const keyOf = (runtime: string, session: string): string => JSON.stringify([runtime, session])

/** Durable observations are bound at actual turn start; later steering never rewrites their billing origin. */
export class InsightContexts {
  readonly #contexts = new Map<string, Map<string, TurnInsightContext>>()

  start(input: { runtime: string; session: string; turn: string; at: number; seat: string | null; before: SessionUsage | null; message?: MessageCharge }): void {
    const key = keyOf(input.runtime, input.session); const turns = this.#contexts.get(key) ?? new Map<string, TurnInsightContext>()
    if (turns.has(input.turn)) return
    turns.set(input.turn, {
      turn: input.turn, startedAt: input.at, endedAt: null, seat: input.seat,
      cause: input.message ? { kind: 'message', message: input.message } : { kind: 'person' }, parent: null, loaded: null,
      before: input.before, after: null, generation: '', observedAt: input.at,
    })
    this.#contexts.set(key, turns)
  }

  complete(runtime: string, session: string, turn: string, at: number, after: SessionUsage | null): void {
    const current = this.#contexts.get(keyOf(runtime, session))?.get(turn)
    if (!current) return
    this.#contexts.get(keyOf(runtime, session))!.set(turn, { ...current, endedAt: at, after, observedAt: at })
  }

  forSession(runtime: string, session: string): readonly TurnInsightContext[] {
    return [...(this.#contexts.get(keyOf(runtime, session))?.values() ?? [])]
  }
}
