import { isRecord, RECORD_REASON } from '../lib/team-record'
import { useEffect, useState } from 'react'

import {
  Banner,
  Button,
  Chip,
  CodeText,
  MetaList,
  NativeSelect,
  Note,
  Page,
  Row,
  RowButton,
  Rows,
  Switch,
  Menu,
  MenuToggle,
  SummaryList,
  SummaryItem,
  ToolPane,
  ToolPaneBody,
  ToolPaneEmptyState,
  ToolPaneMessage,
} from '../design'
import { ReviewIcon } from './Icons'
import { emptyFindingsState, blockingWords, FILTER_LABEL, goalHasBoundPr, lifecycleTone, lifecycleWords, type FindingFilter } from '../lib/findings'
import { runPublication } from '../lib/review-publication'
import { goalRunLabel, goalRunOf, goalRunsOf } from '../lib/goal-run'
import { usePane, useSnapshot, useStore } from '../state/context'
import { useTopBarView } from '../panels/top-bar'
import { FindingDecision } from './FindingDecision'
import { FindingDetail } from './FindingDetail'
import { FindingPublications } from './FindingPublications'
import { FindingRoundStatus } from './FindingRoundStatus'

/**
 * The Goal's findings, as a person reads them: filterable, paged, with the
 * ledger's own words for a claimed repair, a withdrawn row and a publication
 * that has not landed. Every read is explicit — an effect, never a render —
 * and stays on this one Goal: switching away and back reuses the cache
 * `store.loadFindings` already keeps.
 */

const FILTERS: readonly FindingFilter[] = ['all', 'open', 'blocking']

type OpenedFinding = Readonly<{ finding: string; originRun: string | null }>

export const GoalFindings = ({ goal }: { readonly goal: string }) => {
  const store = useStore()
  const snapshot = useSnapshot()
  const [opened, setOpened] = useState<OpenedFinding | null>(null)
  const [deciding, setDeciding] = useState(false)
  const [publicationPending, setPublicationPending] = useState<boolean | null>(null)
  const [publicationError, setPublicationError] = useState<string | null>(null)

  const goalView = snapshot.goals.get(goal)
  const record = isRecord(goalView)
  const [recordFilter, setRecordFilter] = useState<FindingFilter>('all')
  const frozen = record ? goalView?.receipt?.findings?.findings : undefined
  const open = frozen?.filter(one => !one.lifecycle.confirmed) ?? []
  const blocking = open.filter(one => (one.activeBlocking ?? one.blocking) && !one.inactiveReason)
  const state = frozen ? { ...emptyFindingsState(recordFilter),
    rows: recordFilter === 'open' ? open : recordFilter === 'blocking' ? blocking : frozen,
    totals: { all: frozen.length, open: open.length, blocking: blocking.length },
  } : snapshot.findings.get(goal)
  /* The same run the room's header reads, among those keeping findings (#890),
     unless the person chose an earlier one to read as history. */
  const live = goalRunOf(goal, goalView, snapshot.flowExecutions, (one) => Boolean(one.findings))
  const runs = goalRunsOf(goal, snapshot.flowExecutions)
  const [chosen, setChosen] = useState<string | null>(null)
  const run = (chosen ? runs.find((one) => one.id === chosen) : undefined) ?? live
  const runView = run ? snapshot.findingRuns.get(run.id) : undefined
  // A finding a run of this Goal raised is decided against that run, whichever one is shown.
  // A finding's decision belongs to the run that raised it, captured when the
  // row opens: a fresh first page may replace the list — and drop a later
  // page's row — while the person's dialog is still in progress (#1091). Not
  // re-checked against this Goal's runs either, which can briefly lack it
  // (#1090); the host judges the decision against the run itself.
  const originRun = opened?.originRun ?? null
  const decideView = originRun ? snapshot.findingRuns.get(originRun) : runView
  // A verdict on a finding outlives the run that raised it while its Goal is open; the host refuses once it is not (or came from a backup).
  const goalOpen = goalView !== undefined && goalView.goal.state === 'open'

  useEffect(() => {
    setRecordFilter('all')
    if (!frozen) void store.loadFindings(goal, 'all')
  }, [store, goal, frozen])

  useEffect(() => {
    if (run) void store.loadFindingRun(goal, run.id)
  }, [store, goal, run?.id])

  useEffect(() => {
    if (originRun && originRun !== run?.id) void store.loadFindingRun(goal, originRun)
  }, [store, goal, originRun, run?.id])

  const filter = state?.filter ?? 'all'
  const setFilter = (next: FindingFilter): void => {
    if (next === filter) return
    if (frozen) setRecordFilter(next)
    else void store.loadFindings(goal, next)
  }

  const boundPr = goalHasBoundPr(snapshot.boardEvidence.get(goal))
  const confirmedPublication = goalView?.goal.findingPublication !== false
  const publicationOn = publicationPending ?? confirmedPublication

  const setPublication = async (enabled: boolean): Promise<void> => {
    if (!goalView) return
    setPublicationPending(enabled)
    setPublicationError(null)
    try {
      await store.setFindingPublication(goal, goalView.goal.revision, enabled)
    } catch (error) {
      setPublicationError(error instanceof Error ? error.message : String(error))
    } finally {
      setPublicationPending(null)
    }
  }

  const rows = state?.rows ?? []
  const loadingFirstPage = !state || (state.loading && rows.length === 0)
  const noFindings = Boolean(state && !loadingFirstPage && !state.problem && !state.error && state.next === null
    && state.totals?.all === 0 && rows.length === 0 && (runView?.open ?? 0) === 0 && (runView?.blocking ?? 0) === 0)
  const hasCountedFindings = rows.length > 0 || (state?.totals?.all ?? 0) > 0
  // Other runs' open findings stay decidable, each against its own run.
  const fromEarlier = run
    ? rows.filter((one) => one.origin.goal === goal && one.origin.run !== run.id && runs.some((other) => other.id === one.origin.run) &&
      one.lifecycle.state === 'open' && !one.lifecycle.confirmed).length
    : 0

  const owner = usePane()?.paneId ?? ''
  const refusal = record ? RECORD_REASON : runView?.undecidable ?? (!runView || (runView.reason === null && runView.blocking === 0)
    ? 'This Run has no decision waiting' : false)
  useTopBarView(owner, {
    verb: { label: 'Decide this run', disabled: refusal, run: () => setDeciding(true) },
    view: { narrowed: filter !== 'all', content: close => <Menu close={close}>
      {FILTERS.map(one => <MenuToggle key={one} label={FILTER_LABEL[one]} checked={filter === one}
        onChange={() => { setFilter(one); close() }} />)}
    </Menu> },
  }, Boolean(owner))

  return (
    <ToolPane variant="integrated" aria-label="Findings">
      <ToolPaneBody bleed>
        <Page width="reading">
        {hasCountedFindings && <SummaryList aria-label="Findings summary">
          <SummaryItem label="Open">{state?.totals?.open ?? 'Not recorded'}</SummaryItem>
          <SummaryItem label="Blocking">{state?.totals?.blocking ?? 'Not recorded'}</SummaryItem>
          <SummaryItem label="All">{state?.totals?.all ?? 'Not recorded'}</SummaryItem>
        </SummaryList>}
        {runs.length > 1 && run && (
          <NativeSelect aria-label="Run" value={run.id} onChange={(event) => setChosen(event.target.value)}>
            {runs.map((one, index) => (
              <option key={one.id} value={one.id}>{goalRunLabel(one, index, runs.length)}</option>
            ))}
          </NativeSelect>
        )}
        {runView && !record && !noFindings && (
          <>
            <FindingRoundStatus view={runView} publicationOn={confirmedPublication} />
            {runView.undecidable && <Note>{runView.undecidable}</Note>}
            {!runView.undecidable && <FindingPublications goal={goal} run={runView.run} stamp={runView.stamp} />}
          </>
        )}
        {record && <Note>This Team is wrapped. Its findings are kept as history.</Note>}
        {record && runView && <Note>
          {runPublication(runView, confirmedPublication)?.label}
          {runView.reason ? ` — ${runView.reason}` : ''}
        </Note>}
        {boundPr ? (
          /* A setting is a settings row: its switch keeps the row's end. */
          <Rows>
            <Row
              title="Post closed rounds to the pull request"
              control={
                <Switch
                  checked={publicationOn}
                  disabled={record || publicationPending !== null || !goalView}
                  title={record ? RECORD_REASON : undefined}
                  aria-label="Post closed rounds to the pull request"
                  onCheckedChange={(checked: boolean) => void setPublication(checked)}
                />
              }
            />
          </Rows>
        ) : !noFindings ? (
          <Note>{record ? 'Local findings — no pull request was bound to this Team.' : 'Local findings — no pull request is bound to this Team yet.'}</Note>
        ) : null}
        {publicationError && (
          <Banner tone="danger" title="This preference could not be saved">{publicationError}</Banner>
        )}
        {!record && fromEarlier > 0 && (
          <Note>
            {`${fromEarlier} open finding${fromEarlier === 1 ? ' here was' : 's here were'} raised by another run of this Team. Open one to decide it yourself; it is decided against the run that raised it.`}
          </Note>
        )}
        {state?.stale && state.error && (
          <Banner tone="danger" title="These findings could not be reloaded">{state.error}</Banner>
        )}
        {loadingFirstPage ? (
          <ToolPaneMessage>Reading findings…</ToolPaneMessage>
        ) : state!.problem ? (
          <Banner tone="warning" title="This ledger cannot be shown as complete">{state!.problem}</Banner>
        ) : rows.length === 0 ? (
          <ToolPaneEmptyState icon={<ReviewIcon />} title="No findings recorded" />
        ) : (
          <Rows>
            {rows.map((row) => (
              <RowButton
                key={row.id}
                onClick={() => setOpened({
                  finding: row.id,
                  originRun: row.origin.goal === goal ? row.origin.run : null,
                })}
                layout="record"
                title={row.title || 'Untitled finding'}
                desc={
                  <MetaList ink="muted">
                    <CodeText size="inherit">#<span className="select-all">{row.id}</span></CodeText>
                    <span>{blockingWords(row)}</span>
                    {(row.origin.goal !== goal || (run && row.origin.run !== run.id)) && <span>Raised in round {row.origin.round} · of another {row.origin.goal !== goal ? 'Team' : 'run'}</span>}
                    {row.restored && <span>from a backup</span>}
                  </MetaList>
                }
                control={<Chip tone={lifecycleTone(row)}>{lifecycleWords(row)}</Chip>}
              />
            ))}
          </Rows>
        )}
        {state?.next && !loadingFirstPage && (
          <Button variant="ghost" size="sm" disabled={state.loadingMore} onClick={() => void store.loadFindings(goal, filter, state.next!)}>
            {state.loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        )}
        </Page>
      </ToolPaneBody>
      {opened && (
        <FindingDetail
          goal={goal}
          finding={opened.finding}
          onClose={() => setOpened(null)}
          {...(decideView ? { decide: decideView, verdictAfterRun: goalOpen } : {})}
        />
      )}
      {deciding && runView && <FindingDecision goal={goal} view={runView} onClose={() => setDeciding(false)} />}
    </ToolPane>
  )
}
