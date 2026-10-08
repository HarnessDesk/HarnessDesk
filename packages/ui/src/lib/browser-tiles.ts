import { sessionKey, type SessionKey } from '@harnessdesk/protocol'
import type { AppSnapshot } from '../state/snapshot'
import { browserView, panes } from '../state/layout'
import { findView, mountedViews, removeAt, viewAt, type Workbench } from '../state/workbench'

export interface BrowserTileMount {
  readonly paneId: string
  readonly key: SessionKey
  readonly focus?: () => void
}
export const browserProfileKey = (profile: string | null): string => profile ?? 'default'

/** One live guest per profile, even when two tiles share the ordinary browser. */
export class BrowserTileRegistry {
  readonly #claims = new Map<string, BrowserTileMount[]>()
  mount(profile: string | null, mount: BrowserTileMount, publish: (owners: ReadonlyMap<string, BrowserTileMount>) => void): () => void {
    const key = browserProfileKey(profile)
    const claims = this.#claims.get(key) ?? []
    this.#claims.set(key, [...claims, mount])
    const announce = () => publish(new Map([...this.#claims].map(([profile, entries]) => [profile, entries[0]!])))
    if (claims.length === 0) announce()
    return () => {
      const before = this.#claims.get(key)
      if (!before?.includes(mount)) return
      const rest = before.filter(one => one !== mount)
      if (rest.length) this.#claims.set(key, rest)
      else this.#claims.delete(key)
      if (before[0] === mount) announce()
    }
  }
}

/** The host resolves browser scope by the Seat's checkout, never by a selected agent. */
export function seatBrowserProfile(snapshot: AppSnapshot, key: SessionKey): string | null | undefined {
  if (snapshot.lanePreferences === null) return undefined
  const seats = [...snapshot.goals.values()].flatMap(goal => goal.members)
    .filter(seat => sessionKey(seat.session.runtime, seat.session.sessionId) === key && !seat.restored)
  const seat = seats.find(one => one.closed === null) ?? seats.at(-1)
  const cwd = seat?.checkout.cwd ?? snapshot.sessions.get(key)?.cwd
  if (!cwd) return undefined
  const lane = snapshot.lanes.find(one => one.cwd === cwd)
  if (lane) return lane.state === 'released' ? undefined : lane.browserProfile
  return seat?.board && snapshot.goals.get(seat.board)?.goal.checkout === 'isolated' ? undefined : null
}

export function browserMount(snapshot: AppSnapshot, profile: string | null) {
  const found = findView(snapshot.workbench, browserView('about:blank', profile))
  if (!found) return null
  const id = found.area === 'main' ? found.pane : found.mounted.id
  const view = viewAt(snapshot.workbench, id)
  return view?.kind === 'browser' ? { area: found.area, id, view } : null
}

/** Projection only: the saved panel and its tabs remain the source of truth. */
export function tileBrowserWorkbench(snapshot: AppSnapshot): Workbench {
  if (snapshot.browserTiles.size === 0) return snapshot.workbench
  const entries = [
    ...panes(snapshot.workbench.main.root).map(pane => ({ id: pane.id, view: pane.view })),
    ...mountedViews(snapshot.workbench).map(entry => entry.mounted),
  ]
  return entries.reduce((workbench, entry) => entry.view.kind === 'browser' && snapshot.browserTiles.has(browserProfileKey(entry.view.profile ?? null))
    ? removeAt(workbench, entry.id) : workbench, snapshot.workbench)
}
