import { useMemo } from 'react'
import { approvalId, type ForgeGitEntry, type ForgeReference, type Approval } from '@harnessdesk/protocol'
import { Approvals } from '../components/Approvals'
import { GitWriteSettings, ProjectGitRecord, ProjectGitWrites, PullRequestRecord, OutsideHeadBanner } from '../components/GitRecord'
import { Publication } from '../components/Publication'
import { Banner, Page, Text } from '../design'
import { PaneProvider, StoreProvider } from '../state/context'
import { previewStore, PREVIEW_SESSION_KEY } from './harness'
import { Frame } from './main'

export const GIT_GATEWAY_SCENES = ['push', 'steer', 'branch', 'merged', 'bypass', 'pr-record', 'project-all', 'project-outside', 'project-refused', 'project-empty', 'settings', 'override', 'outside-head', 'rewrite'] as const
export const GIT_GATEWAY_ROOT = '/workspace/widgets'
const sha = 'a1b2c3d'.padEnd(40, '0'), branch = 'fix/checkout-retry'
const reference: ForgeReference = { kind: 'pullRequest', action: 'opened', repo: 'acme/widgets', number: 42, url: 'https://github.com/acme/widgets/pull/42', title: 'Retry checkout', state: 'open', author: 'Jane Doe', additions: 12, deletions: 3, files: 2, excerpt: 'Retry a checkout once.', via: 'gh', signature: null }
export const gitRecordFixture: readonly ForgeGitEntry[] = [
  { id: 'merge', op: 'pr.merge', repository: reference.repo, branch: 'main', number: 42, sha, at: 1792877400000, outcome: 'ok', requester: { kind: 'person', id: 'person' }, approval: { by: 'person' } },
  { id: 'outside', op: 'observed', repository: reference.repo, branch, number: 42, sha: 'c0ffee1'.padEnd(40, '0'), at: 1792876200000, outcome: 'ok', requester: { kind: 'outside' }, approval: null },
  { id: 'push', op: 'push', repository: reference.repo, branch, sha, at: 1792874400000, outcome: 'ok', requester: { kind: 'session', id: 'writer', seat: { label: 'Writer', role: 'Fixer', round: 2, team: null }, conversation: { runtime: 'fixture', sessionId: 's1' } }, approval: { by: 'person' } },
  { id: 'refused', op: 'push', repository: reference.repo, branch: 'main', at: 1792872300000, outcome: 'refused', reason: 'The default branch is protected.', requester: { kind: 'session', id: 'writer', seat: { label: 'Writer', role: null, round: null, team: null } }, approval: null },
  { id: 'open', op: 'pr.create', repository: reference.repo, branch, number: 42, sha, at: 1792872120000, outcome: 'ok', requester: { kind: 'session', id: 'writer', seat: { label: 'Writer', role: null, round: null, team: null } }, approval: { by: 'ceiling' } },
]
const counts = { all: gitRecordFixture.length, outside: 1, refused: 1 }
function fixtureStore(scene: string) {
  const own = previewStore(), snapshot = own.getSnapshot()
  let gitWrites = { steer: 'ask', recordOutside: true, projects: {} }
  const request = own.transport.request.bind(own.transport)
  own.transport.request = (async (method: string, input: any) => {
    if (method === 'git/record/list') return { repository: scene === 'project-empty' ? null : reference.repo, counts, entries: scene === 'project-empty' ? [] : gitRecordFixture.filter(row => input?.view === 'outside' || scene === 'project-outside' ? row.requester.kind === 'outside' : input?.view === 'refused' || scene === 'project-refused' ? row.outcome === 'refused' : true) }
    if (method === 'app/state/get') return { gitWrites }
    if (method === 'app/state/set') { gitWrites = { ...gitWrites, ...input.patch.gitWrites }; return { gitWrites } }
    return request(method as never, input as never)
  }) as typeof own.transport.request
  if (scene === 'push' || scene === 'steer') {
    const steer = scene === 'steer'
    const approval: Approval = { id: approvalId(`held-gateway-${scene}`), type: 'permission', sessionId: snapshot.sessions.get(PREVIEW_SESSION_KEY)!.id, requestedAt: 1,
      summary: steer ? 'Writer wants to run git push itself' : `Push ${branch} to acme/widgets`,
      reason: steer ? "Through HarnessDesk the push is recorded and runs without this checkout's git settings. Its own git is not recorded as HarnessDesk's." : "HarnessDesk pushes from its own copy of the repository, as you, and keeps a record of the push. The checkout's own git settings are not used.",
      facts: steer ? [{ label: 'Command', value: `git push -u origin ${branch}` }, { label: 'Becomes', value: `Push ${branch} to acme/widgets · new branch · ${sha.slice(0, 7)}` }] : [{ label: 'Repository', value: 'acme/widgets · pinned for this project' }, { label: 'Branch', value: `${branch} · new branch` }, { label: 'Head', value: `${sha.slice(0, 7)} · 3 commits on main` }],
      options: [{ id: 'allow', label: steer ? 'Push through HarnessDesk' : 'Push', intent: 'approve' }, { id: steer ? 'own' : 'standing', label: steer ? 'Let it use its own git' : 'Push this branch without asking', intent: steer ? 'alternative' : 'approveAlways' }, { id: 'refuse', label: "Don't push", intent: 'deny' }] }
    Object.assign(snapshot, { approvals: [{ key: PREVIEW_SESSION_KEY, approval }] })
  }
  return own
}
const Scene = ({ scene }: { scene: typeof GIT_GATEWAY_SCENES[number] }) => {
  const own = useMemo(() => fixtureStore(scene), [scene])
  return <StoreProvider store={own}><Page width="wide">
    {scene === 'push' || scene === 'steer' ? <PaneProvider scope={{ paneId: 'gateway-preview' as never, view: { kind: 'conversation', session: PREVIEW_SESSION_KEY }, sessionKey: PREVIEW_SESSION_KEY }}><Approvals placement="docked" /></PaneProvider>
      : scene === 'branch' ? <Publication root={GIT_GATEWAY_ROOT} item={{ id: 'branch' as never, type: 'publication', reference: { ...reference, kind: 'branch', number: undefined, ref: branch, sha, previousSha: null, state: null } }} />
      : scene === 'merged' ? <Publication root={GIT_GATEWAY_ROOT} item={{ id: 'merge' as never, type: 'publication', reference: { ...reference, action: 'merged', state: 'merged' } }} />
      : scene === 'bypass' ? <><Text as="p" role="meta">Sent through HarnessDesk · your choice for this project</Text><Banner tone="warning" title="A push went around HarnessDesk">The head was observed as Outside. Nothing is named for it.</Banner></>
      : scene === 'pr-record' ? <><Text as="p" role="section">acme/widgets #42</Text><PullRequestRecord root={GIT_GATEWAY_ROOT} reference={reference} /></>
      : scene.startsWith('project-') ? <ProjectGitRecord root={GIT_GATEWAY_ROOT} initialView={scene === 'project-outside' ? 'outside' : scene === 'project-refused' ? 'refused' : 'all'} />
      : scene === 'settings' ? <GitWriteSettings />
      : scene === 'override' ? <ProjectGitWrites root={GIT_GATEWAY_ROOT} />
      : <OutsideHeadBanner branch={branch} head={'c0ffee1'.padEnd(40, '0')} previous={sha} rewritten={scene === 'rewrite'} onReclaim={() => {}} />}
  </Page></StoreProvider>
}
/** Every state renders the shipped components, on placeholder data only. */
export const GitGatewayFrames = ({ selected }: { readonly selected?: string | null }) => <>{GIT_GATEWAY_SCENES.filter(scene => !selected || scene === selected).map(scene => <Frame key={scene} id={`git-gateway-${scene}`} title={`Git gateway · ${scene}`}><Scene scene={scene} /></Frame>)}</>
