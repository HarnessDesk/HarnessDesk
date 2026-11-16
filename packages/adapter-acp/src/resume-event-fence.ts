/** A retired replay may not fold late events into its abandoned session. */
export class ResumeEventFence {
  readonly #replays = new Map<string, { owner: object; connection: object; session: object; retired: boolean }>()
  track(id: string, owner: object, connection: object, session: object): void {
    this.#replays.set(id, { owner, connection, session, retired: false })
  }
  retire(id: string, owner: object): void {
    const replay = this.#replays.get(id)
    if (replay?.owner === owner) replay.retired = true
  }
  suppress(id: string, connection: object, current: object | undefined): boolean {
    const replay = this.#replays.get(id)
    // A rejected replay is removed from the live map before its peer dies.
    // Its connection still owns late notifications while no newer handle exists.
    return replay?.retired === true && replay.connection === connection && (current === undefined || replay.session === current)
  }
  forget(id: string, owner: object): void {
    if (this.#replays.get(id)?.owner === owner) this.#replays.delete(id)
  }
}
