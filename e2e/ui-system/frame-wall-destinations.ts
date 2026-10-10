/**
 * What the frame wall captures (docs/superpowers/plans/2026-10-09-app-frame.md,
 * "The visual check"). `tab` is a Team view's `data-team-page` value. A phase
 * that adds a destination adds it here, and the wall grows with it.
 */
export const WALL_DESTINATIONS = [
  { id: 'conversation', query: 'frame-wall=conversation' },
  { id: 'draft', query: 'frame-wall=draft' },
  { id: 'team-overview', query: 'frame-wall=team', tab: 'overview' },
  { id: 'team-run', query: 'frame-wall=team', tab: 'run' },
  { id: 'team-board', query: 'frame-wall=team', tab: 'board' },
  { id: 'team-chat', query: 'frame-wall=team', tab: 'room' },
  { id: 'team-findings', query: 'frame-wall=team', tab: 'findings' },
  { id: 'teams', query: 'frame-wall=teams' },
  { id: 'agents', query: 'frame-wall=agents' },
  { id: 'dashboard', query: 'frame-wall=dashboard' },
  { id: 'settings', query: 'frame-wall=settings' },
  { id: 'left-column-probe', query: 'frame-wall=left-column' },
  { id: 'conversation-left-open', query: 'frame-wall=conversation', leftOpen: true },
  { id: 'left-inbox', query: 'frame-wall=conversation', leftOpen: true, leftPopup: 'inbox' },
  { id: 'left-account', query: 'frame-wall=conversation', leftOpen: true, leftPopup: 'account' },
  { id: 'left-start', query: 'frame-wall=conversation', leftOpen: true, leftPopup: 'start' },
  { id: 'left-work', query: 'frame-wall=left-work', leftOpen: true },
  { id: 'left-project-menu', query: 'frame-wall=left-work', leftOpen: true, leftPopup: 'project' },
  { id: 'left-session-menu', query: 'frame-wall=left-work', leftOpen: true, leftPopup: 'session' },
  { id: 'left-session-card', query: 'frame-wall=left-work', leftOpen: true, leftPopup: 'card' },
  { id: 'left-work-pattern', query: 'frame-wall=left-work-pattern' },
  { id: 'settings-middle', query: 'frame-wall=settings-middle' },
  { id: 'settings-middle-filtered', query: 'frame-wall=settings-middle', settingsQuery: 'mute' },
  { id: 'settings-middle-empty', query: 'frame-wall=settings-middle', settingsQuery: 'no matching preference with a deliberately long search phrase' },
] as const

/** Wide (every region stands), between the folds, and the narrowest window. */
export const WALL_WIDTHS = [1440, 1100, 720] as const
export const WALL_THEMES = ['light', 'dark'] as const

/** The wall's clock: relative times read the same in every capture. */
export const WALL_TIME = new Date('2026-09-30T10:00:00-07:00')
