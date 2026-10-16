import { useMemo, useState } from 'react'
import { runtimeId } from '@harnessdesk/protocol'
import type { LibraryIntent, LibraryPlannedOp, LibrarySkillUpdate } from '@harnessdesk/protocol'
import { LibraryFlows, type LibraryFlow } from '../components/LibraryActions'
import { App } from '../app/App'
import { StoreProvider } from '../state/context'
import { previewStore } from './harness'
import { frameDestinationStore } from './frame-destination-store'
import { libraryUpdateFixture, libraryUpdatePlan, UPDATE_ORIGIN, UPDATE_SOURCE } from './library-updates-fixture'

/** Real Library navigation and flows over a method-aware, repository-only fixture. */
export const LibraryUpdateFrames = () => {
  const store = useMemo(() => {
    const query = new URLSearchParams(location.search)
    const scenario = query.get('library-updates')
    const status = ['current', 'gone', 'unreachable', 'unchecked'].includes(scenario ?? '') ? scenario as LibrarySkillUpdate['status'] | 'unchecked' : 'behind'
    let library = libraryUpdateFixture(status)
    const base = previewStore()
    const runtime = base.getSnapshot().runtimes[0]!
    const own = frameDestinationStore(previewStore({ agents: [], runtimes: [{ ...runtime, id: runtimeId('alpha'), presentation: { ...runtime.presentation, name: 'Alpha' } }] }))
    const request = own.transport.request.bind(own.transport)
    own.transport.request = async (method, params) => {
      if (method === 'library/read') return library
      if (method === 'library/sources/check') { library = libraryUpdateFixture(); return library.entries[0]!.update! }
      if (method === 'library/definition') return { name: 'code-review', kind: 'skill', path: library.entries[0]!.copies[0]!.path, text: '---\nname: code-review\ndescription: Review the current diff for correctness bugs.\n---\n\n# Code review\n\nCorrectness first. Read the diff, trace its callers and report only actionable findings.', truncated: false, files: [{ path: 'SKILL.md', bytes: 1230 }, { path: 'templates/old.md', bytes: 420 }], moreFiles: 0 }
      if (method === 'library/source/fetch') return UPDATE_SOURCE
      if (method === 'library/source/file') return { text: '#!/bin/sh\n# Check the files being reviewed.\ngit diff --check\n', truncated: false }
      if (method === 'library/plan') return libraryUpdatePlan((params as { intents: LibraryIntent[] }).intents, scenario === 'edited' || scenario === 'plan-edited')
      if (method === 'library/apply') { library = libraryUpdateFixture('unchecked'); return (params as { ops: LibraryPlannedOp[] }).ops.map(op => ({ id: op.id, outcome: 'done' as const })) }
      if (method === 'library/usage') return { generatedAt: 1, sessionsScanned: 0, skills: {} }
      if (method === 'audit/query') return []
      return request(method, params)
    }
    own.openDestination({ kind: 'library', section: 'skill' })
    return own
  }, [])
  const [flow, setFlow] = useState<LibraryFlow | null>(() => new URLSearchParams(location.search).get('library-updates')?.startsWith('plan-')
    ? { type: 'plan', title: 'Update code-review', intents: [{ kind: 'updateSkill', name: 'code-review', targetRuntime: runtimeId('alpha'), origin: { ...UPDATE_ORIGIN, commit: UPDATE_SOURCE.commit, bundle: UPDATE_SOURCE.skills[0]!.bundle } }] }
    : null)
  return <StoreProvider store={store}><App /><LibraryFlows flow={flow} setFlow={setFlow} library={libraryUpdateFixture()} columns={[{ id: runtimeId('alpha'), label: 'Alpha' }]} onApplied={() => {}} /></StoreProvider>
}
