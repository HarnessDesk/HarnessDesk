import { useMemo, useState } from 'react'
import { runtimeId, type Library } from '@harnessdesk/protocol'
import { LibraryFlows, type LibraryFlow } from '../components/LibraryActions'
import { useTheme } from '../state/theme'
import { StoreProvider } from '../state/context'
import { previewStore } from './harness'
import { GITHUB_SOURCE } from './library-github-fixture'

/** The two Library dialogs, with the real flow and method-aware fixture. */
export const LibraryGithubFrames = () => {
  useTheme()
  const store = useMemo(() => previewStore(), [])
  const skill = GITHUB_SOURCE.skills[0]!
  const columns = [{ id: runtimeId('alpha'), label: 'Alpha' }, { id: runtimeId('beta'), label: 'Beta' }]
  const library: Library = { generatedAt: 1, home: '/home/jane', runtimes: columns.map(c => c.id), entries: [], gaps: [], locations: columns.map(c => ({ runtime: c.id, kind: 'skill' as const, scope: 'user' as const, path: `/home/jane/.${c.id}/skills`, scanned: true, exists: true, readOnly: false })) }
  const [flow, setFlow] = useState<LibraryFlow | null>(() => new URLSearchParams(location.search).get('library-github') === 'plan'
    ? { type: 'plan', title: 'Install code-review', intents: [{ kind: 'installSkill', name: skill.name, sourcePath: skill.sourcePath, targetRuntime: columns[0]!.id, origin: { url: GITHUB_SOURCE.url, ref: GITHUB_SOURCE.ref, commit: GITHUB_SOURCE.commit, path: skill.dir, bundle: skill.bundle } }] }
    : { type: 'github' })
  return <StoreProvider store={store}><LibraryFlows flow={flow} setFlow={setFlow} library={library} columns={columns} onApplied={() => {}} /></StoreProvider>
}
