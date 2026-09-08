import { useSnapshot, useStore } from '../state/context'
import { ArrowLeftIcon, ArrowRightIcon, SidebarIcon } from './Icons'
import styles from './WindowControls.module.css'

/**
 * The three controls that live on the title-bar row, beside the traffic
 * lights, the way Claude Code and Codex place them: toggle the sidebar, and
 * step back and forward through what the middle has shown — a conversation or
 * a room, because those are the two things it can be and losing either is
 * losing your place. Rendered by the
 * sidebar while it is open and by the conversation header while it is not,
 * so the controls never leave the row the eye expects them on.
 */
export const WindowControls = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const collapsed = snapshot.sidebarCollapsed
  return (
    <span className={styles.group}>
      <button
        type="button"
        className={`${styles.button} hd-no-drag`}
        onClick={() => store.toggleSidebar()}
        title={collapsed ? 'Show the sidebar' : 'Hide the sidebar'}
        aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
      >
        <SidebarIcon size={14} />
      </button>
      <button
        type="button"
        className={`${styles.button} hd-no-drag`}
        disabled={!snapshot.navCanBack}
        onClick={() => void store.navigateBack()}
        title="Back"
        aria-label="Back"
      >
        <ArrowLeftIcon size={13} />
      </button>
      <button
        type="button"
        className={`${styles.button} hd-no-drag`}
        disabled={!snapshot.navCanForward}
        onClick={() => void store.navigateForward()}
        title="Forward"
        aria-label="Forward"
      >
        <ArrowRightIcon size={13} />
      </button>
    </span>
  )
}
