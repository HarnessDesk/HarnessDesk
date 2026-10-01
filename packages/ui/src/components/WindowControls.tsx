import { useSnapshot, useStore } from '../state/context'
import { dockViews, sidebarPlacement } from '../state/workbench'
import { Badge, Button } from '../design'
import { ArrowLeftIcon, ArrowRightIcon, PanelIcon, SidebarIcon } from './Icons'
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
 * While the right panel holds views there is a fourth: show or hide it. Put
 * away, the panel left nothing on screen to say it was still there, so the
 * toggle carries how many views wait behind it.
 *
 * A narrow header keeps the toggle and folds the arrows (see the stylesheet):
 * the arrows are on the sidebar's own row as well, and the toggle is the one
 * press that reaches it.
 */
export const WindowControls = () => {
  const store = useStore()
  const snapshot = useSnapshot()
  const shown = sidebarPlacement(snapshot) !== 'away'
  const rightViews = dockViews(snapshot.workbench.right).length
  const rightPanelPutAway = snapshot.workbench.right.collapsed
  const rightPanelLabel = rightPanelPutAway
    ? `Show the right panel — ${rightViews} ${rightViews === 1 ? 'view' : 'views'}`
    : 'Hide the right panel'
  return (
    <span className={styles.group}>
      <Button
        variant="ghost" size="icon-sm" className={`${styles.button} hd-no-drag`}
        onClick={() => store.toggleSidebar()}
        title={shown ? 'Hide the sidebar' : 'Show the sidebar'}
        aria-label={shown ? 'Hide sidebar' : 'Show sidebar'}
      >
        <SidebarIcon size={14} />
      </Button>
      {rightViews > 0 && (
        <Button
          variant="ghost" size="icon-sm" className={`${styles.button} hd-no-drag`}
          onClick={() => store.togglePanel('right')}
          title={rightPanelLabel}
          aria-label={rightPanelLabel}
        >
          <span className="relative inline-flex">
            <PanelIcon size={14} />
            {rightPanelPutAway && (
              <Badge variant="secondary" className="absolute -top-1 -right-1 min-w-4">
                {rightViews}
              </Badge>
            )}
          </span>
        </Button>
      )}
      <span className={styles.nav}>
        <Button
          variant="ghost" size="icon-sm" className={`${styles.button} hd-no-drag`}
          disabled={!snapshot.navCanBack}
          onClick={() => void store.navigateBack()}
          title="Back"
          aria-label="Back"
        >
          <ArrowLeftIcon size={13} />
        </Button>
      </span>
      <span className={styles.nav}>
        <Button
          variant="ghost" size="icon-sm" className={`${styles.button} hd-no-drag`}
          disabled={!snapshot.navCanForward}
          onClick={() => void store.navigateForward()}
          title="Forward"
          aria-label="Forward"
        >
          <ArrowRightIcon size={13} />
        </Button>
      </span>
    </span>
  )
}
