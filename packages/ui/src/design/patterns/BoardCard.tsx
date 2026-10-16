import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { Button } from '../ui/button'
import { Card } from '../ui/card'
import { Text } from './Settings'
import { FlagIcon } from '../../components/Icons'
import styles from './BoardCard.module.css'

type ContentProps = Omit<ComponentPropsWithoutRef<'span'>, 'children' | 'className'> & {
 readonly [attribute: `data-${string}`]: string | number | boolean | undefined
}

/** A compact opening card, exported publicly as CompactBoardCard: identity,
 * optional attention detail, middle and footer.
 * Title and detail props preserve a caller's hover text, slots and description ids.
 * Supply aria-describedby for the detail and any facts inside the footer slot. */
export const BoardCard = ({label,title,titleAside,titleProps,detail,detailProps,attention=false,onOpen,middle,footer,...props}: {
 readonly label:string; readonly title:ReactNode; readonly titleAside?:ReactNode; readonly titleProps?:ContentProps
 readonly detail?:ReactNode; readonly detailProps?:ContentProps; readonly attention?:boolean; readonly onOpen:()=>void
 readonly middle?:ReactNode; readonly footer?:ReactNode; readonly 'aria-describedby'?:string
 readonly [attribute: `data-${string}`]: string | number | boolean | undefined
}) => <Button variant="ghost" size="pattern" render={<Card as="button" spacing="compact"/>} {...props} className={styles.card} aria-label={label} onClick={onOpen}>
 <span {...titleProps} className={styles.identity}><Text role="member" truncate>{title}</Text>{titleAside}</span>
 {detail != null && <span {...detailProps}><Text role="muted" ink="muted" tone={attention?'warning':undefined} className={styles.summary}>{attention && <FlagIcon/>}{detail}</Text></span>}
 {middle}
 {footer != null && <span className={styles.footer}>{footer}</span>}
</Button>
