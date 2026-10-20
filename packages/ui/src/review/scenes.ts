import type { SceneStep } from '../preview/scene-steps'

/**
 * Every state of the app the review board lays out, each a whole window.
 *
 * A scene is a frame-wall route (`preview.html?frame-wall=…`, the same real
 * App the visual specs capture) plus the clicks that reach one state of it.
 * The route's fixtures are synthetic and use the placeholder and demo
 * identities only (AGENTS.md rule 13). This list is the board's and the
 * guides standard's alike: a state added here is reviewed and held to the
 * standard from then on.
 */

export type Scene = {
  readonly id: string
  readonly title: string
  readonly query: string
  readonly steps?: readonly SceneStep[]
  readonly width?: number
  readonly height?: number
}

export type Section = { readonly id: string; readonly title: string; readonly scenes: readonly Scene[] }

const tab = (value: string): SceneStep => ({ click: `[data-team-page="${value}"]` })
const rail: SceneStep = { click: '[data-work-rail-toggle][aria-pressed="false"]', unless: '[data-work-rail-toggle][aria-pressed="true"]' }
const tool = (value: string): SceneStep => ({ click: `[data-work-tool="${value}"]` })
const left: SceneStep = { click: 'button[aria-label="Show sidebar"]', unless: '[data-left-column]' }
const view = (choice: string): SceneStep[] => [
  { text: 'View', within: '[data-slot="page-options"] button' },
  { text: choice, within: '[role="menuitem"], [role="menuitemradio"], [role="switch"]' },
]
const open = (label: string): SceneStep => ({ text: label, within: 'button' })

export const SECTIONS: readonly Section[] = [
  {
    id: 'conversation', title: 'Conversation', scenes: [
      { id: 'conversation', title: 'A conversation', query: 'frame-wall=conversation' },
      { id: 'conversation-left-open', title: 'With the sidebar', query: 'frame-wall=conversation', steps: [left] },
      { id: 'draft', title: 'A new draft', query: 'frame-wall=draft' },
      { id: 'conversation-details', title: 'Details panel', query: 'frame-wall=conversation', steps: [rail] },
      { id: 'conversation-details-no-background', title: 'Details, no background list', query: 'frame-wall=conversation&frame-no-background=1', steps: [rail] },
      { id: 'conversation-changes', title: 'Changes panel', query: 'frame-wall=conversation', steps: [tool('changes')] },
      { id: 'conversation-browser', title: 'Browser panel', query: 'frame-wall=conversation', steps: [tool('browser')] },
      { id: 'conversation-git', title: 'Git panel', query: 'frame-wall=conversation&frame-tool=git' },
      { id: 'conversation-file', title: 'A file open', query: 'frame-wall=conversation&frame-tool=file&frame-tool-path=%2Frepo%2FREADME.md' },
      { id: 'conversation-terminal', title: 'Terminal', query: 'frame-wall=conversation&frame-terminal=1' },
      { id: 'conversation-tasks', title: 'Tasks', query: 'frame-wall=conversation&frame-tool=tasks' },
      { id: 'changes-review', title: 'Reviewing changes', query: 'frame-wall=changes-review' },
    ],
  },
  {
    id: 'states', title: 'Window states', scenes: [
      { id: 'conversation-update', title: 'Update ready', query: 'frame-wall=conversation&frame-update=1' },
      { id: 'conversation-disconnected', title: 'Disconnected', query: 'frame-wall=conversation&frame-status=closed' },
      { id: 'conversation-status-tasks', title: 'Background tasks', query: 'frame-wall=conversation&frame-status=tasks' },
      { id: 'team-reconnecting', title: 'Team reconnecting', query: 'frame-wall=team&frame-status=reconnecting' },
      { id: 'plugin-unavailable', title: 'Plugin unavailable', query: 'frame-wall=conversation&frame-tool=plugin-unavailable' },
      { id: 'width-1100', title: 'At 1100', query: 'frame-wall=conversation', steps: [left], width: 1100 },
      { id: 'width-720', title: 'At 720', query: 'frame-wall=conversation', width: 720 },
    ],
  },
  {
    id: 'team', title: 'Team', scenes: [
      { id: 'team-overview', title: 'Overview', query: 'frame-wall=team', steps: [tab('overview')] },
      { id: 'team-run', title: 'Run', query: 'frame-wall=team', steps: [tab('run')] },
      { id: 'team-run-flow', title: 'Run as a flow', query: 'frame-wall=team-run-recorded', steps: [tab('run'), ...view('Flow')] },
      { id: 'team-run-not-reached', title: 'Run, a step not reached', query: 'frame-wall=team-run-not-reached', steps: [tab('run')] },
      { id: 'team-run-repeated', title: 'Run, many times', query: 'frame-wall=team-run-repeated', steps: [tab('run')] },
      { id: 'team-run-equivalent', title: 'Run, an equivalent', query: 'frame-wall=team-run-equivalent', steps: [tab('run')] },
      { id: 'team-board', title: 'Board', query: 'frame-wall=team', steps: [tab('board')] },
      { id: 'team-board-list', title: 'Board as a list', query: 'frame-wall=team', steps: [tab('board'), ...view('List')] },
      { id: 'team-chat', title: 'Chat', query: 'frame-wall=team', steps: [tab('room')] },
      { id: 'team-chat-side', title: 'Chat side by side', query: 'frame-wall=team', steps: [tab('room'), ...view('Side by side')] },
      { id: 'team-findings', title: 'Findings', query: 'frame-wall=team', steps: [tab('findings')] },
      { id: 'team-runs', title: 'Runs', query: 'frame-wall=team-trigger', steps: [tab('runs')] },
      { id: 'team-receipt', title: 'Receipt', query: 'frame-wall=team-receipt', steps: [tab('receipt')] },
      { id: 'team-details', title: 'With details', query: 'frame-wall=team', steps: [tab('overview'), rail] },
      { id: 'teams', title: 'All Teams', query: 'frame-wall=teams' },
    ],
  },
  {
    id: 'agents', title: 'Agents', scenes: [
      { id: 'agents-roster', title: 'Roster', query: 'frame-wall=agents' },
      { id: 'agent-detail', title: 'An Agent', query: 'frame-wall=agents&frame-detail=agent' },
      { id: 'agent-parse', title: 'Will not parse', query: 'frame-wall=agents&frame-agent-case=parse' },
      { id: 'agent-refused', title: 'Refused', query: 'frame-wall=agents&frame-agent-case=refused' },
      { id: 'agent-missing', title: 'Missing', query: 'frame-wall=agents&frame-agent-case=missing' },
    ],
  },
  {
    id: 'library', title: 'Library and plugins', scenes: [
      { id: 'library', title: 'Library', query: 'frame-wall=library' },
      { id: 'plugins-installed', title: 'Plugins', query: 'frame-wall=plugins&frame-plugin-page=installed' },
      { id: 'plugins-capabilities', title: 'Capabilities', query: 'frame-wall=plugins&frame-plugin-page=capabilities' },
      { id: 'plugins-detail', title: 'A plugin', query: 'frame-wall=plugins&frame-plugin-page=detail' },
      { id: 'plugins-failed', title: 'A plugin that failed', query: 'frame-wall=plugins&frame-plugin-page=failed' },
    ],
  },
  {
    id: 'dashboard', title: 'Dashboard', scenes: ['overview', 'plans', 'spend', 'activity', 'projects'].map((one) => ({
      id: `dashboard-${one}`, title: one[0]!.toUpperCase() + one.slice(1), query: `frame-wall=dashboard&frame-view=${one}`,
    })).concat([{ id: 'dashboard-empty', title: 'No usage yet', query: 'frame-wall=dashboard&frame-view=overview&frame-empty-usage=1' }]),
  },
  {
    id: 'settings', title: 'Settings', scenes: [
      ...['general', 'appearance', 'notifications', 'shortcuts', 'workspaces', 'archive', 'history', 'storage', 'runtimes', 'models', 'skills', 'extensions', 'permissions', 'browser', 'profile'].map((one) => ({
        id: `settings-${one}`, title: one[0]!.toUpperCase() + one.slice(1), query: `frame-wall=settings&frame-section=${one}`,
      })),
      { id: 'settings-runtime', title: 'A runtime', query: 'frame-wall=settings&frame-detail=runtime' },
      { id: 'settings-account', title: 'An account', query: 'frame-wall=settings&frame-detail=account' },
      { id: 'settings-project', title: 'A project', query: 'frame-wall=settings&frame-detail=project' },
      { id: 'settings-skill', title: 'A skill', query: 'frame-wall=settings&frame-detail=skill' },
    ],
  },
  {
    id: 'left', title: 'Sidebar', scenes: [
      { id: 'left-work', title: 'Projects and sessions', query: 'frame-wall=left-work', steps: [left] },
      { id: 'navigation', title: 'Navigation', query: 'frame-wall=navigation', steps: [left] },
      { id: 'left-start', title: 'Start menu', query: 'frame-wall=conversation', steps: [left, { click: '[data-left-column] button[aria-label="More ways to start"]' }] },
      { id: 'left-account', title: 'Account menu', query: 'frame-wall=conversation', steps: [left, { click: '[data-left-seat] [data-slot="popover-trigger"]:not(:has([data-slot="inbox-button"]))' }] },
      { id: 'left-inbox', title: 'Inbox', query: 'frame-wall=conversation', steps: [left, { click: '[data-left-column] :has(> [data-slot="inbox-button"])' }] },
      { id: 'left-session-menu', title: 'Session menu', query: 'frame-wall=left-work', steps: [left, { focus: '[data-left-column] [data-region="session-row"] [data-slot="sidebar-menu-button"]', key: 'ContextMenu' }] },
    ],
  },
  {
    id: 'menus', title: 'Menus and cards', scenes: [
      { id: 'menu-model', title: 'Model picker', query: 'frame-wall=conversation', steps: [{ click: 'button[title="Model and reasoning"]' }] },
      { id: 'menu-permissions', title: 'Permissions', query: 'frame-wall=conversation', steps: [{ click: 'button[title="Permissions — what the runtime may do"]' }] },
      { id: 'menu-icons', title: 'Menu with icons', query: 'frame-wall=conversation&popup=menu-icons', steps: [open('Frame menu')] },
      { id: 'menu-disabled', title: 'Refused rows', query: 'frame-wall=conversation&popup=disabled-rows', steps: [open('Frame disabled menu')] },
      { id: 'menu-wide', title: 'Wide menu', query: 'frame-wall=conversation&popup=wide', steps: [open('Frame wide menu')] },
      { id: 'menu-metered', title: 'Metered menu', query: 'frame-wall=conversation&popup=metered', steps: [open('Frame metered menu')] },
      { id: 'menu-select', title: 'Select', query: 'frame-wall=conversation&popup=select', steps: [{ click: '[data-slot="select-trigger"]' }] },
      { id: 'menu-suggestions', title: 'Suggestions', query: 'frame-wall=conversation&popup=suggestions' },
      { id: 'menu-inbox', title: 'Inbox list', query: 'frame-wall=conversation&popup=inbox' },
      { id: 'menu-palette', title: 'Palette result', query: 'frame-wall=conversation&popup=palette-result' },
    ],
  },
]

export const SCENES: readonly Scene[] = SECTIONS.flatMap((section) => section.scenes)

export const WINDOW = { width: 1440, height: 900 } as const

/** The preview URL that renders a scene. */
export const sceneUrl = (scene: Scene, theme: 'light' | 'dark', guides: string) => {
  const query = new URLSearchParams(scene.query)
  query.set('theme', theme)
  query.set('guides', guides)
  if (scene.steps?.length) query.set('steps', JSON.stringify(scene.steps))
  return `/preview.html?${query.toString()}`
}
