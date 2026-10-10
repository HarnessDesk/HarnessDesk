/**
 * What the frame wall captures (docs/superpowers/plans/2026-10-09-app-frame.md,
 * "The visual check"). `tab` is a Team view's `data-team-page` value. A phase
 * that adds a destination adds it here, and the wall grows with it.
 */
import type { FrameActions } from './frame-actions'

export interface WallDestination extends FrameActions { readonly id: string; readonly query: string }

export const WALL_DESTINATIONS: readonly WallDestination[] = [
  { id: 'topbar-probe', query: 'frame-wall=topbar' },
  { id: 'conversation', query: 'frame-wall=conversation' },
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
  { id: 'dashboard', query: 'frame-wall=dashboard' },
  { id: 'settings', query: 'frame-wall=settings' },
]

/** Wide (every region stands), between the folds, and the narrowest window. */
export const WALL_WIDTHS = [1440, 1100, 720] as const
export const WALL_THEMES = ['light', 'dark'] as const

/** The wall's clock: relative times read the same in every capture. */
export const WALL_TIME = new Date('2026-09-30T10:00:00-07:00')
