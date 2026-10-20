/**
 * The fixed toolbar shared by every destination.
 *
 * More is conditional on the current page, view and fold: without an action
 * row there is no button and no empty menu. The shell recomputes it from the
 * current slots, so moving to a page with actions brings the door back.
 */
import { type ReactNode, type ComponentProps } from 'react'
import { Bar } from '../ui/bar'
import { Button } from '../ui/button'
import { Text } from './Settings'
import { hasMenuContent, Menu, MenuItem } from './Menu'
import { Popover } from './Popover'
import { ArrowRightIcon, MoreIcon, CaretIcon } from '../../components/Icons'
import styles from './TopBar.module.css'

export interface TopBarAction {
  readonly label: string
  readonly icon?: ReactNode
  readonly disabled?: string | false
  readonly run: () => void
}
export interface TopBarTab {
  readonly value: string
  readonly label: string
  readonly count?: number
  readonly disabled?: string | false
  readonly run: () => void
}
export interface TopBarProps {
  readonly lead?: ReactNode
  readonly parent?: { readonly label: string; readonly run: () => void }
  readonly parents?: readonly { readonly label: string; readonly run: () => void }[]
  readonly mark?: ReactNode
  readonly place: ReactNode
  /** The subject's own verbs: the title becomes a menu button with a ⌄. */
  readonly placeMenu?: (close: () => void) => ReactNode
  /** The whole name on hover, when `place` is a shortened one. */
  readonly placeTitle?: string
  readonly state?: ReactNode
  readonly tabs?: readonly TopBarTab[]
  readonly tab?: string
  readonly inspectFirst?: boolean
  readonly verb?: TopBarAction
  readonly view?: { readonly label?: string; readonly disabled?: string | false; readonly narrowed?: boolean; readonly content: (close: () => void) => ReactNode }
  readonly tools?: ReactNode
  /** Standing panel width; closed and floating panels reserve no column. */
  readonly rightColumnWidth?: number | string
  readonly more: (close: () => void) => ReactNode
  /** The surface has a working folder and can open its terminal. */
  readonly terminal?: boolean
  readonly extraMore?: readonly TopBarAction[]
  readonly corner?: boolean
}

/** Compatibility actions stay reachable while each screen moves its choices into its body. */
const moreRows = (props: TopBarProps) => (close: () => void) => <>
  {props.verb && <MenuItem icon={props.verb.icon ?? <ArrowRightIcon />} label={props.verb.label}
    disabled={props.verb.disabled} onSelect={() => { props.verb?.run(); close() }} />}
  {(props.parents ?? (props.parent ? [props.parent] : [])).map((one, index) => <MenuItem key={`${index}:${one.label}`}
    icon={<ArrowRightIcon />} label={one.label} onSelect={() => { one.run(); close() }} />)}
  {props.more(close)}
  {props.extraMore?.map(one => <MenuItem key={one.label} icon={one.icon ?? <ArrowRightIcon />} label={one.label}
    disabled={one.disabled} onSelect={() => { one.run(); close() }} />)}
</>

export const TopBar = (props: TopBarProps) => {
  const rows = moreRows(props)
  const hasMore = hasMenuContent(rows(() => {}))
  return <Bar as="header" data-content-inset="frame" corner={props.corner} className={`${styles.bar} hd-drag`}>
    <div data-slot="top-bar" data-fold="0" className={styles.row}>
      <div data-topbar="lead" className={styles.fixed}>{props.lead}</div>
      <div data-topbar="place" className={styles.place}>
        {props.state && <div data-topbar="state" className={styles.fixed}>{props.state}</div>}
        {props.place != null && <div data-topbar-title className={styles.title} title={props.placeTitle}>
          {props.placeMenu ? <Popover title={props.placeTitle} triggerVariant={{ variant: 'ghost', size: 'sm' }} icons="all"
            label={<span data-topbar-place-menu className={styles.placeMenu}><Text role="subject" truncate>{props.place}</Text><CaretIcon /></span>}>
            {close => <Menu close={close}>{props.placeMenu?.(close)}</Menu>}
          </Popover> : <Text role="subject" truncate>{props.place}</Text>}
        </div>}
      </div>
      <div data-topbar="spacer" className={styles.spacer} />
      <div data-topbar="tools" className={styles.fixed}>{props.tools}
        <div data-topbar="more" className={styles.fixed}>{hasMore && <Popover title="More" label={<MoreIcon />}
          triggerVariant={{ variant: 'ghost', size: 'icon-sm' }} icons="all">
          {close => <Menu close={close}>{rows(close)}</Menu>}
        </Popover>}</div>
      </div>
    </div>
  </Bar>
}

/** A fixed tool's 28px door with the drawing's small activity dot. */
export const TopBarToolButton = ({ attention = false, children, ...props }: ComponentProps<typeof Button> & { attention?: boolean }) =>
  <Button {...props} variant="ghost" size="icon-sm" className={styles.toolButton}>{children}
    {attention && <span data-slot="tool-dot" className={styles.dot} aria-hidden="true" />}
  </Button>
