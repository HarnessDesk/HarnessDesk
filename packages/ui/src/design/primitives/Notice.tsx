import type { ReactNode } from 'react'
import { Button } from '../ui/button'
import { NoticeHost, NoticeListShell, NoticeShell, type BannerTone } from './Banner'

/** Content only: hosts own size and placement, the notice owns presentation. */
export type NoticeAction = {
  readonly label: string
  readonly onSelect: () => void
  readonly kind?: 'primary' | 'secondary' | 'ghost' | 'icon'
}
export type NoticeProps = {
  tone?: BannerTone
  title?: ReactNode
  children?: ReactNode
  actions?: readonly NoticeAction[]
  onDismiss?: () => void
  onMute?: () => void
  mark?: ReactNode
}

const NoticeContent = ({ actions, tone = 'neutral', ...props }: NoticeProps, kind: 'card' | 'status' | 'row') => (
  <NoticeShell {...props} tone={tone} kind={kind} role={tone === 'danger' ? 'alert' : 'status'} actions={actions?.map((action, index) => (
    <Button key={index} type="button" size={action.kind === 'icon' ? 'icon-sm' : 'sm'}
      variant={action.kind === 'ghost' || action.kind === 'icon' ? 'ghost' : action.kind === 'primary' ? 'default' : 'secondary'}
      aria-label={action.kind === 'icon' ? action.label : undefined} onClick={action.onSelect}>
      {action.label}
    </Button>
  ))} />
)

/** A fact, optional earned detail, and the actions it calls for. */
export const Notice = (props: NoticeProps) => NoticeContent(props, 'card')
/** Quiet status in the same tile, copy and control layout. */
export const NoticeStatus = (props: NoticeProps) => NoticeContent(props, 'status')
/** A row in a compact notice panel. */
export const NoticeRow = (props: NoticeProps) => NoticeContent(props, 'row')
/** The shared plate for Inbox or queued-message rows; placement stays with its host. */
export const NoticeList = NoticeListShell
export { NoticeHost }
