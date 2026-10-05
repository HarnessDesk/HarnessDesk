import { useState, type ComponentProps } from 'react'
import { runtimeId, type AccountStatus, type RuntimeInfo } from '@harnessdesk/protocol'

import { Settings, type Section } from '../components/Settings'
import { AgentsView } from '../components/Details'
import { AgentsWindow } from '../components/AgentsWindow'
import { WorkspaceMenu } from '../components/WorkspaceMenu'
import { Button, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../design'
import { StoreProvider } from '../state/context'
import { compactAgentsStore } from './compact-panels-fixture'
import { Frame as PreviewFrame } from './main'
import { Mount, previewStore, store } from './harness'

const surface = new URLSearchParams(window.location.search).get('surface')
const Frame = (props: ComponentProps<typeof PreviewFrame>) => surface && surface !== props.id ? null : <PreviewFrame {...props} />

const projects = Array.from({ length: 32 }, (_, index) => ({ value: String(index), label: `Project ${index + 1}` }))
const base = store.getSnapshot()
const original = base.runtimes[0]!
const one = { ...original, slot: { ...original.slot, agent: original.id } } as RuntimeInfo
const two = { ...one, id: runtimeId('alpha-personal') } as RuntimeInfo
const status = (label: string): AccountStatus => ({ ...base.accountsByRuntime[original.id]!, accounts: [{ kind: 'oauth', label, email: label }] })
const accountsStore = previewStore({
  runtimes: [one, two, base.runtimes[1]!],
  accountsByRuntime: { ...Object.fromEntries(base.runtimes.map(info => [info.id, status('dev@example.com')])), [one.id]: status('alice@example.com'), [two.id]: status('amy@example.com') },
  accountPrefs: {},
})
const menuStore = previewStore({ listPrefs: { ...base.listPrefs, pinned: ['/preview/first', '/preview/project', '/preview/last'] } })

/** Real surfaces, with public-safe accounts and a Select long enough to scroll. */
export const IconFollowupsFrames = () => {
  const [section, setSection] = useState<Section>('runtimes')
  const [agentsFocus, setAgentsFocus] = useState<string | null>(null)
  const [menu, setMenu] = useState(false)
  return <div className="grid gap-4 p-4">
    <Frame id="icon-settings" title="Runtimes — destination and account faces">
      <div className="relative h-[700px]" style={{ transform: 'translateZ(0)' }}>
        <StoreProvider store={accountsStore}><Settings section={section} onSection={setSection} onSignIn={() => {}} onClose={() => {}} /></StoreProvider>
      </div>
    </Frame>
    <Frame id="icon-agents" title="Saved Agents">
      <div className="relative h-[620px]" style={{ transform: 'translateZ(0)' }}><Mount><AgentsWindow focus={agentsFocus} onFocus={setAgentsFocus} onClose={() => {}} /></Mount></div>
    </Frame>
    <Frame id="icon-subagents" title="Sub-agents — parent conversation’s inspector">
      <div className="h-[380px]"><Mount with={compactAgentsStore}><AgentsView /></Mount></div>
    </Frame>
    <Frame id="icon-select" title="Select — scroll directions">
      <div className="h-[460px] p-4 pt-60">
        <Select defaultValue="16" items={projects}>
          <SelectTrigger aria-label="Choose a project"><SelectValue /></SelectTrigger>
          <SelectContent className="max-h-60">
            {projects.map(project => <SelectItem key={project.value} value={project.value}>{project.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
    </Frame>
    <Frame id="icon-menu" title="Workspace — move and reset order">
      <div className="h-[420px] p-4">
        <Button onClick={() => setMenu(true)}>Project menu</Button>
        {menu && <StoreProvider store={menuStore}><WorkspaceMenu group={{ root: '/preview/project', name: 'Project', folders: ['/preview/project'], sessions: [], updatedAt: 0 }} current={false} actualRoot="/preview/project" at={{ x: 32, y: 60 }} onClose={() => setMenu(false)} onNewWorktree={() => {}} /></StoreProvider>}
      </div>
    </Frame>
  </div>
}
