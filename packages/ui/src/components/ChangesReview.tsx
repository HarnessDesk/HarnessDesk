import { useEffect, useMemo, useRef, useState } from 'react'

import type { GitFileStatus, GitStatus } from '@harnessdesk/protocol'

import { countChanges, splitByFile, splitHunks, type DiffHunk, DiffView } from '../editor'
import { inView } from '../lib/git-view'
import { Button, Card, ChangeStats, CodeText, EmptyState, Note, Page, PageOptions, PatchHeader, Section, Separator, SummaryList, SummaryItem, MiddleTruncate, Text, ToolbarGap } from '../design'
import { useStore } from '../state/context'
import { DestinationBar, useDestinationPage } from '../panels/destination-page'
import { ReviewFilter, ReviewIndex } from '../panels/review-index'
import type { WorkView } from '../state/destinations'
import { handOverToComposer } from '../lib/compose'


/**
 * Changes as a review workspace: the captured working tree in main,
 * grouped by folder, every hunk carrying the one action a multi-agent tool
 * should own — "revise this hunk", which quotes the hunk into the composer
 * for the work that opened this review. Staging stays git's: nothing
 * here writes to the index, and the staged toggle only changes what is read.
 *
 * The side panel's Changes tab answers "what just happened" beside the
 * conversation; this is where a person goes to *read* a day's work, which
 * needs the width and the folder shape the panel cannot give.
 */

/** How much of a hunk rides a revise request; enough to identify, not a paste bomb. */
const QUOTE_CAP = 1_800

const dirname = (path: string): string => {
  const cut = path.lastIndexOf('/')
  return cut > 0 ? path.slice(0, cut) : ''
}
const basename = (path: string): string => path.split('/').pop() || path

interface FolderGroup {
  readonly folder: string
  readonly files: readonly GitFileStatus[]
}

/** Files by folder, folders in path order, so the index reads like the tree. */
const groupByFolder = (files: readonly GitFileStatus[]): FolderGroup[] => {
  const map = new Map<string, GitFileStatus[]>()
  for (const file of files) {
    const key = dirname(file.path)
    const list = map.get(key) ?? []
    list.push(file)
    map.set(key, list)
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([folder, grouped]) => ({
      folder,
      files: [...grouped].sort((a, b) => a.path.localeCompare(b.path)),
    }))
}

const Counts = ({ added, removed }: { added: number; removed: number }) =>
  added + removed > 0 ? <ChangeStats added={added} removed={removed} /> : null

interface ReviewProps { readonly root: string | null; readonly returnTo: WorkView }
export const ChangesReview = (props: ReviewProps) => <ReviewBody key={JSON.stringify([props.root, props.returnTo])} {...props} />

const ReviewBody = ({ root, returnTo }: ReviewProps) => {
  const store = useStore()
  const { active } = useDestinationPage()

  const [staged, setStaged] = useState(false)
  const [query, setQuery] = useState('')
  const [git, setGit] = useState<GitStatus | null>(null)
  const [treeRead, setTreeRead] = useState<{ readonly staged: boolean; readonly diff: string } | null>(null)
  const treeDiff = treeRead?.staged === staged ? treeRead.diff : ''
  const sections = useRef<Map<string, HTMLElement>>(new Map())

  useEffect(() => {
    if (!active || !root) return
    let cancelled = false
    void store.transport
      .request('git/status', { root })
      .then((status) => {
        if (!cancelled) setGit(status)
      })
      .catch(() => { if (!cancelled) setGit(null) })
    void store.transport
      .request('git/diff', { root, ...(staged ? { staged: true } : {}) })
      .then((result) => {
        if (!cancelled) setTreeRead({ staged, diff: result.diff })
      })
      .catch(() => { if (!cancelled) setTreeRead({ staged, diff: '' }) })
    return () => {
      cancelled = true
    }
  }, [active, root, staged, store])

  /** Each path's own diff, cut once from the tree's. */
  const diffs = useMemo(() => {
    const map = new Map<string, string>()
    for (const file of splitByFile(treeDiff)) {
      if (file.path) map.set(file.path, file.diff)
    }
    return map
  }, [treeDiff])

  const needle = query.trim().toLowerCase()
  const files = useMemo(
    () =>
      (git?.files ?? [])
        .filter((file) => inView(file, staged))
        .filter((file) => needle.length === 0 || file.path.toLowerCase().includes(needle)),
    [git, staged, needle],
  )
  const groups = useMemo(() => groupByFolder(files), [files])

  const total = files.reduce(
    (sum, file) => {
      const count = countChanges(diffs.get(file.path) ?? '')
      return { added: sum.added + count.added, removed: sum.removed + count.removed }
    },
    { added: 0, removed: 0 },
  )

  /** The one hunk action: quote it into the composer and hand the window back. */
  const reviseHunk = (path: string, hunk: DiffHunk): void => {
    const quoted = hunk.text.length > QUOTE_CAP ? `${hunk.text.slice(0, QUOTE_CAP)}\n…` : hunk.text
    if (!store.selectWork(returnTo)) return
    void handOverToComposer({ text: `Please revise this hunk of ${path}:\n\`\`\`diff\n${quoted}\n\`\`\`\n` }).then(received => {
      if (!received) store.notice('warning', 'The message box did not take it — click into the conversation and try again.')
    })
  }

  const jumpTo = (path: string): void => {
    // The pane's smooth-scroll silently no-ops in some hosts; land it plainly.
    sections.current.get(path)?.scrollIntoView({ block: 'start', behavior: 'auto' })
  }

  const absolute = (path: string): string => (path.startsWith('/') || !root ? path : `${root}/${path}`)
  const empty = git !== null && git.files.length === 0

  return (
    <>
      <DestinationBar place="Changes" />
      <Page width="canvas" measure="wide" topInset="page">
        {!empty && <PageOptions choices={[{ id: 'view', label: 'Changes views', value: staged ? 'staged' : 'working', mode: 'menu',
          items: [{ value: 'working', label: 'Working tree' }, { value: 'staged', label: 'Staged' }],
          change: value => setStaged(value === 'staged') }]} />}
        {empty ? <EmptyState variant="inline" title="No changes yet" /> : <>
          <ReviewFilter query={query} change={setQuery} />
          <SummaryList><SummaryItem label={git?.branch ? <>on <MiddleTruncate>{git.branch}</MiddleTruncate></> : null}>
            {files.length} file{files.length === 1 ? '' : 's'}
            {total.added + total.removed > 0 ? ` · +${total.added} −${total.removed}` : ''}
          </SummaryItem></SummaryList>
          <ReviewIndex jump={jumpTo} groups={groups.map(group => ({
            folder: group.folder, files: group.files.map(file => ({ path: file.path, name: basename(file.path),
              ...countChanges(diffs.get(file.path) ?? '') })),
          }))} />

        {groups.length === 0 && (
          <EmptyState
            variant="inline"
            title={git === null
              ? 'This folder is not a git repository, so there is nothing to compare against.'
              : staged
                ? 'Nothing staged. Staging stays in git — stage there, review here.'
            : 'No uncommitted changes.'}
          />
        )}
        </>}

        {groups.map((group) => (
          <Section level="heading" key={group.folder || '.'} title={group.folder || 'in this folder'}>
            {group.files.map((file) => {
              const diff = diffs.get(file.path) ?? ''
              const hunks = splitHunks(diff)
              const count = countChanges(diff)
              return (
                <section
                  key={file.path}
                  data-review-file={file.path}
                  ref={(element) => {
                    if (element) sections.current.set(file.path, element)
                    else sections.current.delete(file.path)
                  }}
                >
                  <Card as="article" variant="flush">
                    <PatchHeader>
                      <Text role="row" truncate title={file.path}>
                        {basename(file.path)}
                      </Text>
                      <Counts added={count.added} removed={count.removed} />
                      <ToolbarGap />
                      <Button variant="quiet" size="content" onClick={() => store.openFile(absolute(file.path))}>
                        Open
                      </Button>
                    </PatchHeader>
                    {hunks.length === 0 ? (
                      <Note>
                        {file.status === 'untracked'
                          ? 'New file — open it to read it.'
                          : staged
                            ? 'No staged diff for this file.'
                            : 'No diff to show.'}
                      </Note>
                    ) : (
                      hunks.map((hunk, index) => (
                        /* Hunks are told apart by the app's one hairline. */
                        <section key={`${file.path}-${index}`}>
                          {index > 0 && <Separator />}
                          <PatchHeader level="hunk">
                            <Text role="meta"><CodeText as="code">{hunk.header}</CodeText></Text>
                            <ToolbarGap />
                            <Button
                              variant="quiet" size="content"
                              title="Quote this hunk into the composer as a revision request"
                              onClick={() => reviseHunk(file.path, hunk)}
                            >
                              Revise this hunk…
                            </Button>
                          </PatchHeader>
                          <DiffView diff={hunk.text} />
                        </section>
                      ))
                    )}
                  </Card>
                </section>
              )
            })}
          </Section>
        ))}
      </Page>
    </>
  )
}
