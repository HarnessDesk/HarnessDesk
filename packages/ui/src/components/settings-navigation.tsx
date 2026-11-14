import type { ReactNode } from 'react'
import { LEAD_AUTONOMY_LABELS, LEAD_RULE_TITLES, type RuntimeInfo } from '@harnessdesk/protocol'
import type { AppSnapshot } from '../state/store'
import type { Section } from './Settings'
import { agentGroups } from '../lib/accounts'
import { agentReadiness } from './SettingsAgents'
import { isBlocking, worstReadiness, type Readiness } from '../lib/readiness'
import { ArchiveIcon, BellIcon, ExtensionIcon, FolderIcon, GlobeIcon, KeyboardIcon,
  LeadIcon, MobileIcon, HistoryIcon, ResourceIcon, RouteIcon, ServerIcon, ShieldIcon, SlidersIcon, SparkIcon, ThemeSystemIcon, UserIcon } from './Icons'

export interface SettingsNavEntry {
  readonly id: Section
  readonly label: string
  readonly icon: ReactNode
  readonly keywords: readonly string[]
  readonly count?: number
  readonly state?: Readiness
  readonly title?: string
}
export interface SettingsNavGroup {
  readonly label: string
  readonly entries: readonly SettingsNavEntry[]
}
/** Every row the Lead page holds, so search finds the page by any of them. The autonomy and rule titles come from
 * the protocol's own labels, so a renamed row is still found. */
const LEAD_KEYWORDS: readonly string[] = [
  'feature', 'features', 'enable lead', 'disable lead', 'enabling lead', 'disabling lead', 'turn on lead', 'turn off lead',
  'dex', 'lex', 'who runs your desk', 'provider key', 'model', 'allowances', 'spending limit', 'round allowance', 'plan consent',
  'permissions', 'permission mode', 'rules', 'triggers', 'checks failed', 'review comment', 'follow pull requests',
  'conversation', 'context', 'cache', 'summarise', 'summaries', 'autonomy', 'goal deadline',
  ...Object.values(LEAD_AUTONOMY_LABELS).map(label => label.title.toLowerCase()), 'mention', 'stuck', 'repeat',
  ...Object.values(LEAD_RULE_TITLES).map(title => title.toLowerCase()), 'morning brief', 'brief',
  'scheduled tasks', 'reminder', 'reminders', 'quiet hours', 'memory', 'notes', 'remember', 'forget',
]
const MOBILE_KEYWORDS: readonly string[] = [
  'feature', 'features', 'enable mobile', 'disable mobile', 'enable phone', 'disable phone',
  'enabling mobile', 'disabling mobile', 'enabling phone', 'disabling phone', 'turn on mobile', 'turn off mobile',
  'nearby phone', 'nearby mobile', 'phone', 'pair', 'qr', 'code', 'mobile', 'devices', 'allow', 'remove',
  'linked phones', 'reachable', 'relay', 'account',
]
export const settingsGroups = (snapshot: AppSnapshot, runtime: RuntimeInfo): readonly SettingsNavGroup[] => {
  const accountCount = snapshot.runtimes.reduce((n, info) => n + (snapshot.accountsByRuntime[info.id]?.accounts.length ?? 0), 0)
  const worst = worstReadiness(agentGroups(snapshot.runtimes).map(group => agentReadiness(group.siblings, snapshot)))
  const scoped = (page: string) => `${page} belongs to ${runtime.presentation.name}, the runtime the active conversation is with.`
  return [
    { label: 'Preferences', entries: [
      { id: 'profile', label: 'Account', icon: <UserIcon size={16} />, keywords: ['sign in', 'sign out', 'phone', 'linked phones', 'reachable', 'desk name', 'rename', 'pair', 'name', 'picture'] },
      { id: 'general', label: 'General', icon: <SlidersIcon size={16} />, keywords: ['backup', 'restore', 'export', 'diagnostics', 'support', 'data', 'sync', 'account', 'transcripts', 'this mac'] },
      { id: 'appearance', label: 'Appearance', icon: <ThemeSystemIcon size={16} />, keywords: ['theme', 'dark', 'light', 'system', 'accent', 'colour', 'color', 'corners', 'radius', 'surface', 'cards', 'sheet', 'faces', 'avatar shape', 'round', 'font', 'text size', 'line numbers', 'wrap', 'indent', 'tab', 'density', 'sort', 'code editor'] },
      { id: 'notifications', label: 'Notifications', icon: <BellIcon size={16} />, keywords: ['banner', 'message', 'mute', 'silence', 'alert', 'stop showing', 'remind', 'finished turns', 'failures', 'approvals', 'needs you', 'quota', 'rate limit', 'macos'] },
      { id: 'shortcuts', label: 'Keyboard shortcuts', icon: <KeyboardIcon size={16} />, keywords: ['keys', 'bindings', 'command', 'new session', 'open folder', 'close pane', 'sidebar', 'changes', 'palette', 'send', 'new line'] },
    ] },
    { label: 'Agents', entries: [
      { id: 'runtimes', label: 'Runtimes', icon: <ServerIcon size={16} />, keywords: ['runtimes', 'installed', 'cli', 'accounts', 'sign in', 'sign out', 'add runtime', 'registry', 'nickname', 'ring', 'usage', 'plan', 'new sessions', 'defaults', 'update', 'remove'],
        ...(accountCount > 0 ? { count: accountCount } : {}), ...(isBlocking(worst) ? { state: worst } : {}) },
      { id: 'models', label: 'Models', icon: <RouteIcon size={16} />, keywords: ['endpoint', 'api', 'provider', 'proxy', 'gateway', 'route', 'presets', 'hide', 'composer', 'effort', 'thinking'] },
      { id: 'lead', label: 'Lead', icon: <LeadIcon size={16} />, keywords: LEAD_KEYWORDS },
      { id: 'hooks', label: 'Hooks', icon: <SparkIcon size={16} />, title: scoped('Hooks'), keywords: ['hooks', 'events', 'lifecycle'] },
      { id: 'extensions' as const, label: 'Extensions', icon: <ExtensionIcon size={16} />, title: scoped('Extensions'), keywords: ['mcp', 'servers', 'apps', 'connect', 'marketplace', 'install'] },
    ] },
    { label: 'Conversations', entries: [
      { id: 'workspaces', label: 'Workspaces', icon: <FolderIcon size={16} />, keywords: ['folders', 'projects', 'worktrees', 'forget', 'open folder', 'checkout', 'branch'] },
      { id: 'history', label: 'History', icon: <HistoryIcon size={16} />, keywords: ['history', 'import', 'other runtimes', 'past conversations'] },
      { id: 'archive', label: 'Archive', icon: <ArchiveIcon size={16} />, keywords: ['archived', 'history', 'restore', 'delete', 'trash', 'old sessions'] },
      { id: 'storage', label: 'Storage', icon: <ResourceIcon size={16} />, keywords: ['storage', 'disk', 'space', 'clean up', 'worktrees', 'cache'] },
    ] },
    { label: 'Access', entries: [
      { id: 'phone', label: 'Mobile', icon: <MobileIcon size={16} />, keywords: MOBILE_KEYWORDS },
      { id: 'permissions', label: 'Permissions', icon: <ShieldIcon size={16} />, keywords: ['git', 'push', 'pull request', 'gateway', 'record', 'approve', 'approval', 'sandbox', 'rules', 'deny', 'allow', 'commands', 'file changes', 'network', 'ceiling', 'ceilings', 'held', 'asked', 'clients', 'command-line', 'answer'] },
      { id: 'browser', label: 'Browser', icon: <GlobeIcon size={16} />, keywords: ['pane', 'chrome', 'links', 'window', 'profile', 'cookies', 'logins', 'browsing data'] },
    ] },
  ]
}
export const filterSettingsGroups = (groups: readonly SettingsNavGroup[], query: string): readonly SettingsNavGroup[] => {
  const needle = query.trim().toLowerCase()
  return groups.map(group => ({ ...group, entries: group.entries.filter(entry =>
    [entry.label, ...entry.keywords].join(' ').toLowerCase().includes(needle)) })).filter(group => group.entries.length > 0)
}
