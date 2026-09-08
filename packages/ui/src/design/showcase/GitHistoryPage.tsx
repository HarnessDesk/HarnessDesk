import { useState } from 'react'

import {
  BranchIcon,
  CommitIcon,
  FetchIcon,
  FilterIcon,
  MergeIcon,
  PushIcon,
  SearchIcon,
  StashIcon,
  TagIcon,
} from '@/components/Icons'
import {
  AvatarStack,
  Button,
  CommitState,
  DiffBlock,
  DiffStat,
  FileRow,
  InputGroupAddon,
  InputGroupInput,
  InputGroup,
  KeyValue,
  KeyValueRow,
  RefChip,
  Section,
  SectionBody,
  SectionHeader,
  SectionTitle,
  ToolPane,
  ToolPaneBody,
  ToolPaneHeader,
  Toolbar,
  ToolbarGap,
  laneTint,
} from '../ui'
import styles from './git-history-page.module.css'

/**
 * The repository, as history rather than as status.
 *
 * Two panes, and the split is the design: the graph answers *what happened*,
 * the detail answers *what exactly*, and neither can do the other's job. A
 * single-pane history forces a choice between a list you can scan and a diff
 * you can read, and every tool that has tried it has ended up with a list of
 * commits that opens a modal.
 *
 * Three things carried over from the graph work already in this repo, because
 * they were learned rather than chosen:
 *
 *   Lanes are identities.       A branch's colour is a tint, in a stable order,
 *                               so a line keeps its hue as it travels down the
 *                               page. Colouring `main` green would say it is
 *                               the good branch.
 *   The lane column is fixed.   Every subject starts at the same x, however
 *                               many branches are open at that row. A ragged
 *                               left edge makes a history unscannable, and the
 *                               width of the widest merge is not information.
 *   State is only news.         A pushed, signed commit says nothing. That is
 *                               what makes `unpushed` findable in two hundred
 *                               rows.
 */

type Commit = {
  sha: string
  subject: string
  author: string
  at: string
  lane: number
  /** Lanes drawn *through* this row without stopping at it. */
  through?: number[]
  merge?: boolean
  refs?: { label: string; kind?: 'branch' | 'remote' | 'tag' | 'head'; lane?: number }[]
  state?: { label: string; tone: 'neutral' | 'warning' | 'danger' | 'success' }
  added: number
  removed: number
}

const COMMITS: Commit[] = [
  {
    sha: '3674614',
    subject: 'Merge pull request #12 — visible unavailable agent status',
    author: 'iamenahs',
    at: '2h',
    lane: 0,
    through: [1],
    merge: true,
    refs: [
      { label: 'HEAD', kind: 'head' },
      { label: 'main', kind: 'branch', lane: 0 },
      { label: 'origin/main', kind: 'remote' },
    ],
    added: 128,
    removed: 34,
  },
  {
    sha: '81b728a',
    subject: 'ui: keep unavailable agent consequences visible',
    author: 'Codex',
    at: '3h',
    lane: 1,
    through: [0],
    refs: [{ label: 'codex/visible-status', kind: 'branch', lane: 1 }],
    added: 96,
    removed: 12,
  },
  {
    sha: '1e09088',
    subject: 'Merge pull request #11 — the shadcn component layer',
    author: 'iamenahs',
    at: '5h',
    lane: 0,
    through: [1, 2],
    merge: true,
    added: 1_204,
    removed: 380,
  },
  {
    sha: 'bcc568d',
    subject: 'review: one button in two spellings, the accent kept whole',
    author: 'Claude Code',
    at: '6h',
    lane: 2,
    through: [0, 1],
    state: { label: 'unpushed', tone: 'warning' },
    added: 214,
    removed: 96,
  },
  {
    sha: '2033d69',
    subject: 'Bridge Tailwind v4 onto the --hd- token layer',
    author: 'Claude Code',
    at: '7h',
    lane: 2,
    through: [0, 1],
    added: 340,
    removed: 8,
  },
  {
    sha: 'a7f0c41',
    subject: 'Release 0.4.0',
    author: 'iamenahs',
    at: '2d',
    lane: 0,
    refs: [{ label: 'v0.4.0', kind: 'tag' }],
    state: { label: 'signed', tone: 'success' },
    added: 12,
    removed: 2,
  },
]

const DIFF = [
  { kind: 'hunk' as const, text: '@@ -14,6 +14,10 @@ const badgeVariants = cva(' },
  { kind: 'context' as const, text: '  variants: {' },
  { kind: 'add' as const, text: '    tone: {' },
  { kind: 'add' as const, text: "      success: 'bg-(--hd-success-dim) text-(--hd-success-ink)'," },
  { kind: 'remove' as const, text: "      success: 'bg-green-100 text-green-700'," },
  { kind: 'context' as const, text: '    },' },
]

/** One row's worth of graph: the lanes passing through, and this commit's dot. */
const Lane = ({ commit }: { commit: Commit }) => (
  <div className={styles.lane} aria-hidden>
    {[...(commit.through ?? []), commit.lane].map((lane) => (
      <span
        key={lane}
        className={styles.laneLine}
        style={{
          left: `${10 + lane * 12}px`,
          background: `var(--hd-tint-${laneTint(lane)}-ink)`,
          opacity: lane === commit.lane ? 1 : 0.45,
        }}
      />
    ))}
    <span
      className={styles.laneDot}
      style={{
        left: `${10 + commit.lane * 12}px`,
        background: commit.merge ? 'var(--hd-card)' : `var(--hd-tint-${laneTint(commit.lane)}-ink)`,
        boxShadow: commit.merge
          ? `0 0 0 2px var(--hd-tint-${laneTint(commit.lane)}-ink), 0 0 0 4px var(--hd-card)`
          : '0 0 0 2px var(--hd-card)',
      }}
    />
  </div>
)

export const GitHistoryPage = () => {
  const [selected, setSelected] = useState(COMMITS[3]!.sha)
  const commit = COMMITS.find((one) => one.sha === selected) ?? COMMITS[0]!

  return (
    <div className={styles.gitLayout}>
      <Section>
        <SectionHeader>
          <SectionTitle>History</SectionTitle>
          <div className="col-span-full mt-2">
            <Toolbar>
              <Button variant="outline" size="sm">
                <BranchIcon /> main
              </Button>
              <Button variant="ghost" size="sm">
                <FetchIcon /> Fetch
              </Button>
              <Button variant="ghost" size="sm">
                <PushIcon /> Push
                {/* The one number on this toolbar that changes behaviour: how
                    many commits are yours alone. */}
                <CommitState tone="warning">2</CommitState>
              </Button>
              <Button variant="ghost" size="sm">
                <MergeIcon /> Merge
              </Button>
              <Button variant="ghost" size="sm">
                <StashIcon /> Stash
              </Button>
              <ToolbarGap />
              <InputGroup className="w-48">
                <InputGroupAddon align="inline-start">
                  <SearchIcon />
                </InputGroupAddon>
                <InputGroupInput placeholder="Search history…" aria-label="Search history" />
              </InputGroup>
              <Button variant="ghost" size="icon-sm" aria-label="Filter">
                <FilterIcon />
              </Button>
            </Toolbar>
          </div>
        </SectionHeader>
        <SectionBody inset={false} className="pt-2">
          <div className={styles.graph}>
            {COMMITS.map((one) => (
              <div
                key={one.sha}
                className={styles.commitRow}
                {...(one.sha === selected ? { 'data-selected': '' } : {})}
                onClick={() => setSelected(one.sha)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setSelected(one.sha)
                  }
                }}
              >
                <Lane commit={one} />
                <div className={styles.commitBody}>
                  <div className={styles.commitSubject}>
                    {one.refs?.map((ref) => (
                      <RefChip key={ref.label} kind={ref.kind} lane={ref.lane ?? 0}>
                        {ref.kind === 'tag' ? <TagIcon aria-hidden className="size-2.5" /> : null}
                        {ref.label}
                      </RefChip>
                    ))}
                    {one.state && <CommitState tone={one.state.tone}>{one.state.label}</CommitState>}
                    <span className={styles.commitText}>{one.subject}</span>
                  </div>
                  <div className={styles.commitMeta}>
                    <span>{one.author}</span>
                    <span aria-hidden>·</span>
                    <span>{one.at}</span>
                    <span aria-hidden>·</span>
                    <DiffStat added={one.added} removed={one.removed} />
                  </div>
                </div>
                <span className={styles.sha}>{one.sha}</span>
              </div>
            ))}
          </div>
        </SectionBody>
      </Section>

      <ToolPane className={styles.paneTall}>
        <ToolPaneHeader
          icon={<CommitIcon />}
          title={commit.sha}
          subtitle={commit.author}
          actions={
            <>
              <Button variant="ghost" size="sm">
                Revert
              </Button>
              <Button variant="ghost" size="sm">
                Cherry-pick
              </Button>
            </>
          }
        />
        <ToolPaneBody>
          <p className="mb-3 text-base">{commit.subject}</p>
          <KeyValue className="mb-3">
            <KeyValueRow label="Author">{commit.author}</KeyValueRow>
            <KeyValueRow label="When">{commit.at} ago</KeyValueRow>
            <KeyValueRow label="Parents">{commit.merge ? '2' : '1'}</KeyValueRow>
          </KeyValue>
          <div className="mb-3 flex items-center gap-2">
            <AvatarStack members={[{ name: commit.author }]} size="sm" />
            <DiffStat added={commit.added} removed={commit.removed} />
          </div>
          <div className="mb-3 rounded-(--hd-radius-sm) border border-(--hd-border)">
            <FileRow status="M" path="packages/ui/src/design/ui/badge.tsx" added={4} removed={2} />
            <FileRow status="M" path="packages/ui/src/design/tokens.css" added={18} removed={6} />
            <FileRow status="A" path="packages/ui/src/design/ui/tone.ts" added={132} removed={0} />
          </div>
          <DiffBlock
            file="packages/ui/src/design/ui/badge.tsx"
            added={4}
            removed={2}
            lines={DIFF}
          />
        </ToolPaneBody>
      </ToolPane>
    </div>
  )
}
