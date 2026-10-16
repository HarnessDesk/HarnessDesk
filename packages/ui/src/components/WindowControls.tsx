import { useSnapshot, useStore } from '../state/context'
import { sidebarPlacement } from '../state/workbench'
import { Button } from '../design'
import { useSidebarHistory } from '../lib/use-sidebar-history'
import { ArrowLeftIcon, ArrowRightIcon, SidebarIcon } from './Icons'
import styles from './WindowControls.module.css'

/**
 * The controls that live on the title-bar row, beside the traffic lights:
 * toggle the sidebar, and step back and forward through what the middle has
 * shown — a conversation or a room, because those are the two things it can be
 * and losing either is losing your place. Rendered by the sidebar while it
 * stands as a column, and by the header of whatever the middle shows while it
 * does not — put away, or floating over a narrow window — so the controls
 * never leave the row the eye expects them on.
 *
 * When the standing sidebar's own history folds, main carries the arrows alone.
 */
export const WindowControls = ({ sidebarRow = false, history = true }: { sidebarRow?: boolean; history?: boolean } = {}) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const settings = snapshot.workbench.navigation.current.kind === 'settings'
  const placement = sidebarPlacement(snapshot)
  const shown = placement !== 'away'
  const historyInMain = useSidebarHistory(placement === 'column', settings)
  if (!sidebarRow && placement === 'column' && !historyInMain) return null
  const historyOnly = !sidebarRow && placement === 'column'
  const navigation = history && !settings
  return (
    <span className={styles.group}>
      {!historyOnly && <Button
        variant="ghost" size="icon-sm" className={`${styles.button} hd-no-drag`}
        onClick={() => store.toggleSidebar()}
        title={shown ? 'Hide the sidebar' : 'Show the sidebar'}
        aria-label={shown ? 'Hide sidebar' : 'Show sidebar'}
      >
        <SidebarIcon size={14} />
      </Button>}
      {navigation && <span>
        <Button
          variant="ghost" size="icon-sm" className={`${styles.button} hd-no-drag`}
          disabled={!snapshot.navCanBack}
          onClick={() => void store.navigateBack()}
          title="Back"
          aria-label="Back"
        >
          <ArrowLeftIcon size={13} />
        </Button>
      </span>}
      {navigation && <span>
        <Button
          variant="ghost" size="icon-sm" className={`${styles.button} hd-no-drag`}
          disabled={!snapshot.navCanForward}
          onClick={() => void store.navigateForward()}
          title="Forward"
          aria-label="Forward"
        >
          <ArrowRightIcon size={13} />
        </Button>
      </span>}
    </span>
  )
}
