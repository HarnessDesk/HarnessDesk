/**
 * What the frame wall captures (docs/design.md,
 * "The visual check"). `tab` is a Team view's `data-team-page` value. A phase
 * that adds a destination adds it here, and the wall grows with it.
 */
import type { PageFrameActions } from './frame-page-actions'

import type { WallActions } from './frame-wall-actions'

export interface WallDestination extends PageFrameActions, WallActions { readonly id: string; readonly query: string; readonly leftWidth?: number; readonly leftOpen?: boolean; readonly leftPopup?: string; readonly settingsQuery?: string; readonly surface?: 'pattern'; readonly pageWidth?: 'reading' | 'wide' | 'canvas' }

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
  { id: 'team-chat-side-by-side', query: 'frame-wall=team', tab: 'room', viewChoice: 'Split' },
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
  { id: 'popup-account-info', query: 'frame-wall=conversation', leftOpen: true, leftPopup: 'usage' },
  { id: 'popup-header-info', query: 'frame-wall=conversation&popup=header-info', infoTarget: '[data-info-source="header"]' },
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

export const E3_PAGE_WALL_DESTINATIONS: readonly WallDestination[] = [
  ...['overview','plans','spend','activity','projects'].map(view => ({id:`dashboard-${view}`,query:`frame-wall=dashboard&frame-view=${view}`,pageWidth:'wide' as const})),
  {id:'dashboard-scoped-plans',query:'frame-wall=dashboard&frame-view=plans&frame-scope=runtime',pageWidth:'wide'},
  {id:'dashboard-borrowed-plans',query:'frame-wall=dashboard&frame-view=plans&frame-scope=runtime&frame-borrowed=1',pageWidth:'wide'},
]

/** E7 route witnesses; common preview replacement and old ids retire in Task 9. */
export const E7_PLUGIN_PAGE_DESTINATIONS: readonly WallDestination[] = [
  { id: 'plugins-installed', query: 'frame-wall=plugins&frame-plugin-page=installed', pageWidth: 'wide' },
  { id: 'plugins-capabilities', query: 'frame-wall=plugins&frame-plugin-page=capabilities', pageWidth: 'wide' },
  { id: 'plugins-capabilities-here-pending', query: 'frame-wall=plugins&frame-plugin-page=capabilities&frame-plugin-pending=1', pageWidth: 'wide', bodyChoice: { label: 'Where it applies', value: 'here' } },
  { id: 'plugins-detail', query: 'frame-wall=plugins&frame-plugin-page=detail', pageWidth: 'wide' },
  { id: 'plugins-failed', query: 'frame-wall=plugins&frame-plugin-page=failed', pageWidth: 'wide' },
  { id: 'plugins-install', query: 'frame-wall=plugins&frame-plugin-page=installed', pageWidth: 'wide', popup: 'Add plugin' },
  { id: 'plugins-configuration', query: 'frame-wall=plugins&frame-plugin-page=detail', pageWidth: 'wide' },
]

export const PAGE_WALL_DESTINATIONS: readonly WallDestination[] = [
  { id: 'settings-general', query: 'frame-wall=settings&frame-section=general', pageWidth: 'reading' },
  { id: 'settings-appearance', query: 'frame-wall=settings&frame-section=appearance', pageWidth: 'reading' },
  { id: 'settings-notifications', query: 'frame-wall=settings&frame-section=notifications', pageWidth: 'reading' },
  { id: 'settings-shortcuts', query: 'frame-wall=settings&frame-section=shortcuts', pageWidth: 'reading' },
  { id: 'settings-workspaces', query: 'frame-wall=settings&frame-section=workspaces', pageWidth: 'reading' },
  { id: 'settings-archive', query: 'frame-wall=settings&frame-section=archive', pageWidth: 'reading' },
  { id: 'settings-history', query: 'frame-wall=settings&frame-section=history', pageWidth: 'reading' },
  { id: 'settings-storage', query: 'frame-wall=settings&frame-section=storage', pageWidth: 'reading' },
  { id: 'settings-runtimes', query: 'frame-wall=settings&frame-section=runtimes', pageWidth: 'reading' },
  { id: 'settings-models', query: 'frame-wall=settings&frame-section=models', pageWidth: 'reading' },
  { id: 'settings-skills', query: 'frame-wall=settings&frame-section=skills', pageWidth: 'reading' },
  { id: 'settings-extensions', query: 'frame-wall=settings&frame-section=extensions', pageWidth: 'reading' },
  { id: 'settings-permissions', query: 'frame-wall=settings&frame-section=permissions', pageWidth: 'reading' },
  { id: 'settings-browser', query: 'frame-wall=settings&frame-section=browser', pageWidth: 'reading' },
  { id: 'settings-profile', query: 'frame-wall=settings&frame-section=profile', pageWidth: 'reading' },
  { id: 'settings-add-runtime', query: 'frame-wall=settings&frame-section=runtimes&frame-focus=add', pageWidth: 'reading' },
  { id: 'settings-runtime', query: 'frame-wall=settings&frame-detail=runtime', pageWidth: 'reading' },
  { id: 'settings-account', query: 'frame-wall=settings&frame-detail=account', pageWidth: 'reading' },
  { id: 'settings-project', query: 'frame-wall=settings&frame-detail=project', pageWidth: 'reading' },
  { id: 'settings-skill', query: 'frame-wall=settings&frame-detail=skill', pageWidth: 'reading' },
  ...E3_PAGE_WALL_DESTINATIONS,
  ...E7_PLUGIN_PAGE_DESTINATIONS,
]

export const AGENTS_PAGE_WALL_DESTINATIONS: readonly WallDestination[] = [
  { id: 'e4-agents-roster', query: 'frame-wall=agents', pageWidth: 'wide' },
  { id: 'e4-agent-detail', query: 'frame-wall=agents&frame-detail=agent', pageWidth: 'reading' },
  { id: 'e4-agent-parse', query: 'frame-wall=agents&frame-agent-case=parse', pageWidth: 'reading' },
  { id: 'e4-agent-refused', query: 'frame-wall=agents&frame-agent-case=refused', pageWidth: 'reading' },
  { id: 'e4-agent-missing', query: 'frame-wall=agents&frame-agent-case=missing', pageWidth: 'wide' },
]
;(PAGE_WALL_DESTINATIONS as WallDestination[]).push(...AGENTS_PAGE_WALL_DESTINATIONS)


export const E5_PAGE_WALL_DESTINATIONS: readonly WallDestination[] = [
 {id:'e5-teams-active',query:'frame-wall=teams&frame-filter=active',pageWidth:'wide'},
 {id:'e5-teams-needs-you',query:'frame-wall=teams&frame-filter=needs-you',pageWidth:'wide'},
 {id:'e5-teams-settled',query:'frame-wall=teams&frame-filter=settled',pageWidth:'wide'},
 {id:'e5-teams-wrapped',query:'frame-wall=teams&frame-filter=active',pageWidth:'wide',expandWrapped:true},
 {id:'e5-teams-no-folder',query:'frame-wall=teams&frame-no-folder=1',pageWidth:'wide'},
 {id:'e5-teams-empty',query:'frame-wall=teams&frame-empty=1',pageWidth:'wide'},
]
;(PAGE_WALL_DESTINATIONS as WallDestination[]).push(...E5_PAGE_WALL_DESTINATIONS)

export const E6_LIBRARY_PAGE_DESTINATIONS: readonly WallDestination[] = [
  { id: 'l2-library-changes', query: 'frame-wall=library&frame-kind=changes', pageWidth: 'wide' },
  { id: 'l2-library-changes-restore', query: 'frame-wall=library&frame-kind=changes', pageWidth: 'wide', bodyChoice: { label: 'Changes', value: 'restore', item: 'Can restore' } },
  { id: 'l2-library-changes-failed', query: 'frame-wall=library&frame-kind=changes', pageWidth: 'wide', bodyChoice: { label: 'Changes', value: 'failed', item: 'Failed' } },
  ...['one', 'several', 'installs', 'failed', 'failures'].map(shape => ({ id: `l2-library-toast-${shape}`, query: `frame-wall=library&frame-write-toast=${shape}`, pageWidth: 'wide' as const })),
  { id: 'l2-library-changes-empty', query: 'frame-wall=library&frame-kind=changes&frame-changes-empty=1', pageWidth: 'wide' },
  { id: 'e6-library-skills', query: 'frame-wall=library&frame-kind=skill', pageWidth: 'wide' },
  { id: 'l1-library-empty', query: 'frame-wall=library&frame-empty=1', pageWidth: 'wide' },
  { id: 'l1-library-add', query: 'frame-wall=library', pageWidth: 'wide', addSkillMenu: true },
  { id: 'e6-library-mcp', query: 'frame-wall=library&frame-kind=mcp', pageWidth: 'wide', tab: 'mcp' },
  { id: 'e6-library-matrix', query: 'frame-wall=library', pageWidth: 'wide', bodyChoice: {label:'How to show the library',value:'matrix',item:'Matrix'} },
  { id: 'e6-library-expanded', query: 'frame-wall=library', pageWidth: 'wide', bodyChoice: {label:'How to show the library',value:'matrix',item:'Matrix'}, expandLibraryEntry: true },
  { id: 'e6-library-import', query: 'frame-wall=library', pageWidth: 'wide', addSkillChoice: 'Copy from another runtime…' },
  { id: 'e6-library-attention', query: 'frame-wall=library', pageWidth: 'wide', bodyChoice: {label:'Skills',value:'needs-you',item:'Needs you'} },
  { id: 'e6-library-conflict', query: 'frame-wall=library', pageWidth: 'wide', bodyChoice: {label:'Filter the library',value:'differs',item:'Copies differ'} },
]
;(PAGE_WALL_DESTINATIONS as WallDestination[]).push(...E6_LIBRARY_PAGE_DESTINATIONS)

/** E8 scene wiring is applied by the integration owner with the shared preview assembly. */
export const E8_REVIEW_WALL_DESTINATIONS: readonly WallDestination[] = [
  { id: 'e8-review-working', query: 'frame-wall=changes-review', pageWidth: 'canvas' },
  { id: 'e8-review-staged', query: 'frame-wall=changes-review', pageWidth: 'canvas', tab: 'staged' },
  { id: 'e8-review-filtered', query: 'frame-wall=changes-review', pageWidth: 'canvas', bodySearch: { label: 'Filter files', value: 'src/a' } },
  { id: 'e8-review-empty', query: 'frame-wall=changes-review&frame-review-scene=empty', pageWidth: 'canvas' },
  { id: 'e8-review-not-repository', query: 'frame-wall=changes-review&frame-review-scene=not-repository', pageWidth: 'canvas' },
  { id: 'e8-review-large', query: 'frame-wall=changes-review&frame-review-scene=large', pageWidth: 'canvas' },
]
;(PAGE_WALL_DESTINATIONS as WallDestination[]).push(...E8_REVIEW_WALL_DESTINATIONS)

;(WALL_DESTINATIONS as WallDestination[]).push(...PAGE_WALL_DESTINATIONS)

// Editor mode adds its real file states without reordering existing frame groups.
;(WALL_DESTINATIONS as WallDestination[]).push(
  { id: 'editor-conversation', query: 'frame-wall=conversation&frame-editor-mode=conversation', leftOpen: true },
  { id: 'editor-source', query: 'frame-wall=conversation&frame-editor-mode=source' },
  { id: 'editor-changes', query: 'frame-wall=conversation&frame-editor-mode=changes' },
  { id: 'editor-preview', query: 'frame-wall=conversation&frame-editor-mode=preview' },
  { id: 'editor-ask', query: 'frame-wall=conversation&frame-editor-mode=ask' },
  { id: 'editor-conflict', query: 'frame-wall=conversation&frame-editor-mode=conflict' },
  { id: 'editor-settings', query: 'frame-wall=settings&frame-section=appearance', leftOpen: true },
  { id: 'editor-team', query: 'frame-wall=team', tab: 'overview', leftOpen: true },
  { id: 'editor-panel-file', query: 'frame-wall=conversation&frame-editor-mode=panel' },
  { id: 'editor-panel-popout', query: 'frame-wall=conversation&frame-editor-mode=panel' },
  { id: 'editor-dirty-close', query: 'frame-wall=conversation&frame-editor-mode=source' },
)
