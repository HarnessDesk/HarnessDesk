import { useState } from 'react'

import { runtimeId, type AgentEntry } from '@harnessdesk/protocol'

import { AgentNew } from '../components/AgentNew'
import { ArchiveSection } from '../components/Archive'
import { CeilingUpdate } from '../components/CeilingUpdate'
import { CeilingsSection } from '../components/SettingsCeilings'
import { ExtensionsSection } from '../components/Extensions'
import { InstallPlugin } from '../components/InstallPlugin'
import { PluginsSection } from '../components/PluginsSection'
import { SchemaForm } from '../components/SchemaForm'
import { SetupDesk } from '../components/SetupDesk'
import { UsageSection } from '../components/SettingsAgents'
import { SkillSheet } from '../components/SkillSheet'
import { Boundary } from './boundary'
import { Dial, Frame } from './main'
import { libraryColumnsFor, LIBRARY } from './harness'
import { PREVIEW_ROOT } from './sidebar-fixture'

/** Its own front matter names a legacy `permission:` line, so `CeilingUpdate`'s update flow has a real Agent to offer choices for — every other fixture Agent already writes a plain `ceiling:` and has nothing for this dialog to update. */
const LEGACY_PERMISSION_AGENT: AgentEntry = {
  id: 'legacy-reviewer',
  origin: 'user',
  path: '/home/u/.harnessdesk/agents/legacy-reviewer/AGENT.md',
  digest: 'digest-legacy-reviewer',
  shadows: [],
  problems: [],
  definition: {
    id: 'legacy-reviewer',
    name: 'Legacy reviewer',
    description: 'Still names its ceiling the old way.',
    ceiling: 'edit',
    ceilingFrom: 'permission',
    answers: [],
    produces: ['review'],
    skills: [],
    mcp: [],
    prefer: [{ runtime: 'claude' }],
    brief: 'You review a change somebody else wrote.',
  },
}

const LIBRARY_COLUMNS = libraryColumnsFor([runtimeId('codex'), runtimeId('claude'), runtimeId('cursor')])

const SCHEMA_FIXTURE = {
  type: 'object',
  properties: {
    verbose: { type: 'boolean', description: 'Print every step as it runs.', default: false },
    retries: { type: 'number', description: 'How many times to retry a failed check.', default: 2 },
    level: { type: 'string', enum: ['low', 'medium', 'high'], description: 'How thorough a pass this runs.' },
  },
  required: ['level'],
} as const

const DIALOG_OPTIONS = ['off', 'new agent', 'update ceiling', 'install plugin', 'skill sheet', 'plugins'] as const
type DialogOption = (typeof DIALOG_OPTIONS)[number]

/**
 * The settings-and-agents batch: sections that read the store on their own
 * (Archive, Extensions, Ceilings) sit as plain frames; the sheets and dialogs
 * among them (a new Agent, a ceiling update, installing a plugin, a skill's
 * own sheet) are off by default and chosen from one dial, the same pattern
 * the worktree dialogs above already use — a dialog covers the page, so two
 * of them can never both be open here. Plugins joins the dial for a
 * different reason: its own two tabs always read "Installed · N" and
 * "Capabilities · N", and Playwright's default substring name match reads
 * "All" inside "Installed" — open by default, it collided with the one
 * "All" tab findings.spec.ts reaches for on the Goal rail.
 */
export const SettingsFrames = () => {
  const [dialog, setDialog] = useState<DialogOption>('off')
  return (
    <>
      <div className="my-4 flex flex-wrap items-center gap-3">
        <Dial label="settings sheet" value={dialog} options={DIALOG_OPTIONS} onChange={setDialog} />
      </div>
      {/* Bare, position:fixed, and not inside a `Frame` (which carries its
          own `Boundary`) — without one here a throw would unmount every
          frame this page draws, not just this file's own. */}
      <Boundary>
        {dialog === 'new agent' && <AgentNew root={PREVIEW_ROOT} onCreated={() => setDialog('off')} onClose={() => setDialog('off')} />}
        {dialog === 'update ceiling' && <CeilingUpdate entry={LEGACY_PERMISSION_AGENT} onClose={() => setDialog('off')} />}
        {dialog === 'install plugin' && <InstallPlugin onClose={() => setDialog('off')} />}
        {dialog === 'skill sheet' && (
          <SkillSheet
            entry={LIBRARY.entries[0] as never}
            columns={LIBRARY_COLUMNS}
            usage={null}
            hosts={{ skill: new Set(['claude' as never]), mcp: new Set() }}
            cwd={PREVIEW_ROOT}
            home="/home/u"
            onFlow={() => {}}
            onChanged={() => {}}
            onClose={() => setDialog('off')}
          />
        )}
      </Boundary>
      {dialog === 'plugins' && (
        <Frame id="settings-plugins" title="Settings › Plugins">
          <div className="max-h-[560px] overflow-y-auto p-4">
            <PluginsSection />
          </div>
        </Frame>
      )}
      <Frame id="settings-archive" title="Settings › Archive">
        <div className="p-4">
          <ArchiveSection />
        </div>
      </Frame>
      <Frame id="settings-account-usage" title="Settings › Account › Usage">
        <div className="p-4" data-hd-density="comfortable">
          <UsageSection name="Preview" limits={{ hasCredits: true, balance: 5, windows: [
            { label: '5-hour', usedPercent: 10, windowMinutes: 300, resetsAt: Date.now() + 2 * 3_600_000 + 14 * 60_000 },
            { label: 'Weekly', usedPercent: 88, windowMinutes: 10080, resetsAt: Date.now() + 3 * 86_400_000 },
          ] }} />
        </div>
      </Frame>
      <Frame id="settings-extensions" title="Settings › Extensions">
        <div className="max-h-[560px] overflow-y-auto p-4">
          <ExtensionsSection />
        </div>
      </Frame>
      <Frame id="settings-ceilings" title="Settings › Ceilings">
        <div className="max-h-[560px] overflow-y-auto p-4">
          <CeilingsSection />
        </div>
      </Frame>
      <Frame id="setup-survey" title="Setup — the whole desk, surveyed">
        <div className="p-4">
          <SetupDesk onSignIn={() => {}} onOpenRuntimes={() => {}} />
        </div>
      </Frame>
      <Frame id="schema-form" title="Schema form — a plugin's own configuration">
        <div className="max-w-[420px] p-4">
          <SchemaForm schema={SCHEMA_FIXTURE} value={{ level: 'medium' }} onSubmit={() => {}} />
        </div>
      </Frame>
    </>
  )
}
