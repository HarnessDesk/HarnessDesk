import { useEffect, useMemo, useRef, useState } from 'react'
import { isReachProblem, type LibraryDefinition, type LibrarySkillOrigin, type LibraryEntry, type LibraryIntent, type LibraryUsage, type RuntimeId } from '@harnessdesk/protocol'
import { useStore } from '../state/context'
import { DestinationBar, useDestinationPage } from '../panels/destination-page'
import { Banner, Button, Chip, CodeBlock, CodeText, EmptyState, MenuItem, PageOptions, PageStack, PageColumns, Section, SectionBody, Row, RowValue, Switch, Text, ToggleGroup, ToggleGroupItem, Toolbar, ToolbarGap, ToolSection, ToolProse, ToolBodyControls, ToolFold, MenuNote } from '../design'
import { CopyIcon, FileIcon, RetryIcon, SlashIcon, TrashIcon, DiffIcon, CrossIcon, DownloadIcon } from './Icons'
import { Markdown } from './Markdown'
import { RuntimeMark } from './BrandIcons'
import { installSource, type LibraryColumn, type LibraryFlow } from './LibraryActions'
import { handOverToComposer } from '../lib/compose'
import { libraryRepository, libraryUpdateFor } from '../lib/library-updates'
import { shortPath } from '../lib/paths'
import { REACH_NAME, REACH_SENTENCE } from '../lib/reach-states'

/** Definition and measured facts share a destination; writes still open reviewed plans. */
const fileSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
export const SkillPage = ({ entry, columns, hosts, cwd, usage, home, onBack, onChanged, onFlow }: {
  readonly entry: LibraryEntry
  readonly columns: readonly LibraryColumn[]
  readonly hosts: { readonly skill: ReadonlySet<RuntimeId> }
  readonly usage: LibraryUsage | null
  readonly home: string | undefined
  readonly cwd: string | undefined
  readonly onBack: () => void
  readonly onChanged: () => void
  readonly onFlow: (flow: LibraryFlow) => void
}) => {
  const store = useStore()
  const { active } = useDestinationPage()
  const [definition, setDefinition] = useState<LibraryDefinition | null>(null)
  const [reading, setReading] = useState(true)
  const [view, setView] = useState<'rendered' | 'source'>('rendered')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState<RuntimeId | null>(null)
  const [rereading, setRereading] = useState(false)
  const [declined, setDeclined] = useState<readonly { runtime: RuntimeId; reason: string }[]>([])
  const [rereadDone, setRereadDone] = useState<ReadonlySet<RuntimeId>>(new Set())
  const [fetching, setFetching] = useState(false)
  const [fetchFailed, setFetchFailed] = useState<string | null>(null)
  const fetchGeneration = useRef(0)
  const update = libraryUpdateFor(entry)
  const source = installSource(entry)
  const labelOf = (runtime: RuntimeId) => columns.find(one => one.id === runtime)?.label ?? runtime
  const staleIn = entry.reach.filter(one => one.state === 'stale')
  const rereadAndStillStale = staleIn.filter(one => rereadDone.has(one.runtime))
  const digests = new Set(entry.copies.filter(one => !one.hollow).map(one => one.digest))

  const sources = new Map<string, LibrarySkillOrigin>()
  for (const { origin } of entry.copies) {
    if (!origin) continue
    const key = JSON.stringify([origin.url, origin.ref, origin.commit, origin.path])
    const previous = sources.get(key)
    if (!previous || (origin.installedAt ?? 0) > (previous.installedAt ?? 0)) sources.set(key, origin)
  }
  const origins = [...sources.values()]
  // One banner per reason. It warns only when a runtime behind it is in a problem state: a note on
  // `off`, `stale` or `unscanned` explains, it does not alarm (isReachProblem, #838).
  const groupedWhy = new Map<string, { names: string[], problem: boolean }>()
  for (const reach of entry.reach) {
    if (reach.note) {
      const group = groupedWhy.get(reach.note) ?? { names: [], problem: false }
      group.names.push(labelOf(reach.runtime))
      group.problem ||= isReachProblem(reach.state)
      groupedWhy.set(reach.note, group)
    }
  }
  const installable = columns.filter(column => {
    const reach = entry.reach.find(one => one.runtime === column.id)
    return digests.size <= 1 && source !== null && hosts.skill.has(column.id) && (reach?.state === 'absent' || reach?.state === 'unscanned')
  })
  const hollowCopies = entry.copies.filter(copy => copy.hollow && !copy.readOnly)
  const refusedBy = entry.reach.filter(reach => reach.state === 'rejected')
  const fired = usage?.skills[entry.name]
  const install = (targets: readonly LibraryColumn[]) => {
    if (!source) return
    onFlow({ type: 'plan', title: `Install ${entry.name} for ${targets.length === 1 ? targets[0]!.label : `${targets.length} runtimes`}`,
      intents: targets.map(column => ({ kind: 'installSkill', name: entry.name, sourcePath: source.path, targetRuntime: column.id })) })
  }

  useEffect(() => {
    setFetching(false)
    setFetchFailed(null)
    return () => { fetchGeneration.current++ }
  }, [entry, active])

  // Read the same loadable copy that an install would carry, never a stranded namesake.
  useEffect(() => {
    if (!active) return
    let live = true
    setReading(true)
    setDefinition(null)
    if (source === null) { setReading(false); return }
    void store.transport.request('library/definition', { kind: 'skill', name: entry.name, path: source.path, ...(cwd !== undefined ? { cwd } : {}) }).then(answer => {
      if (!live) return
      const one = answer as Partial<LibraryDefinition> | null
      setDefinition(one && typeof one.text === 'string' ? {
        name: entry.name, kind: 'skill', path: typeof one.path === 'string' ? one.path : source.path,
        text: one.text, truncated: one.truncated === true, files: Array.isArray(one.files) ? one.files : [],
        moreFiles: typeof one.moreFiles === 'number' ? one.moreFiles : 0,
      } : null)
    }).catch(() => { if (live) setDefinition(null) }).finally(() => { if (live) setReading(false) })
    return () => { live = false }
  }, [active, store, entry.name, source?.path, source?.digest, cwd])

  const { front, body } = useMemo(() => {
    const text = definition?.text ?? ''
    const end = text.startsWith('---') ? text.indexOf('\n---', 3) : -1
    if (end === -1) return { front: null, body: text }
    const after = text.indexOf('\n', end + 1)
    return { front: text.slice(3, end).trim(), body: after === -1 ? '' : text.slice(after + 1) }
  }, [definition])

  const reviewUpdate = async () => {
    if (fetching) return
    const ticket = fetchGeneration.current
    const current = () => ticket === fetchGeneration.current
    setFetching(true)
    setFetchFailed(null)
    try {
      const fetched = new Map<string, Extract<LibraryIntent, { kind: 'updateSkill' }>['origin']>()
      const intents: LibraryIntent[] = []
      for (const one of entry.update ?? []) {
        if (one.status !== 'behind') continue
        const { url, ref, path } = one.origin
        const key = JSON.stringify([url, ref, path])
        let origin = fetched.get(key)
        if (!origin) {
          const answer = await store.transport.request('library/source/fetch', { url, ref, path })
          if (!current()) return
          const refused = answer.refused.find(folder => folder.dir === path)
          const skill = answer.skills.find(skill => skill.dir === path)
          if (refused || !skill) throw new Error(refused?.reason ?? `No skill was found at ${path || 'the repository root'}.`)
          origin = { url, ref, commit: answer.commit, path: skill.dir, bundle: skill.bundle }
          fetched.set(key, origin)
        }
        intents.push({ kind: 'updateSkill', name: entry.name, targetRuntime: one.runtime, origin })
      }
      if (current() && intents.length) onFlow({ type: 'plan', title: `Update ${entry.name}`, intents })
    } catch (error) {
      if (current()) setFetchFailed(error instanceof Error ? error.message : String(error))
    } finally {
      if (current()) setFetching(false)
    }
  }
  const flip = async (runtime: RuntimeId, reportedPath: string | undefined, next: boolean) => {
    setBusy(runtime)
    try {
      await store.setSkillEnabled({ name: entry.name, path: reportedPath ?? null }, next, runtime)
    } catch {
      // The store reports the failure. The rescan restores the runtime's actual state.
    } finally { setBusy(null); onChanged() }
  }
  const reread = async () => {
    setRereading(true)
    setDeclined([])
    const refused: { runtime: RuntimeId; reason: string }[] = []
    const done = new Set<RuntimeId>()
    for (const one of staleIn) {
      try {
        const answer = await store.transport.request('runtime/refreshCatalog', { runtime: one.runtime })
        if (answer.refreshed) done.add(one.runtime)
        else refused.push({ runtime: one.runtime, reason: answer.reason ?? 'It did not re-read.' })
      } catch (error) { refused.push({ runtime: one.runtime, reason: error instanceof Error ? error.message : String(error) }) }
    }
    setDeclined(refused); setRereadDone(done); setRereading(false)
    if (done.size > 0) onChanged()
  }
  const copy = () => {
    if (!definition) return
    void navigator.clipboard.writeText(definition.text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    })
  }

  return <PageStack data-slot="skill-page">
    <DestinationBar place={entry.name} more={close => <>
      <MenuItem icon={<RetryIcon size={16} />} label="Rescan" onSelect={() => { onChanged(); close() }} />
      {digests.size > 1 && <MenuItem icon={<DiffIcon size={16} />} label="Resolve copies…" onSelect={() => { onFlow({ type: 'resolve', entry }); close() }} />}
      {hollowCopies.length > 0 && <MenuItem icon={<CrossIcon size={16} />} label={`Clean up empty ${hollowCopies.length === 1 ? 'copy' : 'copies'}`} onSelect={() => {
        onFlow({ type: 'plan', title: `Clean up empty copies of ${entry.name}`, intents: hollowCopies.map(copy => ({ kind: 'removeCopy', name: entry.name, path: copy.path })) }); close()
      }} />}
      {installable.length > 3 ? <MenuItem icon={<DownloadIcon size={16} />} label={`Install to all ${installable.length} missing…`} onSelect={() => { install(installable); close() }} />
        : installable.map(column => <MenuItem key={column.id} icon={<DownloadIcon size={16} />} label={`Install to ${column.label}`} onSelect={() => { install([column]); close() }} />)}
      {refusedBy.length > 0 && installable.length > 0 && <MenuNote>{refusedBy.map(reach => labelOf(reach.runtime)).join(', ')} would not load this one.</MenuNote>}
      {installable.length === 0 && <MenuNote>{entry.reach.every(one => one.state === 'reaches') ? 'Every runtime already loads this.' : digests.size > 1 ? 'Resolve the copies before installing anywhere else.' : 'Nowhere left to install this.'}</MenuNote>}
      {entry.copies.filter(copy => !copy.readOnly).map(copy => <MenuItem key={copy.path} icon={<TrashIcon size={16} />} label={`Remove the copy at ${shortPath(copy.path, home)}`} danger
        title={`Remove ${copy.path} — previewed first, backed up before it goes`} onSelect={() => {
          onFlow({ type: 'plan', title: `Remove a copy of ${entry.name}`, intents: [{ kind: 'removeCopy', name: entry.name, path: copy.path }] }); close()
        }} />)}
    </>} />
    <PageOptions title={entry.name}><Toolbar>
      <Button variant="outline" size="sm" onClick={() => {
        store.returnToWork()
        void handOverToComposer({ text: `/${entry.name} ` }).then(received => {
          if (!received) store.notice('warning', 'The message box did not take it — click into the conversation and try again.')
        })
      }}><SlashIcon size={13} />Use in composer</Button>
      <Button variant="ghost" size="sm" onClick={onBack}>Back to Library</Button>
      <Chip tone={update?.status === 'behind' ? 'info' : 'neutral'}>{update?.status === 'behind' ? 'Update available' : 'Skill'}</Chip>
    </Toolbar></PageOptions>
    {entry.description && <Markdown text={entry.description} document />}
    {[...groupedWhy].map(([note, group]) => <Banner key={note} tone={group.problem ? 'warning' : 'neutral'} measure="container" title={group.names.join(', ')}>{note}</Banner>)}
    {digests.size > 1 && <Banner tone="warning" measure="container" title="Resolve the copies before installing anywhere else." />}
    <PageColumns data-slot="skill-page-columns" asideProps={{ 'data-slot': 'skill-page-facts' }} aside={<>
        {update && <ToolSection label="Update" fold value={update.status === 'behind' ? 'Available' : update.status === 'gone' ? 'Source gone' : 'Read failed'}>
          {update.status === 'behind' && <>
            <Row density="compact" title="Update available" />
            <ToolProse variant="note">{fetchFailed ?? `${update.origin.commit.slice(0, 7)} → ${update.latest?.slice(0, 7) ?? ''}`}</ToolProse>
            <ToolBodyControls><Button variant="outline" size="sm" disabled={fetching} onClick={() => void reviewUpdate()}>{fetching ? 'Fetching…' : 'Review update…'}</Button></ToolBodyControls>
          </>}
          {update.status === 'gone' && <>
            <Row density="compact" title="Source branch is gone" />
            <ToolProse><Text tone="warning">The branch {update.origin.ref} no longer exists in {libraryRepository(update.origin)}.</Text></ToolProse>
          </>}
          {update.status === 'unreachable' && <ToolProse variant="note">Could not check: {update.reason}</ToolProse>}
        </ToolSection>}
        {(entry.reach.length > 0 || rereading || declined.length > 0) && <ToolSection label="Loaded by" fold value={`${entry.reach.filter(one => one.state === 'reaches').length} of ${entry.reach.length}`}>
          {entry.reach.map(reach => {
            const column = columns.find(one => one.id === reach.runtime)
            const switchable = reach.basis === 'reported' && reach.toggleable !== false && (reach.state === 'reaches' || reach.state === 'off')
            const installable = digests.size <= 1 && source !== null && hosts.skill.has(reach.runtime) && (reach.state === 'absent' || reach.state === 'unscanned')
            const value = switchable ? reach.state === 'reaches' ? 'On' : 'Off' : reach.state === 'reaches' ? 'Loads it' : REACH_NAME[reach.state]
            return <Row density="compact" key={reach.runtime} face={column?.info && <RuntimeMark runtime={column.info} size={16} />} title={labelOf(reach.runtime)}
              tooltip={`${labelOf(reach.runtime)} — ${REACH_SENTENCE[reach.state]}`} control={<><RowValue>{!switchable && isReachProblem(reach.state) ? <Text tone="warning">{value}</Text> : value}</RowValue>
              {switchable ? <Switch checked={reach.state === 'reaches'} disabled={busy === reach.runtime} aria-label={`${entry.name} in ${labelOf(reach.runtime)}`} onCheckedChange={next => void flip(reach.runtime, reach.reportedPath, next)} />
                : installable ? <Button variant="ghost" size="sm" onClick={() => onFlow({ type: 'plan', title: `Install ${entry.name} for ${labelOf(reach.runtime)}`, intents: [{ kind: 'installSkill', name: entry.name, sourcePath: source.path, targetRuntime: reach.runtime }] })}>Install</Button> : undefined}</>} />
          })}
          {staleIn.length > 0 && <>
            <ToolProse variant="note">{staleIn.length === 1 ? `${labelOf(staleIn[0]!.runtime)} lists the skills it read when it started.` : `${staleIn.length} runtimes list the skills they read when they started.`}</ToolProse>
            <ToolBodyControls><Button variant="outline" size="xs" disabled={rereading} onClick={() => void reread()}>{rereading ? 'Asking…' : 'Have it look again'}</Button></ToolBodyControls>
          </>}
          {declined.map(one => <ToolProse key={one.runtime} variant="note"><Text tone="warning">{labelOf(one.runtime)} — {one.reason}</Text></ToolProse>)}
          {rereadAndStillStale.length > 0 && <ToolProse variant="note"><Text tone="warning">{rereadAndStillStale.length === 1
            ? `${labelOf(rereadAndStillStale[0]!.runtime)} re-read and still does not list it — the definition may be one it will not accept.`
            : `${rereadAndStillStale.length} of them re-read and still do not list it — the definition may be one they will not accept.`}</Text></ToolProse>}
          {entry.reach.some(one => one.basis === 'scanned') && <ToolProse variant="note">{entry.reach.every(one => one.basis === 'scanned')
            ? 'Read from disk against this build’s table of where each runtime looks — the runtimes themselves were not asked.'
            : 'Some rows are what the runtime itself reported; the rest are read from disk.'}</ToolProse>}
        </ToolSection>}
        <ToolSection label="Source" fold defaultOpen={false} value={origins.length > 0 ? `${origins.length} ${origins.length === 1 ? 'origin' : 'origins'}` : 'This Mac'}>
          {origins.length === 0 ? <Row density="compact" title="This Mac" /> : origins.map(origin => <div key={JSON.stringify(origin)}>
            <Row density="compact" title={<CodeText>{libraryRepository(origin)}</CodeText>} />
            <ToolProse variant="note">{origin.path || 'Repository root'} · {origin.ref}, pinned at {origin.commit.slice(0, 7)}</ToolProse>
            {origin.installedAt !== undefined && <Row density="compact" title="Installed" tooltip="Installed or updated" control={<RowValue numeric>{new Date(origin.installedAt).toLocaleDateString()}</RowValue>} />}
          </div>)}
          {entry.copies.map(copy => <div key={copy.path}>
            <Row density="compact" title={<CodeText wrap>{shortPath(copy.path, home)}</CodeText>} />
            <ToolProse variant="note">{copy.hollow ? 'No definition inside — the name lists and nothing loads.' : copy.readBy.length === 0 ? 'No runtime reads this directory.' : `Read by ${copy.readBy.map(labelOf).join(', ')}.`}{copy.readOnly && ' Shipped by the runtime.'}</ToolProse>
          </div>)}
        </ToolSection>
        <ToolSection label="Files" fold defaultOpen={false} value={definition ? `${definition.files.length + definition.moreFiles || 1}` : reading ? 'Reading…' : 'Not read'}>
          {definition === null ? <ToolProse variant="note">{reading ? 'Reading files…' : 'No file list to read'}</ToolProse> : <>
            {definition.files.length === 0 && <Row density="compact" title={<CodeText>SKILL.md</CodeText>} />}
            {definition.files.slice(0, 5).map(file => <Row density="compact" key={file.path} title={<CodeText wrap>{file.path}</CodeText>} titleChip={(file.runnable || file.binary) && <>{file.runnable && <Chip tone="neutral">Can run</Chip>}{file.binary && <Chip tone="neutral">Binary</Chip>}</>} control={<RowValue numeric>{fileSize(file.bytes)}</RowValue>} />)}
            {definition.files.length > 5 && <ToolFold label="Show all files">{definition.files.slice(5).map(file => <Row density="compact" key={file.path} title={<CodeText wrap>{file.path}</CodeText>} titleChip={(file.runnable || file.binary) && <>{file.runnable && <Chip tone="neutral">Can run</Chip>}{file.binary && <Chip tone="neutral">Binary</Chip>}</>} control={<RowValue numeric>{fileSize(file.bytes)}</RowValue>} />)}</ToolFold>}
            {definition.moreFiles > 0 && <ToolProse variant="note">and {definition.moreFiles} more {definition.moreFiles === 1 ? 'file' : 'files'} not listed</ToolProse>}
          </>}
        </ToolSection>
        <ToolSection label="Cost" fold defaultOpen={false} value={entry.catalogTokens ? `≈${entry.catalogTokens} tok/turn` : 'Not measured'}>
          <Row density="compact" title="Every turn" control={<RowValue numeric><span title="Name and description at ≈3.6 characters per token — the catalogue line a runtime carries for every skill it loads, fired or not.">{entry.catalogTokens ? `≈${entry.catalogTokens} tok` : '—'}</span></RowValue>} />
          {usage !== null && <Row density="compact" title="Fired here" control={<RowValue numeric>{fired ? `${fired.activations}× in ${fired.sessions} ${fired.sessions === 1 ? 'conversation' : 'conversations'}` : 'never'}</RowValue>} />}
          {usage !== null && fired && fired.lastAt > 0 && <Row density="compact" title="Last used" control={<RowValue numeric>{new Date(fired.lastAt).toLocaleDateString()}</RowValue>} />}
          <Row density="compact" title="On disk" control={<RowValue numeric>{entry.copies.length} {entry.copies.length === 1 ? 'copy' : 'copies'}</RowValue>} />
          {usage !== null && <ToolProse variant="note">Counted in the {usage.sessionsScanned} conversations this desk stores. What ran elsewhere is not counted.</ToolProse>}
        </ToolSection>
    </>}>
      <Section aria-label="Definition" variant="document" header={<>
          <FileIcon size={16} /><Text role="row">SKILL.md</Text>
          <ToolbarGap />
          <ToggleGroup type="single" size="sm" variant="chips" aria-label="How to show the definition" value={view} onValueChange={next => { if (next) setView(next as typeof view) }}>
            <ToggleGroupItem value="rendered">Rendered</ToggleGroupItem>
            <ToggleGroupItem value="source">Source</ToggleGroupItem>
          </ToggleGroup>
          <Button variant="ghost" size="sm" disabled={definition === null} onClick={copy} title="Copy the definition exactly as it sits on disk"><CopyIcon size={13} />{copied ? 'Copied' : 'Copy'}</Button>
        </>}>
        <SectionBody spacing="document">
          {reading ? <EmptyState variant="inline" title="Reading the definition…" /> : definition === null ? <EmptyState tight title="No definition to read" description={entry.copies.every(one => one.hollow)
            ? 'Every copy is an empty directory.' : 'This definition could not be read. Rescan to check again.'} /> : view === 'source'
            ? <Text as="div" role="muted"><CodeText as="pre" wrap>{definition.text}</CodeText></Text>
            : <PageStack>{front !== null && <PageStack spacing="caption"><Text as="p" role="meta" title="What the runtime reads every turn to decide whether to fire this skill — the line the catalogue estimate prices.">Frontmatter</Text><CodeBlock output={front} /></PageStack>}<Markdown text={body} document /></PageStack>}
          {definition?.truncated && <Text as="p" role="meta">This definition is longer than the page reads; what is shown stops short of the end of the file.</Text>}
        </SectionBody>
      </Section>
    </PageColumns>
  </PageStack>
}
