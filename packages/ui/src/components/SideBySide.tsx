import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type Dispatch, type SetStateAction } from 'react'
import type { SessionKey, Turn } from '@harnessdesk/protocol'

import {
  columnsThatFit,
  displayFor,
  expandTile,
  focusIndex,
  focusTile,
  pinTile,
  removeTile,
  type SideBySideState,
} from '../lib/side-by-side'
import { KeyboardHereContext, PaneProvider, useIsFocusedPane } from '../state/context'
import { Approvals } from './Approvals'
import type { SeatCeilingShown } from '../lib/ceilings'
import { BrandMark } from './BrandIcons'
import { CeilingChip } from './CeilingChip'
import { Conversation } from './Conversation'
import {
  AgentIcon,
  CollapseIcon,
  ExpandIcon,
  MoreIcon,
} from './Icons'
import {
  Bar,
  Button,
  Chip,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  IconTile,
  Separator,
  Tabs,
  TabsList,
  TabsTrigger,
  Text,
  Dot,
} from '../design'
import styles from './SideBySide.module.css'

/** What a tile's header reads about its member. The room supplies it. */
export type TileEntry = {
  readonly tint?: ComponentProps<typeof IconTile>['tint']
  readonly brand?: ComponentProps<typeof BrandMark>['brand'] | null
  readonly busy?: boolean
  readonly waitingForYou?: boolean
  /** How its last turn ended, while it is neither working nor waiting: done, or stopped short. */
  readonly ended?: 'done' | 'stopped'
  /** What it may do unasked, when held under a ceiling — the safety fact the conversation's own header carried. */
  readonly ceiling?: SeatCeilingShown | null
}

/** Resolve the room facts into the entry the shipped tile draws. */
export const sideBySideTileEntry = (
  entry: Pick<TileEntry, 'tint' | 'brand' | 'busy' | 'waitingForYou' | 'ceiling'> & {
    readonly lastTurnStatus?: Turn['status']
  },
): TileEntry => ({
  tint: entry.tint,
  brand: entry.brand,
  busy: entry.busy,
  waitingForYou: entry.waitingForYou,
  ceiling: entry.ceiling,
  ...(entry.lastTurnStatus === 'completed'
    ? { ended: 'done' as const }
    : entry.lastTurnStatus === 'interrupted' || entry.lastTurnStatus === 'failed'
      ? { ended: 'stopped' as const }
      : {}),
})
type ConversationProps = ComponentProps<typeof Conversation>

export const SideBySide = ({
  state,
  onChange,
  paneId,
  memberOf,
  entryOf,
  onOpenMember,
  conversationProps,
  card = (_key, who) => who,
}: {
  state: SideBySideState
  /** Takes an update, so two chords before a render both land. */
  onChange: Dispatch<SetStateAction<SideBySideState>>
  paneId: string
  memberOf: (key: SessionKey) => { readonly nickname: string; readonly agent?: string; readonly model?: string } | undefined
  entryOf: (key: SessionKey) => TileEntry | null
  onOpenMember: (key: SessionKey) => void
  conversationProps: ConversationProps
  /**
   * Wraps a tile's identity — its mark, name and model — in whatever card the
   * caller hangs on a member (the room's member hover card). Passed in so the
   * grid knows nothing of the room that holds it.
   */
  card?: (key: SessionKey, who: React.ReactNode) => React.ReactNode
}) => {
  const gridRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const focusedPane = useIsFocusedPane()
  /* A tile never claims the keyboard that what encloses the grid says is
     elsewhere; it can only narrow it to one tile. */
  const keyboardAbove = useContext(KeyboardHereContext) !== false
  const shown = displayFor(state, width)
  /* Narrow is about the room's width, not about what is shown: an expanded
     tile in a narrow room keeps the strip, so the member can still be
     switched without first pressing Esc. */
  const narrow = state.tiles.length > 1 && columnsThatFit(width) < 2
  /* The tile a chord just chose, whose composer takes the keyboard once it
     is drawn: a chord moves the keys, not only the highlight. */
  const typeInto = useRef<SessionKey | null>(null)
  /* Counted, so a chord that changes no state (the tile it names already
     has the keys) still runs the effect below — and every chord's request
     is spent there, never left armed for a later, unrelated focus. */
  const [chords, setChords] = useState(0)
  useEffect(() => {
    const key = typeInto.current
    typeInto.current = null
    if (!key || state.focused !== key) return
    // Compared, not selected: a session key carries a NUL, which
    // `CSS.escape` turns into U+FFFD, so no selector can name it.
    const tile = [...(gridRef.current?.querySelectorAll<HTMLElement>('[data-slot="side-by-side-tile"]') ?? [])]
      .find((one) => one.dataset.sessionKey === key)
    const target = tile?.querySelector<HTMLElement>('textarea') ?? tile
    target?.focus()
  }, [state.focused, state.expanded, chords])

  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const measure = (): void => setWidth(grid.getBoundingClientRect().width)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const onCommand = (event: Event): void => {
      // The app broadcasts a chord to every mounted grid. Focus can move
      // between them before either focused-pane context has rendered, so the
      // live DOM owner takes precedence whenever focus is inside a grid.
      const activeGrid = document.activeElement instanceof Element
        ? document.activeElement.closest('[data-slot="side-by-side-grid"]')
        : null
      if (activeGrid ? activeGrid !== gridRef.current : !focusedPane) return
      const action = (event as CustomEvent<string>).detail
      if (action === 'tile-1' || action === 'tile-2' || action === 'tile-3' || action === 'tile-4') {
        const key = state.tiles[Number(action.slice(-1)) - 1]
        if (!key) return
        typeInto.current = key
        setChords((count) => count + 1)
        onChange((was) => focusIndex(was, Number(action.slice(-1)) - 1))
      } else if (action === 'tile-expand' && state.focused) {
        typeInto.current = state.focused
        setChords((count) => count + 1)
        onChange((was) => (was.focused ? expandTile(was, was.expanded === was.focused ? null : was.focused) : was))
      }
    }
    window.addEventListener('hd-side-by-side', onCommand)
    return () => window.removeEventListener('hd-side-by-side', onCommand)
  }, [focusedPane, onChange, state])

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented || !state.expanded) return
    /* An approval waiting in the expanded tile answers Esc itself (deny),
       from the window after this; collapsing first would spend the press
       and leave the question open behind a grid that moved. */
    if (entryOf(state.expanded)?.waitingForYou) return
    event.preventDefault()
    onChange((was) => expandTile(was, null))
  }, [entryOf, onChange, state.expanded])

  const focus = (key: SessionKey) => onChange((was) => focusTile(was, key))
  /*
   * Where each shown tile sits. The grid's tracks alternate tiles and one-
   * hairline seams, and the system's Separator draws each seam — the screen
   * places, it never paints. Every tile stays a direct child of the grid in
   * tile order, whatever is shown: moving one into a row of its own would
   * remount it, and a remount loses a transcript's scroll and reloads a page.
   * A short last row's last tile spans to the grid's end.
   */
  const columns = shown.columns
  const rows = Math.max(1, Math.ceil(shown.shown.length / columns))
  const track = (count: number) =>
    Array.from({ length: count }, () => 'minmax(0, 1fr)').join(' var(--hd-space-px) ')
  const gridStyle = { gridTemplateColumns: track(columns), gridTemplateRows: track(rows) } as CSSProperties
  const place = (key: SessionKey): CSSProperties | undefined => {
    const at = shown.shown.indexOf(key)
    if (at < 0) return undefined
    const row = Math.floor(at / columns)
    const column = at % columns
    const inRow = Math.min(columns, shown.shown.length - row * columns)
    const lastOfShortRow = inRow < columns && column === inRow - 1
    return {
      gridRow: row * 2 + 1,
      gridColumn: lastOfShortRow ? `${column * 2 + 1} / -1` : column * 2 + 1,
    }
  }
  const seams: { key: string; orientation: 'vertical' | 'horizontal'; style: CSSProperties }[] = []
  for (let row = 0; row < rows; row++) {
    const inRow = Math.min(columns, shown.shown.length - row * columns)
    for (let column = 1; column < inRow; column++) {
      seams.push({ key: `v${row}:${column}`, orientation: 'vertical', style: { gridRow: row * 2 + 1, gridColumn: column * 2 } })
    }
    if (row > 0) seams.push({ key: `h${row}`, orientation: 'horizontal', style: { gridRow: row * 2, gridColumn: '1 / -1' } })
  }

  return (
    <div className={styles.root} onKeyDown={onKeyDown}>
      {/* One tile at a time when the room is too narrow for two: the system's
          tabs pick which, with their arrow keys and roving focus. */}
      {narrow && (
        <div className={styles.strip}>
          <Tabs value={state.focused ?? state.tiles[0] ?? ''} onValueChange={(next) => focus(next as SessionKey)}>
            <TabsList aria-label="Side by side tiles">
              {state.tiles.map((key) => (
                <TabsTrigger key={key} value={key}>
                  {memberOf(key)?.nickname ?? 'Member'}
                  {/* The tab is all a narrow room shows of a member it is not
                      showing, so a member waiting on the person says so here. */}
                  {entryOf(key)?.waitingForYou && <Dot tone="warning" aria-label="waiting for you" />}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
      )}
      <div ref={gridRef} data-slot="side-by-side-grid" className={styles.grid} style={gridStyle}>
        {state.tiles.map((key) => {
          const member = memberOf(key)
          const entry = entryOf(key)
          const nickname = member?.nickname ?? 'Member'
          const isFocused = state.focused === key
          const isExpanded = state.expanded === key
          const isHidden = !shown.shown.includes(key)
          const model = [member?.agent === nickname ? null : member?.agent, member?.model].filter(Boolean).join(' · ')
          return (
            <section
              key={key}
              data-slot="side-by-side-tile"
              data-session-key={key}
              {...(isFocused ? { 'data-focused': '' } : {})}
              {...(isHidden ? { 'data-hidden': '' } : {})}
              /* A tile nobody can see takes no keys: `inert` keeps focus out
                 of it and is what `Approvals` reads before it answers a key,
                 so a hidden member's approval cannot be answered unseen. */
              {...(isHidden ? { inert: true } : {})}
                      className={styles.tile}
              style={place(key)}
              tabIndex={-1}
              aria-label={nickname}
              onClick={() => focus(key)}
              /* Keyboard entry counts as choosing the tile, the same as a
                 click: Tab into its composer and the keys are its keys. */
              onFocusCapture={() => focus(key)}
            >
              <Bar as="header" rule="bottom" active={isFocused && shown.shown.length > 1}
                /* Agent and model detail give way before the name; a name
                   longer than its column wraps and the bar grows to hold it. */
                grow
                className={styles.header}>
                {card(key, (
                  <span className={styles.member}>
                    <span className={styles.mark}>
                      <IconTile size="sm" shape="face" tint={entry?.tint ?? 'blue'}>
                        {entry?.brand ? <BrandMark brand={entry.brand} size={13} /> : <AgentIcon />}
                      </IconTile>
                      {entry?.busy && <Dot state="ready" variant="presence" pulse aria-hidden />}
                    </span>
                    <Text role="row" className={styles.nickname}>{nickname}</Text>
                    {model && <Text role="meta" className={styles.model} truncate>{model}</Text>}
                  </span>
                ))}
                {entry?.ceiling && <CeilingChip ceiling={entry.ceiling.ceiling} note={entry.ceiling.note} />}
                {/* Waiting outranks working, as it does everywhere a pane's
                    state is told (`paneStatus`): a turn held on an approval
                    is still in progress, and the question is what needs the
                    person. */}
                {entry?.waitingForYou ? (
                  <Chip tone="warning" size="sm">Waiting for you</Chip>
                ) : entry?.busy ? (
                  <Chip state="ready" size="sm">Working</Chip>
                ) : entry?.ended === 'done' ? (
                  <Chip tone="neutral" size="sm">Done</Chip>
                ) : entry?.ended === 'stopped' ? (
                  <Chip tone="neutral" size="sm">Stopped</Chip>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${nickname}`}
                  title={isExpanded ? 'Return to the grid' : 'Expand tile'}
                  onClick={(event) => {
                    event.stopPropagation()
                    onChange((was) => expandTile(was, isExpanded ? null : key))
                  }}
                >
                  {isExpanded ? <CollapseIcon size={14} /> : <ExpandIcon size={14} />}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={`${nickname} actions`} title="Tile actions"><MoreIcon size={14} /></Button>} />
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={(event) => { event.stopPropagation(); onOpenMember(key) }}>Open conversation</DropdownMenuItem>
                    <DropdownMenuItem onClick={(event) => {
                      event.stopPropagation()
                      onChange((was) => pinTile(was, key, !was.pinned.includes(key)))
                    }}>
                      {state.pinned.includes(key) ? 'Unpin' : 'Pin to the grid'}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={(event) => { event.stopPropagation(); onChange((was) => removeTile(was, key)) }}>Take off the grid</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </Bar>
              <div className={styles.body}>
                {/* One tile has the keyboard. The others read as unfocused
                    panes to everything inside them — their composers take
                    no compose events, their approvals answer no keys and
                    take no focus — so one press reaches one member. */}
                <KeyboardHereContext.Provider value={keyboardAbove && isFocused && !isHidden}>
                  <PaneProvider scope={{ paneId: `${paneId}:${key}`, view: { kind: 'conversation', session: key }, sessionKey: key }}>
                    {/* One tile alone on screen — expanded, or the narrow
                        room's one tab — keeps its own composer; on a grid of
                        two or more, one composer below speaks for them all. */}
                    <Conversation {...conversationProps} header={false} composer={shown.shown.length < 2} />
                    <Approvals />
                  </PaneProvider>
                </KeyboardHereContext.Provider>
              </div>
            </section>
          )
        })}
        {seams.map((seam) => (
          <Separator key={seam.key} orientation={seam.orientation} style={seam.style} />
        ))}
      </div>
    </div>
  )
}
