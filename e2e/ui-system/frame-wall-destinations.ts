/**
 * What the frame wall captures (docs/superpowers/plans/2026-10-09-app-frame.md,
 * "The visual check"). `tab` is a Team view's `data-team-page` value. A phase
 * that adds a destination adds it here, and the wall grows with it.
 */
import type { FrameActions } from './frame-actions'

import type { WallActions } from './frame-wall-actions'

export interface WallDestination extends FrameActions, WallActions { readonly id: string; readonly query: string; readonly leftWidth?: number; readonly leftOpen?: boolean; readonly leftPopup?: string; readonly settingsQuery?: string; readonly surface?: 'pattern' }

export const WALL_DESTINATIONS: readonly WallDestination[] = [
  { id: 'popup-composer-model', query: 'frame-wall=conversation', composerModel: true },
  { id: 'popup-topbar-view', query: 'frame-wall=team', tab: 'findings', topbarPopup: 'view' },
  { id: 'popup-folded-tabs', query: 'frame-wall=team', tab: 'findings', topbarPopup: 'tabs' },
  { id: 'popup-dropdown-none', query: 'frame-wall=conversation&popup=dropdown-none', popup: 'Frame dropdown' },
  { id: 'popup-dropdown-icons', query: 'frame-wall=conversation&popup=dropdown-icons', popup: 'Frame dropdown' },
  { id: 'topbar-probe', surface: 'pattern', query: 'frame-wall=topbar' },
  { id: 'conversation', query: 'frame-wall=conversation' },
  { id: 'conversation-seat-usage', query: 'frame-wall=conversation', leftOpen: true, leftPopup: 'usage' },
  { id: 'conversation-more-terminal', query: 'frame-wall=conversation', popup: 'More' },
  { id: 'conversation-update', query: 'frame-wall=conversation&frame-update=1' },
  { id: 'conversation-disconnected', query: 'frame-wall=conversation&frame-status=closed' },
  { id: 'conversation-status-tasks', query: 'frame-wall=conversation&frame-status=tasks' },
  { id: 'team-status-reconnecting', query: 'frame-wall=team&frame-status=reconnecting' },
  { id: 'conversation-tasks', query: 'frame-wall=conversation&frame-tool=tasks' },
  { id: 'conversation-changes', query: 'frame-wall=conversation', tool: 'changes' },
  { id: 'conversation-activity', query: 'frame-wall=conversation', tool: 'activity' },
  { id: 'conversation-browser', query: 'frame-wall=conversation', tool: 'browser' },
  { id: 'conversation-file', query: 'frame-wall=conversation&frame-tool=file&frame-tool-path=%2Frepo%2FREADME.md' },
  { id: 'conversation-preview', query: 'frame-wall=conversation&frame-tool=preview&frame-tool-path=%2Frepo%2Fpreview.html' },
  { id: 'conversation-git', query: 'frame-wall=conversation&frame-tool=git' },
  { id: 'conversation-plugin', query: 'frame-wall=conversation&frame-tool=plugin' },
  { id: 'team-changes', query: 'frame-wall=team&frame-work-range=1', tool: 'changes' },
  { id: 'plugin-unavailable', query: 'frame-wall=conversation&frame-tool=plugin-unavailable' },
  { id: 'conversation-terminal', query: 'frame-wall=conversation&frame-terminal=1' },
  { id: 'draft', query: 'frame-wall=draft' },
  { id: 'conversation-details', query: 'frame-wall=conversation', tool: 'details' },
  { id: 'draft-details', query: 'frame-wall=draft', tool: 'details' },
  { id: 'draft-browser', query: 'frame-wall=draft', tool: 'browser' },
  { id: 'team-details', query: 'frame-wall=team', tool: 'details' },
  { id: 'team-chat-side-by-side', query: 'frame-wall=team', tab: 'room', viewChoice: 'Side by side' },
  { id: 'team-chat-holding', query: 'frame-wall=team', tab: 'room', holdMessages: true },
  { id: 'team-runs', query: 'frame-wall=team-trigger', tab: 'runs' },
  { id: 'team-receipt', query: 'frame-wall=team-receipt', tab: 'receipt' },
  { id: 'team-overview', query: 'frame-wall=team', tab: 'overview' },
  { id: 'team-overview-panel-open', query: 'frame-wall=team', tab: 'overview', tool: 'details' },
  { id: 'team-board-panel-open', query: 'frame-wall=team', tab: 'board', tool: 'details' },
  { id: 'team-chat-panel-open', query: 'frame-wall=team', tab: 'room', tool: 'details' },
  { id: 'team-findings-panel-open', query: 'frame-wall=team', tab: 'findings', tool: 'details' },
  { id: 'team-run-panel-open', query: 'frame-wall=team-run-recorded', tab: 'run', tool: 'details' },
  { id: 'team-run', query: 'frame-wall=team', tab: 'run' },
  { id: 'team-run-flow', query: 'frame-wall=team-run-recorded', tab: 'run', viewChoice: 'Flow' },
  { id: 'team-run-details', query: 'frame-wall=team-run-recorded', tab: 'run', inspectFirst: true },
  { id: 'team-run-not-reached', query: 'frame-wall=team-run-not-reached', tab: 'run' },
  { id: 'team-run-repeated', query: 'frame-wall=team-run-repeated', tab: 'run' },
  { id: 'team-run-equivalent', query: 'frame-wall=team-run-equivalent', tab: 'run' },
  { id: 'team-board', query: 'frame-wall=team', tab: 'board' },
  { id: 'team-board-list', query: 'frame-wall=team', tab: 'board', viewChoice: 'List' },
  { id: 'team-findings-open', query: 'frame-wall=team', tab: 'findings', viewChoice: 'Open' },
  { id: 'team-findings-blocking', query: 'frame-wall=team', tab: 'findings', viewChoice: 'Blocking' },
  { id: 'team-runs-filtered', query: 'frame-wall=team-trigger', tab: 'runs', viewChoice: 'Running' },
  { id: 'team-chat', query: 'frame-wall=team', tab: 'room' },
  { id: 'team-findings', query: 'frame-wall=team', tab: 'findings' },
  { id: 'teams', query: 'frame-wall=teams' },
  { id: 'agents', query: 'frame-wall=agents' },
  { id: 'agent', query: 'frame-wall=agent' },
  { id: 'dashboard', query: 'frame-wall=dashboard' },
  { id: 'settings', query: 'frame-wall=settings' },
  { id: 'left-column-probe', surface: 'pattern', query: 'frame-wall=left-column' },
  { id: 'conversation-left-open', query: 'frame-wall=conversation', leftOpen: true },
  { id: 'left-inbox', query: 'frame-wall=conversation', leftOpen: true, leftPopup: 'inbox' },
  { id: 'left-account', query: 'frame-wall=conversation', leftOpen: true, leftPopup: 'account' },
  { id: 'left-start', query: 'frame-wall=conversation', leftOpen: true, leftPopup: 'start' },
  { id: 'left-work', query: 'frame-wall=left-work', leftOpen: true },
  { id: 'left-project-menu', query: 'frame-wall=left-work', leftOpen: true, leftPopup: 'project' },
  { id: 'left-session-menu', query: 'frame-wall=left-work', leftOpen: true, leftPopup: 'session' },
  { id: 'left-session-card', query: 'frame-wall=left-work', leftOpen: true, leftPopup: 'card' },
  { id: 'left-work-pattern', surface: 'pattern', query: 'frame-wall=left-work-pattern' },
  { id: 'settings-middle', surface: 'pattern', query: 'frame-wall=settings-middle' },
  { id: 'settings-middle-filtered', surface: 'pattern', query: 'frame-wall=settings-middle', settingsQuery: 'mute' },
  { id: 'settings-middle-empty', surface: 'pattern', query: 'frame-wall=settings-middle', settingsQuery: 'no matching preference with a deliberately long search phrase' },
  { id: 'popup-menu-icons', query: 'frame-wall=conversation&popup=menu-icons', popup: 'Frame menu' },
  { id: 'popup-menu-none', query: 'frame-wall=conversation&popup=menu-none', popup: 'Frame menu' },
  { id: 'popup-disabled-rows', query: 'frame-wall=conversation&popup=disabled-rows', popup: 'Frame disabled menu' },
  { id: 'popup-palette-result', query: 'frame-wall=conversation&popup=palette-result' },
  { id: 'popup-composer-add', query: 'frame-wall=conversation', composerAdd: true },
  { id: 'settings-general', query: 'frame-wall=settings-general' },
  { id: 'settings-runtimes', query: 'frame-wall=settings-runtimes' },
  { id: 'library', query: 'frame-wall=library' },
  { id: 'plugins', query: 'frame-wall=plugins' },
  { id: 'changes-review', query: 'frame-wall=changes-review' },
  { id: 'popup-conversation-more', query: 'frame-wall=conversation&frame-conversation-actions=1', popup: 'More' },
  { id: 'popup-undo-confirmation', query: 'frame-wall=conversation&frame-conversation-actions=1', undo: true },
  { id: 'popup-wide-menu', query: 'frame-wall=conversation&popup=wide', popup: 'Frame wide menu' },
  { id: 'popup-metered-menu', query: 'frame-wall=conversation&popup=metered', popup: 'Frame metered menu' },
  { id: 'popup-plan-usage', query: 'frame-wall=conversation&popup=plan-usage', plan: 'anchor' },
  { id: 'popup-branch-flyout', query: 'frame-wall=conversation', git: true, branch: true },
  { id: 'popup-branch-context', query: 'frame-wall=conversation', git: true, gitRef: true },
  { id: 'popup-create-branch', query: 'frame-wall=conversation', git: true, branch: true, createBranch: true },
  { id: 'popup-account-menu', query: 'frame-wall=conversation', account: true },
  { id: 'popup-sign-out-confirmation', query: 'frame-wall=conversation', account: true, signOut: true },
  { id: 'popup-other-agents', query: 'frame-wall=conversation&popup=other-agents', plan: 'rest' },
  { id: 'popup-info-card', query: 'frame-wall=conversation&popup=info', hover: 'Storefront catalogue review' },
  { id: 'popup-info-card-focused', query: 'frame-wall=conversation&popup=info', focus: 'Storefront catalogue review' },
  { id: 'popup-info-menu-exclusion', query: 'frame-wall=conversation&popup=info-and-menu', popup: 'Frame menu' },
  { id: 'popup-context-info', query: 'frame-wall=conversation', contextInfo: true },
  { id: 'popup-member-info', query: 'frame-wall=conversation&popup=member-info', memberInfo: true },
  { id: 'popup-budget-info', query: 'frame-wall=conversation&popup=budget-info', hover: 'Run budget' },
  { id: 'popup-seat-actions', query: 'frame-wall=team', tool: 'details', popup: 'Actions for Alpha' },
  { id: 'popup-context-info-focused', query: 'frame-wall=conversation', infoFocus: 'context' },
  { id: 'popup-member-info-focused', query: 'frame-wall=conversation&popup=member-info', focus: 'Frame member facts' },
  { id: 'popup-budget-info-focused', query: 'frame-wall=conversation&popup=budget-info', focus: 'Run budget' },
  { id: 'popup-account-info', query: 'frame-wall=conversation', leftOpen: true, infoTarget: '[data-info-source="account"]' },
  { id: 'popup-header-info', query: 'header-status=1', infoTarget: '[data-info-source="header"]' },
  { id: 'popup-publication-info', query: 'frame-wall=conversation&popup=publication-info', infoTarget: '[data-kind="pullRequest"] a[href]' },
  { id: 'popup-publication-actions', query: 'frame-wall=conversation&popup=publication-info', popup: 'acme/storefront #12 actions' },
  { id: 'popup-subject-actions', query: 'frame-wall=conversation&popup=subject-actions', popup: 'Scout actions' },
  { id: 'popup-origin-details', query: 'frame-wall=team-trigger&popup=origin-details', tool: 'details' },
  { id: 'popup-inbox', query: 'frame-wall=conversation&popup=inbox', inbox: true },
  { id: 'popup-inbox-expanded', query: 'frame-wall=conversation&popup=inbox', inbox: true, expandInbox: true },
  { id: 'popup-suggestions', query: 'frame-wall=conversation&popup=suggestions' },
  { id: 'popup-select', query: 'frame-wall=conversation&popup=select', select: true },
  { id: 'popup-select-disabled', query: 'frame-wall=conversation&popup=select-disabled', select: true },
] as const

/** Wide (every region stands), between the folds, and the narrowest window. */
export const WALL_WIDTHS = [1440, 1100, 720] as const
export const WALL_THEMES = ['light', 'dark'] as const

/** The wall's clock: relative times read the same in every capture. */
export const WALL_TIME = new Date('2026-09-30T10:00:00-07:00')

;(WALL_DESTINATIONS as WallDestination[]).push({
  id: 'settings-runtimes-add',
  query: 'frame-wall=settings-runtimes&layout-registry=1',
})

// D6 keeps the real Settings bodies inside the shared window column.
;(WALL_DESTINATIONS as WallDestination[]).push(
  { id: 'settings-navigation', query: 'frame-wall=settings-navigation', leftOpen: true },
  { id: 'settings-search', query: 'frame-wall=settings-search', leftOpen: true, settingsQuery: 'mute' },
  { id: 'settings-search-empty', query: 'frame-wall=settings-search', leftOpen: true, settingsQuery: 'zzzz' },
  { id: 'library-left', query: 'frame-wall=library', leftOpen: true },
  { id: 'plugins-left', query: 'frame-wall=plugins', leftOpen: true },
)

;(WALL_DESTINATIONS as WallDestination[]).push(
  { id: 'sessions-left-200', query: 'frame-wall=conversation', leftOpen: true, leftWidth: 200 },
  { id: 'sessions-left-360', query: 'frame-wall=left-work', leftOpen: true, leftWidth: 360 },
  { id: 'settings-left-200', query: 'frame-wall=settings-navigation', leftOpen: true, leftWidth: 200 },
  { id: 'settings-left-360', query: 'frame-wall=settings-navigation', leftOpen: true, leftWidth: 360 },
)

// D7a: both heading states at every wall width and theme, including the float.
export interface WallDestination { readonly leftHeading?: 'hover-open' | 'folded' }
;(WALL_DESTINATIONS as WallDestination[]).push(
  { id: 'left-project-hover', query: 'frame-wall=left-work', leftOpen: true, leftHeading: 'hover-open' },
  { id: 'left-project-folded', query: 'frame-wall=left-work', leftOpen: true, leftHeading: 'folded' },
)
export interface WallDestination { readonly plan?: 'anchor' | 'rest' }
