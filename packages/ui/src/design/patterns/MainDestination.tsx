// packages/ui/src/design/patterns/MainDestination.tsx
import type { ReactNode } from 'react'
import styles from './MainDestination.module.css'
/** Keep work and visited pages mounted; only the active main layer is interactive. */
export const MainDestination = ({ page, work, pages }: {
  readonly page: boolean; readonly work: ReactNode; readonly pages?: ReactNode
}) => <div data-slot="main-destinations" className={styles.root}>
  <div data-slot="retained-work" hidden={page} inert={page} className={styles.work}>{work}</div>
  <div data-slot="destination-pages" hidden={!page} inert={!page} className={styles.pages}>{pages}</div>
</div>
/** Each visited page owns one scroll element for the current project. */
export const DestinationBody = ({ active, id, children }: {
  readonly active: boolean; readonly id: string; readonly children: ReactNode
}) => <div data-page-destination={id} hidden={!active} inert={!active} data-slot="destination-scroll" className={styles.body}>{children}</div>
