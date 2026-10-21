import { useEffect, useRef, useState } from 'react'
import { isReachProblem, type LibraryDefinition, type LibraryEntry, type RuntimeId } from '@harnessdesk/protocol'
import { useStore } from '../state/context'
import { Badge, Button, CodeText, DialogBody, DialogContent, DialogHead, DialogRoot, EmptyState, FormStack, IconTile, Note, SectionFooter, Separator, Text, ToggleGroup, ToggleGroupItem } from '../design'
import { AlertIcon, CopyIcon, FileIcon, TrashIcon } from './Icons'
import { RuntimeMark } from './BrandIcons'
import { Markdown } from './Markdown'
import { shortPath } from '../lib/paths'
import { REACH_SENTENCE } from '../lib/reach-states'
import { installSource, type LibraryColumn, type LibraryFlow } from './LibraryActions'

/** MCP keeps its existing reading dialog; skills have their own destination. */
export const McpSheet = ({ entry, columns, hosts, cwd, home, onFlow, onChanged, onClose }: {
  entry: LibraryEntry
  columns: readonly LibraryColumn[]
  hosts: { readonly mcp: ReadonlySet<RuntimeId> }
  cwd: string | undefined
  home: string | undefined
  onFlow: (flow: LibraryFlow) => void
  onChanged: () => void
  onClose: () => void
}) => {
  const store = useStore()
  const surface = useRef<HTMLDivElement>(null)
  const [definition, setDefinition] = useState<LibraryDefinition | null>(null)
  const [reading, setReading] = useState(true)
  const [view, setView] = useState<'rendered' | 'source'>('rendered')
  const [copied, setCopied] = useState(false)
  const source = installSource(entry)
  const digests = new Set(entry.copies.filter(copy => !copy.hollow).map(copy => copy.digest))
  const mcpSource = entry.copies.find(copy => copy.readBy.length > 0) ?? entry.copies[0]
  const labelOf = (runtime: RuntimeId) => columns.find(one => one.id === runtime)?.label ?? runtime
  const installable = columns.filter(column => {
    const state = entry.reach.find(reach => reach.runtime === column.id)?.state
    return entry.copies.length > 0 && hosts.mcp.has(column.id) && (state === 'absent' || state === 'unscanned')
  })
  const groupedWhy = new Map<string, string[]>()
  const facts = new Map<string, { count: number; warning: boolean }>()
  for (const reach of entry.reach) {
    if (reach.note) groupedWhy.set(reach.note, [...(groupedWhy.get(reach.note) ?? []), labelOf(reach.runtime)])
    const sentence = REACH_SENTENCE[reach.state], fact = facts.get(sentence) ?? { count: 0, warning: false }
    fact.count++; fact.warning ||= isReachProblem(reach.state); facts.set(sentence, fact)
  }
  const repeated = [...facts].filter(([, fact]) => fact.count > 1)
  const install = (targets: readonly LibraryColumn[]) => {
    if (!mcpSource) return
    onFlow({ type: 'plan', title: `Add ${entry.name} for ${targets.length === 1 ? targets[0]!.label : `${targets.length} runtimes`}`,
      intents: targets.map(column => ({ kind: 'installMcp', name: entry.name, sourcePath: mcpSource.path, targetRuntime: column.id })) })
  }
  const staleIn = entry.reach.filter(reach => reach.state === 'stale')
  const [rereading, setRereading] = useState(false)
  const [declined, setDeclined] = useState<readonly { runtime: RuntimeId; reason: string }[]>([])
  const [rereadDone, setRereadDone] = useState<ReadonlySet<RuntimeId>>(new Set())
  const reread = async () => {
    setRereading(true); setDeclined([])
    const refused: { runtime: RuntimeId; reason: string }[] = [], done = new Set<RuntimeId>()
    for (const reach of staleIn) {
      try {
        const answer = await store.transport.request('runtime/refreshCatalog', { runtime: reach.runtime })
        if (answer.refreshed) done.add(reach.runtime)
        else refused.push({ runtime: reach.runtime, reason: answer.reason ?? 'It did not re-read.' })
      } catch (error) { refused.push({ runtime: reach.runtime, reason: error instanceof Error ? error.message : String(error) }) }
    }
    setDeclined(refused); setRereadDone(done); setRereading(false)
    if (done.size > 0) onChanged()
  }
  const stillStale = staleIn.filter(reach => rereadDone.has(reach.runtime))
  useEffect(() => {
    let live = true
    setReading(true); setDefinition(null)
    if (!source) { setReading(false); return }
    void store.transport.request('library/definition', { kind: 'mcp', name: entry.name, path: source.path, ...(cwd !== undefined ? { cwd } : {}) }).then(answer => {
      if (!live) return
      const one = answer as Partial<LibraryDefinition> | null
      setDefinition(one && typeof one.text === 'string' ? { kind: 'mcp', name: entry.name, path: one.path ?? source.path, text: one.text, truncated: one.truncated === true, files: [], moreFiles: 0 } : null)
    }).catch(() => { if (live) setDefinition(null) }).finally(() => { if (live) setReading(false) })
    return () => { live = false }
  }, [store, entry.name, source?.path, cwd])
  return <DialogRoot open onOpenChange={next => !next && onClose()}>
    <DialogContent ref={surface} data-slot="mcp-sheet" bleed initialFocus={() => surface.current} showCloseButton={false}
      className="flex h-[min(84vh,760px)] w-[min(1080px,94vw)] flex-col overflow-hidden">
      <DialogHead title={entry.title ?? entry.name} scrollDescription aside={<Badge variant="secondary">MCP server</Badge>}><Text role="meta"><CodeText as="code">{entry.name}</CodeText></Text></DialogHead>
      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[minmax(0,1fr)_auto_300px] md:overflow-hidden">
        <div className="flex min-w-0 flex-col md:min-h-0">
          <DialogBody layout="reading">
            <div className="mb-4 flex items-center justify-between gap-2">
              <ToggleGroup type="single" size="sm" variant="chips" aria-label="How to show the definition" value={view} onValueChange={next => { if (next) setView(next as typeof view) }}>
                <ToggleGroupItem value="rendered">Rendered</ToggleGroupItem><ToggleGroupItem value="source">Source</ToggleGroupItem>
              </ToggleGroup>
              <Button variant="ghost" size="sm" disabled={definition === null} title="Copy the definition exactly as it sits on disk" onClick={() => {
                if (definition) void navigator.clipboard.writeText(definition.text).then(() => { setCopied(true); window.setTimeout(() => setCopied(false), 1600) })
              }}><CopyIcon size={13} />{copied ? 'Copied' : 'Copy'}</Button>
            </div>
            {entry.description && <div className="mb-4"><Markdown text={entry.description} document /></div>}
            {reading ? <EmptyState variant="inline" title="Reading the definition…" /> : definition === null ? <EmptyState tight icon={<AlertIcon />} title="No definition to read" description={entry.copies.every(copy => copy.hollow) ? 'Every copy of this is an empty directory — there is no definition on disk to read.' : 'This definition could not be read. It may have moved or been removed since the last scan; Rescan will say.'} />
              : view === 'source' ? <Text as="div" role="muted"><CodeText as="pre" className="m-0 whitespace-pre-wrap">{definition.text}</CodeText></Text> : <Markdown text={definition.text} document />}
            {definition?.truncated && <Text as="p" role="meta" className="mt-3 mb-0">This definition is longer than the dialog reads; what is shown stops short of the end of the file.</Text>}
          </DialogBody>
        </div>
        <Separator orientation="vertical" className="hidden md:block" /><Separator className="md:hidden" />
        <DialogBody layout="reading" className="flex min-w-0 flex-col gap-4">
          <section className="flex flex-col gap-1.5"><Text as="h3" role="muted" className="m-0">Which runtimes load it</Text>
            <FormStack><div role="list" className="flex flex-col gap-1.5">
              {entry.reach.map(reach => {
                const column = columns.find(one => one.id === reach.runtime)
                return <div key={reach.runtime} role="listitem" className="flex min-w-0 items-baseline gap-2">
                  <span className="flex flex-none translate-y-0.5 items-center gap-1.5">
                    {column?.info ? <IconTile aria-hidden="true" size="xs" shape="face"><RuntimeMark runtime={column.info} size={12} /></IconTile> : <span className="inline-block w-3" />}
                    <Text role="meta" ink="primary">{labelOf(reach.runtime)}</Text>
                  </span>
                  {(facts.get(REACH_SENTENCE[reach.state])?.count ?? 0) < 2 && <Text role="meta" align="end" {...(isReachProblem(reach.state) ? { tone: 'warning' as const } : {})} className="min-w-0 flex-1 text-balance">{REACH_SENTENCE[reach.state]}</Text>}
                </div>
              })}
            </div>{repeated.map(([sentence, fact]) => <Note key={sentence} ink="muted" {...(fact.warning ? { tone: 'warn' as const } : {})}>{sentence === REACH_SENTENCE.unscanned ? 'Installed where these runtimes do not look' : sentence}</Note>)}</FormStack>
            {staleIn.length > 0 && <Text as="p" role="meta" ink="secondary" className="m-0 flex flex-wrap items-center gap-x-1.5 gap-y-1">
              <span className="min-w-0">{staleIn.length === 1 ? `${labelOf(staleIn[0]!.runtime)} lists the skills it read when it started.` : `${staleIn.length} runtimes list the skills they read when they started.`}</span>
              <Button variant="outline" size="xs" disabled={rereading} onClick={() => void reread()}>{rereading ? 'Asking…' : 'Have it look again'}</Button>
            </Text>}
            {declined.map(one => <Text as="p" role="meta" tone="warning" key={one.runtime} className="m-0">{labelOf(one.runtime)} — {one.reason}</Text>)}
            {stillStale.length > 0 && <Text as="p" role="meta" tone="warning" className="m-0">{stillStale.length === 1 ? `${labelOf(stillStale[0]!.runtime)} re-read and still does not list it — the definition may be one it will not accept.` : `${stillStale.length} of them re-read and still do not list it — the definition may be one they will not accept.`}</Text>}
            {entry.reach.some(reach => reach.basis === 'scanned') && <Text as="p" role="meta" className="m-0">{entry.reach.every(reach => reach.basis === 'scanned') ? 'Read from disk against this build’s table of where each runtime looks — the runtimes themselves were not asked.' : 'Some rows are what the runtime itself reported; the rest are read from disk.'}</Text>}
          </section>
          {groupedWhy.size > 0 && <section className="flex flex-col gap-1.5"><Text as="h3" role="muted" className="m-0">Why</Text><div role="list" className="flex flex-col gap-1">{[...groupedWhy].map(([note, names]) => <Text as="p" role="meta" key={note} className="m-0"><Text role="meta" ink="primary">{names.join(', ')}</Text> — {note}</Text>)}</div></section>}
          <Separator />
          <section className="flex flex-col gap-1.5"><Text as="h3" role="muted" className="m-0">{entry.copies.length === 1 ? 'One copy on disk' : `${entry.copies.length} copies on disk`}</Text>
            <div role="list" className="flex flex-col gap-2">{entry.copies.map(copy => <div key={copy.path} role="listitem" className="flex min-w-0 flex-col gap-0.5">
              <div className="flex min-w-0 items-start gap-1"><Text role="meta" ink="primary" className="min-w-0 flex-1 [overflow-wrap:anywhere]">{shortPath(copy.path, home)}</Text>
                {!copy.readOnly && <Button variant="ghost" size="icon-sm" className="-mt-0.5 flex-none" aria-label={`Remove ${entry.name} from ${copy.path}`} title="Remove this — previewed first, backed up before it goes" onClick={() => onFlow({ type: 'plan', title: `Remove ${entry.name}`, intents: [{ kind: 'removeMcp', name: entry.name, path: copy.path }] })}><TrashIcon size={12} /></Button>}
              </div><Text role="meta">{copy.hollow ? 'No definition inside — the name lists and nothing loads.' : copy.readBy.length === 0 ? 'No runtime reads this file.' : `Read by ${copy.readBy.map(labelOf).join(', ')}.`}{copy.readOnly && ' Shipped by the runtime.'}</Text>
            </div>)}</div>
          </section>
        </DialogBody>
      </div>
      <SectionFooter className="flex-wrap"><span className="flex-1" />
        {installable.length > 3 ? <Button size="sm" onClick={() => install(installable)}>Add to all {installable.length} missing…</Button> : installable.map(column => <Button key={column.id} variant={installable.length === 1 ? 'default' : 'outline'} size="sm" onClick={() => install([column])}>{column.info && <RuntimeMark runtime={column.info} size={13} />}Add to {column.label}</Button>)}
        {entry.reach.some(reach => reach.state === 'rejected') && installable.length > 0 && <Text role="meta" tone="warning" className="flex items-center gap-1.5"><AlertIcon size={12} />{entry.reach.filter(reach => reach.state === 'rejected').length === 1 ? `${labelOf(entry.reach.find(reach => reach.state === 'rejected')!.runtime)} would not load this one.` : `${entry.reach.filter(reach => reach.state === 'rejected').length} runtimes would not load this one.`}</Text>}
        {installable.length === 0 && <Text role="meta" className="flex items-center gap-1.5"><FileIcon size={12} />{entry.reach.every(reach => reach.state === 'reaches') ? 'Every runtime already loads this.' : digests.size > 1 ? 'Resolve the copies before installing anywhere else.' : 'Nowhere left to install this.'}</Text>}
      </SectionFooter>
    </DialogContent>
  </DialogRoot>
}
