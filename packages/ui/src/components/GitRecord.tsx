import { useEffect, useState } from 'react'
import { gitWritePreferences, type ForgeGitEntry, type ForgeReference, type HostResult, type GitSteerMode, type GitWritePreferences, type GitWriteProjectMode, runtimeId, sessionId, type GoalId } from '@harnessdesk/protocol'
import { Banner, Button, Chip, MenuNote, NativeSelect, Note, PageRecords, PageRecordViews, Row, RowMark, Rows, RowValue, Section, SectionHead, Switch, Text } from '../design'
import { GlobeIcon, MergeIcon, PullRequestIcon, PushIcon } from './Icons'
import { useStore } from '../state/context'
import { useDestinationActive } from '../panels/destination-page'
import { openExternal } from '../lib/desktop'

type RecordPage = HostResult<'git/record/list'>
type View = 'all' | 'outside' | 'refused'
const when = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const who = (row: ForgeGitEntry): string => row.requester.kind === 'outside' ? 'Not recorded here' : row.requester.kind === 'person' ? 'You' : row.requester.seat?.role ? `${row.requester.seat.role}${row.requester.seat.round ? ` · round ${row.requester.seat.round}` : ''}` : row.requester.seat?.label ?? (row.requester.kind === 'lead-goal' ? 'Lead goal' : 'Conversation')
const where = (row: ForgeGitEntry) => [row.number ? `#${row.number}` : '', row.branch].filter(Boolean).join(' · ') || row.repository
const title = (row: ForgeGitEntry) => row.outcome === 'refused' || row.outcome === 'rejected' ? `${row.op === 'push' ? 'Push' : 'Write'} refused` : row.op === 'observed' ? `Head moved to ${row.sha?.slice(0, 7) ?? 'unknown'}` : row.op === 'push' ? `Pushed ${row.sha?.slice(0, 7) ?? row.branch ?? ''}` : `${({ 'pr.create': 'Opened', 'pr.update': 'Updated', 'pr.merge': 'Merged', 'pr.comment': 'Commented on', 'pr.review': 'Reviewed', 'issue.comment': 'Commented on' } as const)[row.op]} #${row.number ?? ''}`
const mark = (row: ForgeGitEntry) => row.requester.kind === 'outside' ? <GlobeIcon size={16} /> : row.op === 'push' ? <PushIcon size={16} /> : row.op === 'pr.merge' ? <MergeIcon size={16} /> : <PullRequestIcon size={16} />
const state = (row: ForgeGitEntry) => row.outcome === 'refused' || row.outcome === 'rejected' ? <Chip tone="danger">Refused</Chip> : row.outcome === 'failed' ? <Chip tone="danger">Failed</Chip> : row.requester.kind === 'outside' ? <Chip tone="warning">Outside</Chip> : row.outcome === 'intent' ? <Chip tone="neutral">Pending</Chip> : <Chip tone="success">Done</Chip>

function useRecord(root: string, branch?: string, number?: number, view: View = 'all') {
  const store = useStore(), active = useDestinationActive()
  const [page, setPage] = useState<RecordPage | null>(null), [problem, setProblem] = useState<string | null>(null), [earlier, setEarlier] = useState(false)
  const [cursor, setCursor] = useState<string | undefined>()
  useEffect(() => { setCursor(undefined); setPage(null) }, [root, branch, number, view])
  useEffect(() => {
    if (!active) return
    let generation = 0, live = true
    const read = async (append = false) => {
      const current = ++generation
      try {
        const next = await store.transport.request('git/record/list', { root, ...(branch ? { branch } : {}), ...(number ? { number } : {}), view, limit: 50, ...(append && cursor ? { before: cursor } : {}) })
        if (!live || generation !== current) return
        setPage(previous => append && previous ? { ...next, entries: [...previous.entries, ...next.entries] } : next); setEarlier(next.entries.length === 50); setProblem(null)
      } catch (error) { if (live && generation === current) setProblem(error instanceof Error ? error.message : String(error)) }
    }
    void read(Boolean(cursor))
    const refresh = () => { setCursor(undefined); void read() }
    const off = store.onGitRecordChange?.(refresh)
    window.addEventListener('focus', refresh)
    return () => { live = false; off?.(); window.removeEventListener('focus', refresh) }
  }, [store, active, root, branch, number, view, cursor])
  return { page, problem, earlier, more: () => setCursor(page?.entries.at(-1)?.id) }
}

/** One record vocabulary in the PR hover card and the Lead's PR panel. */
export const GitRecordRows = ({ entries }: { readonly entries: readonly ForgeGitEntry[] }) => <>
  <SectionHead name="Record" level="label" />
  <Rows>{entries.length ? entries.map(row => <Row key={row.id} mark={<RowMark>{mark(row)}</RowMark>} title={title(row)}
    titleChip={row.requester.kind === 'outside' ? <Chip tone="warning">Outside</Chip> : undefined}
    desc={row.requester.kind === 'outside' ? `Seen ${when(row.at)}. Not written through HarnessDesk, so no one here is named.` : `${who(row)} · ${where(row)} · ${when(row.at)}${row.reason ? ` · ${row.reason}` : ''}`} />) : <Row title="No writes recorded for this pull request." />}</Rows>
</>
export const PullRequestRecord = ({ root, reference, branch }: { readonly root: string; readonly reference: Pick<ForgeReference, 'repo' | 'number'>; readonly branch?: string }) => {
  const { page, problem, earlier, more } = useRecord(root, branch, reference.number)
  if (problem) return <Note tone="bad">{problem}</Note>
  if (!page || page.repository !== reference.repo) return null
  return <><GitRecordRows entries={page.entries} />{earlier && <Button variant="ghost" onClick={more}>Show earlier</Button>}</>
}
export const ProjectGitRecord = ({ root, initialView = 'all' }: { readonly root: string; readonly initialView?: View }) => {
  const store = useStore(), [view, setView] = useState<View>(initialView), { page, problem, earlier, more } = useRecord(root, undefined, undefined, view)
  const open = (row: ForgeGitEntry) => {
    if (row.requester.kind !== 'outside' && row.requester.conversation) { const conversation = row.requester.conversation; void store.openSession(sessionId(conversation.sessionId), { runtime: runtimeId(conversation.runtime) }); return }
    if (row.requester.kind === 'lead-goal') { store.openGoal(row.requester.id as GoalId); return }
    openExternal(`https://github.com/${row.repository}/${row.number ? `${row.op === 'issue.comment' ? 'issues' : 'pull'}/${row.number}` : `tree/${encodeURIComponent(row.branch ?? '')}`}`)
  }
  return <Section title="Git record" description={page?.repository ?? undefined}>
    {problem ? <Note tone="bad">{problem}</Note> : !page ? <Rows><Row title="Reading…" /></Rows> : !page.repository ? <Note>No pushes yet. The first push you approve pins this project's repository.</Note> : <>
      <PageRecordViews label="Git record views" value={view} change={setView} choices={(['all', 'outside', 'refused'] as const).map(value => ({ value, label: { all: 'All', outside: 'Outside', refused: 'Refused' }[value], count: page.counts[value] }))} />
      {page.entries.length ? <PageRecords label="Git record" columns={[{ id: 'where', label: 'Where' }, { id: 'who', label: 'Who' }, { id: 'when', label: 'When' }]} groups={[{ id: 'record', label: page.repository, rows: page.entries.map(row => ({ id: row.id, title: title(row), description: row.reason, mark: mark(row), state: state(row), values: { where: where(row), who: who(row), when: when(row.at) }, compact: `${who(row)} · ${where(row)} · ${when(row.at)}`, open: () => open(row) })) }]} /> : <Note>No {view === 'all' ? '' : `${view} `}writes recorded.</Note>}
      {earlier && <Button variant="ghost" onClick={more}>Show earlier</Button>}
    </>}
  </Section>
}

const modes: Readonly<Record<GitSteerMode, string>> = { ask: 'Ask each time', redirect: 'Always', off: 'Never' }
function usePreferences() {
  const store = useStore(), [preferences, setPreferences] = useState<GitWritePreferences | null>(null), [problem, setProblem] = useState<string | null>(null)
  const read = (raw: unknown): GitWritePreferences => ({ ...gitWritePreferences(raw), projects: (raw as GitWritePreferences | undefined)?.projects ?? {} })
  useEffect(() => { let live = true; void store.transport.request('app/state/get', {}).then(value => { if (live) setPreferences(read(value?.['gitWrites'])) }, error => { if (live) setProblem(String(error)) }); return () => { live = false } }, [store])
  const save = async (patch: Partial<GitWritePreferences>) => { try { const result = await store.transport.request('app/state/set', { patch: { gitWrites: patch } }); setPreferences(read(result['gitWrites'])); setProblem(null) } catch (error) { setProblem(String(error)) } }
  return { preferences, save, problem }
}
export const GitWriteSettings = () => {
  const { preferences, save, problem } = usePreferences()
  return <Section title="Git writes" description="Pushes and pull-request writes made through HarnessDesk are always recorded.">
    {problem && <Note tone="bad">{problem}</Note>}
    {preferences && <Rows>
      <Row title="Send agents' own pushes through HarnessDesk" desc="When an agent runs git push or a pull-request command itself. Changes apply to new conversations. Never also applies to conversations already open."
        control={<NativeSelect aria-label="Send agents' own pushes through HarnessDesk" value={preferences.steer} onChange={event => void save({ steer: event.target.value as GitSteerMode })}>{Object.entries(modes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</NativeSelect>} />
      <Row title="Record pushes HarnessDesk did not make" desc="A branch head that moves outside HarnessDesk is marked Outside in the record."
        control={<Switch aria-label="Record pushes HarnessDesk did not make" checked={preferences.recordOutside} onCheckedChange={recordOutside => void save({ recordOutside })} />} />
    </Rows>}
  </Section>
}
export const ProjectGitWrites = ({ root }: { readonly root: string }) => {
  const { preferences, save, problem } = usePreferences(), { page } = useRecord(root)
  return <Section title="Git writes" description="Git writes for this project only.">
    {problem && <Note tone="bad">{problem}</Note>}
    <Rows><Row mark={<RowMark><PushIcon size={16} /></RowMark>} title="Pushes go to" desc="Pinned when you approve the first push. A checkout's remote cannot change it." control={<RowValue>{page?.repository ?? 'Not pinned'}</RowValue>} />
      {preferences && <Row title="Agents' own pushes" control={<NativeSelect aria-label="Agents' own pushes" value={preferences.projects?.[root] ?? 'inherit'} onChange={event => void save({ projects: { ...preferences.projects, [root]: event.target.value as GitWriteProjectMode } })}>
        <option value="inherit">As in Settings ({modes[preferences.steer]})</option><option value="redirect">Always</option><option value="ask">Ask</option><option value="off">Never</option>
      </NativeSelect>} />}</Rows>
    <MenuNote>With Never, an agent's own push still shows in the record as Outside. Nothing is named for it.</MenuNote>
  </Section>
}

export const OutsideHeadBanner = ({ branch, head, previous, rewritten = false, onReclaim, disabled }: { readonly branch: string; readonly head: string; readonly previous?: string; readonly rewritten?: boolean; readonly onReclaim: () => void; readonly disabled?: boolean }) => <Banner tone={rewritten ? 'danger' : 'warning'} actions={<Button disabled={disabled} onClick={onReclaim}>Take the branch back</Button>}>
  <Text as="strong">{branch} {rewritten ? 'was rewritten' : 'moved'} outside HarnessDesk</Text>{' '}
  {rewritten ? `Its head ${head.slice(0, 7)} does not contain ${previous?.slice(0, 7) ?? 'the last head HarnessDesk pushed'}. Nothing is pushed to it until you decide.` : `Its head is now ${head.slice(0, 7)}${previous ? `, on top of ${previous.slice(0, 7)}` : ''}. HarnessDesk did not write it, so it names no one, and it stops pushing to this branch until you take it back. Checks and reviews on the new head are still followed.`}
</Banner>
