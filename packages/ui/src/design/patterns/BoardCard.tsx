import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { useId } from 'react'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Text } from './Settings'
import { FlagIcon } from '../../components/Icons'
import styles from './BoardCard.module.css'

type ContentProps = Omit<ComponentPropsWithoutRef<'span'>, 'children' | 'className'> & {
 readonly [attribute: `data-${string}`]: string | number | boolean | undefined
}

export interface BoardCardMark {
 readonly id: string; readonly title: string; readonly mark: ReactNode; readonly active: boolean; readonly attention?: boolean
 readonly props?: ContentProps
}

/** A compact opening card, exported publicly as CompactBoardCard: identity,
 * optional attention detail, middle and footer.
 * Title and detail props preserve a caller's hover text, slots and description ids.
 * Optional marks retain presence and attention independently and describe the card; a finding owns its flag.
 * detailLines bounds a catalogue description without truncating the finding.
 * Supply aria-describedby for the detail and any facts inside the footer slot. */
export const BoardCard = ({label,title,titleAside,titleProps,detail,detailProps,detailLines,marks,finding,attention=false,onOpen,middle,footer,...props}: {
 readonly label:string; readonly title:ReactNode; readonly titleAside?:ReactNode; readonly titleProps?:ContentProps
 readonly detail?:ReactNode; readonly detailProps?:ContentProps; readonly attention?:boolean; readonly onOpen:()=>void
 readonly detailLines?:2; readonly marks?:{ readonly label:string; readonly items:readonly BoardCardMark[] }
 readonly finding?:{ readonly text:ReactNode; readonly tone:'warn'|'quiet'; readonly id?:string }
 readonly middle?:ReactNode; readonly footer?:ReactNode; readonly 'aria-describedby'?:string
 readonly [attribute: `data-${string}`]: string | number | boolean | undefined
}) => {
 const marksId = useId()
 return <Button variant="ghost" size="pattern" render={<Card as="button" spacing="compact"/>} {...props} className={styles.card} aria-label={label} aria-describedby={[props['aria-describedby'], marks ? marksId : undefined].filter(Boolean).join(' ') || undefined} onClick={onOpen}>
 <span {...titleProps} className={styles.identity}><Text role="member" truncate>{title}</Text>{marks && <span id={marksId} className={styles.marks} role="img" aria-label={marks.label}>
  {marks.items.map(mark=><span key={mark.id} {...mark.props} title={mark.title} className={styles.mark} data-off={!mark.active || undefined} data-mark-active={mark.active} data-mark-attention={mark.attention || undefined}>{mark.mark}</span>)}
 </span>}{titleAside}</span>
 {detail != null && <span {...detailProps}><Text role="muted" ink="muted" tone={attention?'warning':undefined} className={styles.summary} data-detail-lines={detailLines}>{attention && <FlagIcon/>}{detail}</Text></span>}
 {finding && <Text id={finding.id} role="meta" ink={finding.tone==='quiet'?'muted':undefined} tone={finding.tone==='warn'?'warning':undefined} data-card-finding="" className={styles.finding}>{finding.tone==='warn' && <FlagIcon size={13}/>}{finding.text}</Text>}
 {middle}
 {footer != null && <span className={styles.footer}>{footer}</span>}
</Button>
}


/** Opening cards share a responsive grid that becomes one column within a narrow pane. */
export const BoardCardGrid = ({children, layout, ...props}: ComponentPropsWithoutRef<'div'> & { readonly layout?: 'catalogue' }) =>
 <div data-slot="board-card-grid" {...props} data-layout={layout} className={styles.grid}>{children}</div>
