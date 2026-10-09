import { useCallback, useContext, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import type { SessionKey, Turn } from '@harnessdesk/protocol'

import {
  columnsThatFit,
  displayFor,
  expandTile,
  focusIndex,
  focusTile,
  pinTile,
  removeTile,
  SEAM_WIDTH,
  setTileMode,
  type SideBySideState,
} from '../lib/side-by-side'
import { KeyboardHereContext, PaneProvider, useIsFocusedPane } from '../state/context'
import { Approvals } from './Approvals'
import type { SeatCeilingShown } from '../lib/ceilings'
import { BrandMark } from './BrandIcons'
import { CeilingChip } from './CeilingChip'
import { Conversation } from './Conversation'
import { SeatBrowser } from './SeatBrowser'
import {
  AgentIcon,
  MoreIcon,
  GlobeIcon,
  CommentIcon,
} from './Icons'
import {
  Bar,
  Button,
  Chip,
  ComposerDock,
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
  useComposerHeightVar,
  PaneColumn,
} from '../design'
import styles from './SideBySide.module.css'

/** What a tile's header reads about its member. The room supplies it. */
export type TileEntry = {
  readonly label?: string
  readonly tint?: ComponentProps<typeof IconTile>['tint']
  readonly brand?: ComponentProps<typeof BrandMark>['brand'] | null
  readonly busy?: boolean
  readonly waitingForYou?: boolean
  /** A user message is waiting behind this member's current turn. */
  readonly queued?: boolean
  /** How its last turn ended, while it is neither working nor waiting: done, or stopped short. */
  readonly ended?: 'done' | 'stopped'
  /** The Run's recorded outcome for this competitor, independent of its conversation state. */
  readonly keep?: 'kept' | 'not-kept' | null
  /** What it may do unasked, when held under a ceiling — the safety fact the conversation's own header carried. */
  readonly ceiling?: SeatCeilingShown | null
}

/** Resolve the room facts into the entry the shipped tile draws. */
export const sideBySideTileEntry = (
  entry: Pick<TileEntry, 'tint' | 'brand' | 'busy' | 'waitingForYou' | 'queued' | 'ceiling' | 'keep' | 'label'> & {
    readonly lastTurnStatus?: Turn['status']
  },
): TileEntry => ({
  label: entry.label,
  tint: entry.tint,
  brand: entry.brand,
  busy: entry.busy,
  waitingForYou: entry.waitingForYou,
  queued: entry.queued,
  ceiling: entry.ceiling,
  keep: entry.keep,
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
  notice,
  composer,
  decision,
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
  notice?: React.ReactNode
  /** The comparison decision clears tile content together with the shared dock. */
  decision?: ReactNode
  /** The room's shared composer addresses exactly the members displayed by the grid. */
  composer?: (shown: readonly SessionKey[]) => ReactNode
  /**
   * Wraps a tile's identity — its mark, name and model — in whatever card the
   * caller hangs on a member (the room's member hover card). Passed in so the
   * grid knows nothing of the room that holds it.
   */
  card?: (key: SessionKey, who: React.ReactNode) => React.ReactNode
}) => {
  const gridRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  /* The dock ref stays mounted even with one tile showing, so the system's
     observer sees it appear, disappear and grow with all its notices. */
  const composerRef = useComposerHeightVar(gridRef)
  const [width, setWidth] = useState(0)
  const [room, setRoom] = useState({ height: 0, dock: 0, browserTile: 0 })
  const [composing, setComposing] = useState(false)
  const focusedPane = useIsFocusedPane()
  /* A tile never claims the keyboard that what encloses the grid says is
     elsewhere; it can only narrow it to one tile. */
  const keyboardAbove = useContext(KeyboardHereContext) !== false
  const fitting = displayFor(state, width)
  const fittingRows = Math.ceil(fitting.shown.length / fitting.columns)
  const shortBrowserGrid = fittingRows > 1 && fitting.shown.some(key => state.modes[key] === 'browser')
    && room.height > 0 && (room.height - (composer ? room.dock : 0) - SEAM_WIDTH) / fittingRows < room.browserTile
  const shown = shortBrowserGrid ? displayFor(state, 0) : fitting
  const sharedComposer = composer !== undefined && shown.shown.length >= 2
  /* Tabs select a member when width or Browser height constrains the grid.
     An expanded tile in a narrow room also keeps the strip, so the member
     can still be switched without first pressing Esc. */
  const narrow = state.tiles.length > 1 && (columnsThatFit(width) < 2 || shortBrowserGrid)
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

  useLayoutEffect(() => {
    const grid = gridRef.current
    const dock = composerRef.current
    if (!grid || !dock) return
    const chromeRows = (): Element[][] => [...grid.querySelectorAll('[data-mode="browser"]')].map(body => {
      const bars = [...(body.querySelector('[data-slot="tool-pane"]')?.children ?? [])]
        .filter(child => child.getAttribute('data-slot') !== 'tool-pane-body')
      return body.previousElementSibling ? [body.previousElementSibling, ...bars] : bars
    })
    const measure = (): void => {
      const tokens = getComputedStyle(grid)
      // The embedded browser has a tile header, slim address bar and footer.
      // Keep a usable page below them even before its live surface mounts.
      const chrome = 2 * parseFloat(tokens.getPropertyValue('--hd-bar-h')) + parseFloat(tokens.getPropertyValue('--hd-control-h'))
      const browserTile = Math.max(chrome || 0, ...chromeRows().map(rows =>
        rows.reduce((height, row) => height + row.getBoundingClientRect().height, 0))) + 80
      setRoom(was => {
        // Hiding the shared dock for the fallback must not immediately bring
        // the cramped grid back. Retain its clearance until it is shown again.
        // The fallback's tabs disappear with it: count their space when
        // asking whether the two-row grid can return after chrome shrinks.
        const height = grid.getBoundingClientRect().height + (stripRef.current?.getBoundingClientRect().height ?? 0)
        const next = { height, dock: dock.hidden ? was.dock : dock.offsetHeight, browserTile }
        return next.height === was.height && next.dock === was.dock && next.browserTile === was.browserTile ? was : next
      })
    }
    measure()
    const gridObserver = new ResizeObserver(measure)
    const dockObserver = new ResizeObserver(measure)
    const chromeObserver = new ResizeObserver(measure)
    let observedChrome = new Set<Element>()
    const watchChrome = (): void => {
      const next = new Set(chromeRows().flat())
      let changed = false
      for (const row of observedChrome) if (!next.has(row)) { chromeObserver.unobserve(row); changed = true }
      for (const row of next) if (!observedChrome.has(row)) { chromeObserver.observe(row); changed = true }
      observedChrome = next
      if (changed) measure()
    }
    // Find and a late-mounted live Browser change chrome without resizing the
    // room or dock. Observe their rows, including rows added after this effect.
    watchChrome()
    const chromeMounts = new MutationObserver(watchChrome)
    chromeMounts.observe(grid, { childList: true, subtree: true })
    gridObserver.observe(grid)
    dockObserver.observe(dock)
    return () => { gridObserver.disconnect(); dockObserver.disconnect(); chromeObserver.disconnect(); chromeMounts.disconnect() }
  }, [composerRef, state.modes])

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

  const focus = useCallback((key: SessionKey) => onChange((was) => focusTile(was, key)), [onChange])
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
  // The bottom track includes the dock's clearance, leaving equal usable
  // tile heights instead of taking all that space from half-height tiles.
  const gridStyle = {
    gridTemplateColumns: track(columns),
    gridTemplateRows: sharedComposer && rows === 2
      ? 'minmax(0, calc((100% - var(--composer-h, 0px) - var(--hd-space-px)) / 2)) var(--hd-space-px) minmax(0, calc((100% + var(--composer-h, 0px) - var(--hd-space-px)) / 2))'
      : track(rows),
  } as CSSProperties
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
      {notice}
      {!sharedComposer && decision && <PaneColumn inset="bars">{decision}</PaneColumn>}
      {/* One tile at a time when the room cannot fit the grid: the system's
          tabs pick which, with their arrow keys and roving focus. */}
      {narrow && (
        <div ref={stripRef} className={styles.strip}>
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
          const letter = entry?.label ?? String.fromCharCode(65 + state.tiles.indexOf(key))
          const nickname = member?.nickname ?? 'Member'
          const isFocused = state.focused === key
          const isExpanded = state.expanded === key
          const isHidden = !shown.shown.includes(key)
          const clearsComposer = sharedComposer && !isHidden && Math.floor(shown.shown.indexOf(key) / columns) === rows - 1
          const model = member?.model
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
              onFocusCapture={() => { setComposing(false); focus(key) }}
            >
              <Bar as="header" rule="bottom" active={isFocused && shown.shown.length > 1} className={styles.header}>
                <Chip tone={(letter.charCodeAt(0) - 65) % 2 ? 'info' : 'brand'} size="sm" title={`Attempt ${letter}`}>{letter}</Chip>
                {card(key, (
                  <span className={styles.member}>
                    <span className={styles.mark}>
                      <IconTile size="sm" shape="face" tint={entry?.tint ?? 'blue'}>
                        {entry?.brand ? <BrandMark brand={entry.brand} size={13} /> : <AgentIcon />}
                      </IconTile>
                    </span>
                    <Text role="row" className={styles.nickname} truncate title={member?.agent ?? nickname}>{member?.agent ?? nickname}</Text>
                    {model && <Text role="meta" className={styles.model} truncate>{model}</Text>}
                  </span>
                ))}
                {(entry?.waitingForYou || entry?.busy || entry?.ended) && <span className={styles.state}>
                  <Dot tone={entry.waitingForYou ? 'warning' : entry.busy ? 'success' : 'neutral'} pulse={entry.busy && !entry.waitingForYou} aria-hidden />
                  <Text role="meta">{entry.waitingForYou ? 'Waiting' : entry.busy ? 'Working' : entry.ended === 'done' ? 'Done' : 'Stopped'}</Text>
                </span>}
                {entry?.keep && <Chip tone={entry.keep === 'kept' ? 'success' : 'neutral'} size="sm">{entry.keep === 'kept' ? 'Picked' : 'Not kept'}</Chip>}
                {entry?.ceiling && <CeilingChip ceiling={entry.ceiling.ceiling} note={entry.ceiling.note} />}
                {entry?.queued && <Chip tone="neutral" size="sm" title="Queued — next after this turn">Queued</Chip>}
                <span className={styles.view}><Button type="button" variant="ghost" size="icon-sm"
                  aria-label={state.modes[key] === 'browser' ? 'Back to the conversation' : 'Show the browser'}
                  title={state.modes[key] === 'browser' ? 'Conversation' : 'Browser'}
                  onClick={event => {
                    event.stopPropagation()
                    onChange(was => setTileMode(focusTile(was, key), key, was.modes[key] === 'browser' ? 'conversation' : 'browser'))
                  }}>
                  {state.modes[key] === 'browser' ? <CommentIcon size={14} /> : <GlobeIcon size={14} />}
                </Button></span>
                <DropdownMenu>
                  <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label={`${nickname} actions`} title="Tile actions"><MoreIcon size={14} /></Button>} />
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${nickname}`} onClick={event => {
                      event.stopPropagation()
                      onChange(was => expandTile(was, isExpanded ? null : key))
                    }}>{isExpanded ? 'Return to the grid' : 'Expand tile'}</DropdownMenuItem>
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
              <div className={styles.body} data-mode={state.modes[key] ?? 'conversation'} {...(clearsComposer ? { 'data-clear-composer': '' } : {})}>
                {/* One tile has the keyboard. The others read as unfocused
                    panes to everything inside them — their composers take
                    no compose events, their approvals answer no keys and
                    take no focus — so one press reaches one member. */}
                <KeyboardHereContext.Provider value={keyboardAbove && isFocused && !isHidden && !(sharedComposer && composing)}>
                  <PaneProvider scope={{ paneId: `${paneId}:${key}`, view: { kind: 'conversation', session: key }, sessionKey: key }}>
                    {/* One tile alone on screen — expanded, or the narrow
                        room's one tab — keeps its own composer; on a grid of
                        two or more, one composer below speaks for them all. */}
                    {state.modes[key] === 'browser' ? (
                      <SeatBrowser paneId={paneId} session={key} onFocus={focus} />
                    ) : (
                      <>
                        <Conversation {...conversationProps} header={false} composer={shown.shown.length < 2} />
                        <Approvals />
                      </>
                    )}
                  </PaneProvider>
                </KeyboardHereContext.Provider>
              </div>
            </section>
          )
        })}
        {seams.map((seam) => (
          <Separator key={seam.key} orientation={seam.orientation} style={seam.style} />
        ))}
        <ComposerDock floating ref={composerRef} data-shared-composer="" data-decision={decision ? '' : undefined} hidden={!sharedComposer} className={styles.dock} onFocusCapture={() => setComposing(true)}>
          {sharedComposer && composer && (
            <ComposerDock>
              <div className={styles.composer}>{decision}{composer(shown.shown)}</div>
            </ComposerDock>
          )}
        </ComposerDock>
      </div>
    </div>
  )
}
