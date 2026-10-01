/**
 * The tiles of a room's Side by side view, as data.
 *
 * Which members are up, which is focused, which is expanded and which are
 * pinned is the person's choice and is kept on the room's view; how many of
 * them *fit* is a fact about the pane right now. The two were one list before
 * — the column observer trimmed the stored columns whenever the window
 * narrowed, so a race's four tiles became two and stayed two. Here the
 * choice is never changed by width: `displayFor` decides what is drawn.
 */
import type { SessionKey } from '@harnessdesk/protocol'

export type TileMode = 'conversation' | 'browser'

export interface SideBySideState {
  readonly tiles: readonly SessionKey[]
  readonly pinned: readonly SessionKey[]
  readonly modes: Readonly<Record<string, TileMode>>
  readonly focused: SessionKey | null
  readonly expanded: SessionKey | null
  /** Least recently seen first; the newest last. */
  readonly seen: readonly SessionKey[]
}

export interface StoredSideBySide {
  readonly tiles: readonly SessionKey[]
  readonly pinned?: readonly SessionKey[]
  readonly modes?: Readonly<Record<string, TileMode>>
  readonly focused?: SessionKey
  readonly expanded?: SessionKey
}

export const MAX_TILES = 4
export const MIN_TILE_WIDTH = 420
/** The hairline between two tiles (`--hd-space-px`), which the grid draws as a track of its own. */
export const SEAM_WIDTH = 1

/** How many tiles of at least `MIN_TILE_WIDTH` fit across, seams between them included. */
export const columnsThatFit = (width: number): number =>
  Math.max(0, Math.floor((width + SEAM_WIDTH) / (MIN_TILE_WIDTH + SEAM_WIDTH)))

export const emptySideBySide = (): SideBySideState => ({
  tiles: [],
  pinned: [],
  modes: {},
  focused: null,
  expanded: null,
  seen: [],
})

const seenNow = (seen: readonly SessionKey[], key: SessionKey): readonly SessionKey[] => [
  ...seen.filter((one) => one !== key),
  key,
]

export const wouldReplace = (state: SideBySideState, key: SessionKey): SessionKey | null => {
  if (state.tiles.includes(key) || state.tiles.length < MAX_TILES) return null
  const movable = (one: SessionKey) => state.tiles.includes(one) && !state.pinned.includes(one) && one !== state.focused
  return state.seen.find(movable) ?? state.tiles.find(movable) ?? null
}

/**
 * Whether Watch can put this member up: it is up already, there is a free
 * place, or some tile is free to give its place up. False only when every
 * other tile is pinned or focused, which `placeTile` would leave unchanged.
 */
export const canPlace = (state: SideBySideState, key: SessionKey): boolean =>
  state.tiles.includes(key) || state.tiles.length < MAX_TILES || wouldReplace(state, key) !== null

/**
 * Move the keyboard to a tile that is up. An expanded tile follows it: the
 * expanded tile is the only one drawn, so focusing another while one fills
 * the grid would otherwise move the keys to a tile nobody can see.
 */
const follow = (state: SideBySideState, key: SessionKey): SideBySideState => ({
  ...state,
  focused: key,
  expanded: state.expanded === null ? null : key,
  seen: seenNow(state.seen, key),
})

export const placeTile = (state: SideBySideState, key: SessionKey): SideBySideState => {
  if (state.tiles.includes(key)) return focusTile(state, key)
  if (state.tiles.length < MAX_TILES) return follow({ ...state, tiles: [...state.tiles, key] }, key)
  const victim = wouldReplace(state, key)
  if (!victim) return state
  const { [victim]: _dropped, ...modes } = state.modes
  return follow({
    ...state,
    tiles: state.tiles.map((one) => (one === victim ? key : one)),
    modes,
    seen: state.seen.filter((one) => one !== victim),
  }, key)
}

export const removeTile = (state: SideBySideState, key: SessionKey): SideBySideState => {
  if (!state.tiles.includes(key)) return state
  const at = state.tiles.indexOf(key)
  const tiles = state.tiles.filter((one) => one !== key)
  const { [key]: _dropped, ...modes } = state.modes
  const focused = state.focused === key ? (tiles[Math.min(at, tiles.length - 1)] ?? null) : state.focused
  return {
    ...state,
    tiles,
    modes,
    pinned: state.pinned.filter((one) => one !== key),
    focused,
    expanded: state.expanded === key ? null : state.expanded,
    seen: state.seen.filter((one) => one !== key),
  }
}

export const focusTile = (state: SideBySideState, key: SessionKey): SideBySideState => {
  if (!state.tiles.includes(key)) return state
  // Unchanged is returned as itself, so a click inside the focused tile
  // re-renders nothing and writes nothing.
  if (state.focused === key && state.seen.at(-1) === key && (state.expanded === null || state.expanded === key)) return state
  return follow(state, key)
}

export const focusIndex = (state: SideBySideState, index: number): SideBySideState => {
  const key = state.tiles[index]
  return key ? focusTile(state, key) : state
}

export const expandTile = (state: SideBySideState, key: SessionKey | null): SideBySideState => {
  if (key === null) return { ...state, expanded: null }
  if (!state.tiles.includes(key)) return state
  return { ...focusTile(state, key), focused: key, expanded: key }
}

export const pinTile = (state: SideBySideState, key: SessionKey, pinned: boolean): SideBySideState => {
  if (!state.tiles.includes(key)) return state
  const rest = state.pinned.filter((one) => one !== key)
  return { ...state, pinned: pinned ? [...rest, key] : rest }
}

export const setTileMode = (state: SideBySideState, key: SessionKey, mode: TileMode): SideBySideState => {
  if (!state.tiles.includes(key)) return state
  const { [key]: _was, ...rest } = state.modes
  return { ...state, modes: mode === 'conversation' ? rest : { ...rest, [key]: mode } }
}

export const displayFor = (
  state: SideBySideState,
  width: number,
): { readonly layout: 'grid' | 'single'; readonly columns: number; readonly shown: readonly SessionKey[] } => {
  const lone = state.focused ?? state.tiles[0] ?? null
  if (state.expanded) return { layout: 'single', columns: 1, shown: [state.expanded] }
  const fits = columnsThatFit(width)
  const count = state.tiles.length
  if (count <= 1) return { layout: 'grid', columns: 1, shown: state.tiles }
  if (fits < 2) return { layout: 'single', columns: 1, shown: lone ? [lone] : [] }
  if (count === 3 && fits >= 3) return { layout: 'grid', columns: 3, shown: state.tiles }
  return { layout: 'grid', columns: 2, shown: state.tiles }
}

export const forgetMissing = (state: SideBySideState, present: ReadonlySet<SessionKey>): SideBySideState =>
  state.tiles.filter((one) => !present.has(one)).reduce(removeTile, state)

const isKey = (value: unknown): value is SessionKey => typeof value === 'string' && value !== ''

export const toStored = (state: SideBySideState): StoredSideBySide | undefined => {
  if (state.tiles.length === 0) return undefined
  return {
    tiles: state.tiles,
    ...(state.pinned.length > 0 ? { pinned: state.pinned } : {}),
    ...(Object.keys(state.modes).length > 0 ? { modes: state.modes } : {}),
    ...(state.focused ? { focused: state.focused } : {}),
    ...(state.expanded ? { expanded: state.expanded } : {}),
  }
}

export const fromStored = (
  stored: StoredSideBySide | undefined,
  watching: readonly SessionKey[] = [],
): SideBySideState => {
  // Read from disk, so every field is checked rather than trusted: a field
  // of the wrong shape is dropped, never thrown on while the desk restores.
  const list = (value: unknown): readonly unknown[] => (Array.isArray(value) ? value : [])
  const tiles = [...new Set(list(stored?.tiles ?? watching).filter(isKey))].slice(0, MAX_TILES)
  const within = (key: unknown): key is SessionKey => isKey(key) && tiles.includes(key)
  const modes = Object.fromEntries(
    Object.entries(stored?.modes && typeof stored.modes === 'object' && !Array.isArray(stored.modes) ? stored.modes : {}).filter(
      // Conversation is the default and is not stored; anything else unknown is dropped.
      ([key, mode]) => within(key) && mode === 'browser',
    ),
  ) as Record<string, TileMode>
  return {
    tiles,
    pinned: [...new Set(list(stored?.pinned).filter(within))],
    modes,
    // An expanded tile is the only one drawn, so it is the one with the keys.
    focused: within(stored?.expanded) ? stored!.expanded! : within(stored?.focused) ? stored!.focused! : (tiles[0] ?? null),
    expanded: within(stored?.expanded) ? stored!.expanded! : null,
    seen: tiles,
  }
}
