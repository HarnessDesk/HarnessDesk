import { useSnapshot, useStore } from '../state/context'
import { sidebarPlacement } from '../state/workbench'
import { ArrowLeftIcon, ArrowRightIcon, SidebarIcon } from './Icons'
import styles from './WindowControls.module.css'

/**
 * The three controls that live on the title-bar row, beside the traffic
 * lights, the way Claude Code and Codex place them: toggle the sidebar, and
 * step back and forward through what the middle has shown — a conversation or
 * a room, because those are the two things it can be and losing either is
 * losing your place. Rendered by the sidebar while it stands as a column, and
 * by the header of whatever the middle shows while it does not — put away, or
 * floating over a narrow window — so the controls never leave the row the eye
 * expects them on.
 *
 * A narrow header keeps the toggle and folds the arrows (see the stylesheet):
 * the arrows are on the sidebar's own row as well, and the toggle is the one
 * press that reaches it.
 */
export const WindowControls = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const shown = sidebarPlacement(snapshot) !== 'away'
  return (
    <span className={styles.group}>
      <button
        type="button"
        className={`${styles.button} hd-no-drag`}
        onClick={() => store.toggleSidebar()}
        title={shown ? 'Hide the sidebar' : 'Show the sidebar'}
        aria-label={shown ? 'Hide sidebar' : 'Show sidebar'}
      >
        <SidebarIcon size={14} />
      </button>
      <button
        type="button"
        className={`${styles.button} ${styles.nav} hd-no-drag`}
        disabled={!snapshot.navCanBack}
        onClick={() => void store.navigateBack()}
        title="Back"
        aria-label="Back"
      >
        <ArrowLeftIcon size={13} />
      </button>
      <button
        type="button"
        className={`${styles.button} ${styles.nav} hd-no-drag`}
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
