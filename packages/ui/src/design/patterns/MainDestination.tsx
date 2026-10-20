// packages/ui/src/design/patterns/MainDestination.tsx
import { useLayoutEffect, type ReactNode } from 'react'
import { dismissOverlays } from '../../lib/overlays'
import styles from './MainDestination.module.css'
/** Keep work and visited pages mounted; only the active main layer is interactive. */
export const MainDestination = ({ page, work, pages }: {
  readonly page: boolean; readonly work: ReactNode; readonly pages?: ReactNode
}) => {
  useLayoutEffect(() => { if (page) dismissOverlays() }, [page])
  return <div data-slot="main-destinations" className={styles.root}>
  <div data-slot="retained-work" {...(page ? { 'data-hidden': '' } : {})} inert={page} className={styles.work}>{work}</div>
  <div data-slot="destination-pages" hidden={!page} inert={!page} className={styles.pages}>{pages}</div>
</div>
}
/** Each visited page owns one scroll element for the current project. */
export const DestinationBody = ({ active, id, stableGutter = false, children }: {
  readonly active: boolean; readonly id: string; readonly children: ReactNode
  /** Keep a reading column in place when its pages alternate between short and scrolling content. */
  readonly stableGutter?: boolean
}) => <div role="region" aria-label={id === 'changes-review' ? 'Changes review' : id.charAt(0).toUpperCase() + id.slice(1)} data-page-destination={id} hidden={!active} inert={!active} data-slot="destination-scroll" {...(stableGutter ? { 'data-stable-gutter': '' } : {})} className={styles.body}>{children}</div>
