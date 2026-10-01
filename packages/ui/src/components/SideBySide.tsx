import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties } from 'react'
import type { SessionKey } from '@harnessdesk/protocol'

import {
  displayFor,
  expandTile,
  focusIndex,
  focusTile,
  pinTile,
  removeTile,
  type SideBySideState,
} from '../lib/side-by-side'
import { PaneProvider, useIsFocusedPane } from '../state/context'
import { Approvals } from './Approvals'
import { BrandMark } from './BrandIcons'
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
}
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
  onChange: (next: SideBySideState) => void
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
  const shown = displayFor(state, width)
  const narrow = shown.layout === 'single' && state.expanded === null

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
    if (!focusedPane) return
    const onCommand = (event: Event): void => {
      const action = (event as CustomEvent<string>).detail
      if (action === 'tile-1' || action === 'tile-2' || action === 'tile-3' || action === 'tile-4') {
        onChange(focusIndex(state, Number(action.slice(-1)) - 1))
      } else if (action === 'tile-expand' && state.focused) {
        onChange(expandTile(state, state.expanded === state.focused ? null : state.focused))
      }
    }
    window.addEventListener('hd-side-by-side', onCommand)
    return () => window.removeEventListener('hd-side-by-side', onCommand)
  }, [focusedPane, onChange, state])

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape' && !event.defaultPrevented && state.expanded) {
      event.preventDefault()
      onChange(expandTile(state, null))
    }
  }, [onChange, state])

  const focus = (key: SessionKey) => onChange(focusTile(state, key))
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
                <TabsTrigger key={key} value={key}>{memberOf(key)?.nickname ?? 'Member'}</TabsTrigger>
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
              className={styles.tile}
              style={place(key)}
              onClick={() => focus(key)}
              onKeyDown={onKeyDown}
            >
              <Bar as="header" rule="bottom" active={isFocused && shown.shown.length > 1} className={styles.header}>
                {card(key, (
                  <span className={styles.member}>
                    <span className={styles.mark}>
                      <IconTile size="sm" tint={entry?.tint ?? 'blue'}>
                        {entry?.brand ? <BrandMark brand={entry.brand} size={13} /> : <AgentIcon />}
                      </IconTile>
                      {entry?.busy && <Dot state="ready" variant="presence" pulse aria-hidden />}
                    </span>
                    <Text role="row" className={styles.nickname}>{nickname}</Text>
                    {model && <Text role="meta" className={styles.model} truncate>{model}</Text>}
                  </span>
                ))}
                {entry?.busy ? <Chip state="ready" size="sm">Working</Chip> : entry?.waitingForYou ? <Chip tone="warning" size="sm">Waiting for you</Chip> : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${nickname}`}
                  aria-pressed={isExpanded}
                  title={isExpanded ? 'Return to the grid' : 'Expand tile'}
                  onClick={(event) => {
                    event.stopPropagation()
                    onChange(expandTile(state, isExpanded ? null : key))
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
                      onChange(pinTile(state, key, !state.pinned.includes(key)))
                    }}>
                      {state.pinned.includes(key) ? 'Unpin' : 'Pin to the grid'}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={(event) => { event.stopPropagation(); onChange(removeTile(state, key)) }}>Take off the grid</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </Bar>
              <div className={styles.body}>
                <PaneProvider scope={{ paneId: `${paneId}:${key}`, view: { kind: 'conversation', session: key }, sessionKey: key }}>
                  <Conversation {...conversationProps} />
                  <Approvals />
                </PaneProvider>
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
