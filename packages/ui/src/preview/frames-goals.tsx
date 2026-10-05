import { useState } from 'react'

import type { AuthoringSaveInput, FindingPublicationsView, FindingRunView, Intent } from '@harnessdesk/protocol'

import { AddMember } from '../components/AddMember'
import { AddWork } from '../components/AddWork'
import { FindingBackfillDialog } from '../components/FindingBackfillDialog'
import { FindingCarry } from '../components/FindingCarry'
import { FindingDecision } from '../components/FindingDecision'
import { FindingDetail } from '../components/FindingDetail'
import { FindingPublications } from '../components/FindingPublications'
import { FindingRoundStatus } from '../components/FindingRoundStatus'
import { FrontDoor } from '../components/FrontDoor'
import { GoalAssign } from '../components/GoalAssign'
import { GoalCreate } from '../components/GoalCreate'
import { GoalFindings } from '../components/GoalFindings'
import { GoalReceipt } from '../components/GoalReceipt'
import { GoalReceiptCost } from '../components/GoalReceiptCost'
import { GoalWrap } from '../components/GoalWrap'
import { HandOut } from '../components/HandOut'
import { InsightUsage } from '../components/InsightUsage'
import { InsightCost } from '../components/InsightCost'
import { ShapeEditor } from '../components/ShapeEditor'
import { ShapeGraph } from '../components/ShapeGraph'
import { ShapeRule } from '../components/ShapeRule'
import { ShapeSave } from '../components/ShapeSave'
import { ShapeStep } from '../components/ShapeStep'
import { TriggerCreate } from '../components/TriggerCreate'
import { TriggerMenu } from '../components/TriggerMenu'
import { defaultAgentRole, defaultRule } from '../lib/shapes'
import { Boundary } from './boundary'
import { Dial, Frame } from './main'
import { PREVIEW_FLOW_SOURCE } from './flow-fixture'
import { PREVIEW_FINDINGS, findingDetail } from './findings-fixture'
import { PREVIEW_GOAL, PREVIEW_GOALS } from './goal-fixture'
import { insightReportFor, PREVIEW_AGENTS } from './harness'
import { PREVIEW_ROOT } from './sidebar-fixture'

/** `goal-wrapped`'s own receipt, given the one thing it does not otherwise carry: unresolved findings for `FindingCarry` to offer forward. */
const WRAPPED_WITH_FINDINGS = PREVIEW_GOALS.find((one) => one.goal.id === 'goal-wrapped')!
const CARRY_SOURCE = {
  ...WRAPPED_WITH_FINDINGS,
  receipt: {
    ...WRAPPED_WITH_FINDINGS.receipt!,
    findings: { version: 1 as const, evidence: [], findings: PREVIEW_FINDINGS.filter((one) => !one.lifecycle.confirmed), overrides: [] },
  },
}

const RUN_VIEW: FindingRunView = {
  run: 'run-preview',
  goal: PREVIEW_GOAL.goal.id,
  round: 2,
  finished: 1,
  total: 3,
  embargoed: true,
  open: 2,
  blocking: 1,
  reason: 'Two findings are still open, one of them blocking.',
  ceilingStop: false,
  stamp: 'preview-stamp',
  publication: 'pending', rounds: [],
  reviewersFinished: 1,
  reviewersTotal: 3,
  pendingExceptions: [],
  repair: null,
  boundPr: { repo: 'harnessdesk/harnessdesk', pr: 42 },
  unbound: null,
  undecidable: null,
}

const PREVIEW_INTENTS: readonly Intent[] = PREVIEW_GOAL.board.intents

const BACKFILL_PREVIEW: NonNullable<FindingPublicationsView['backfill']> = {
  pr: 42,
  stamp: 'b'.repeat(64),
  rounds: [{ round: 1, findings: 2, reviews: 3 }, { round: 2, findings: 1, reviews: 1 }],
}

const SHAPE_SAVE_INPUT: AuthoringSaveInput = {
  target: { kind: 'flow', origin: 'project', id: 'new-flow', root: PREVIEW_ROOT },
  expected: null,
  source: PREVIEW_FLOW_SOURCE['fix']!,
}

const TRIGGER_MENU_ITEMS = [
  { id: 'reviewer', name: 'Code reviewer', hint: 'Reads a diff', mono: false },
  { id: 'notes', name: 'notes.md', badge: 'file', pathStyle: true },
  { id: 'active', name: 'Alpha', badge: 'in this turn', badgeTone: 'live' as const },
]

/**
 * Two real steps and a rule between them — an Agent step that names an
 * actual Agent from the roster, a Person step it hands off to, and a rule
 * with an evidence guard and an answer it watches — so `ShapeGraph` draws an
 * edge worth looking at and `ShapeRule` shows a filled form, not an empty one.
 */
const SHAPE_STEP_ROLE = { ...defaultAgentRole('implement'), uses: [PREVIEW_AGENTS[0]!.id] }
const SHAPE_POLICY_WITH_RULE = (() => {
  const rule = { ...defaultRule('to-review', 'implement', 'review'), when: { any: ['done'], evidence: [{ check: 'tests' } as const] } }
  return {
    policy: {
      version: 2 as const,
      name: 'Fix and review',
      inputs: [{ id: 'task', label: 'Task' }],
      roles: [SHAPE_STEP_ROLE, { id: 'review', kind: 'person' as const, outcomes: ['approve', 'changes'] }],
      rules: [rule],
      seed: { role: 'implement', title: '{{task}}' },
      messaging: 'board-only' as const,
      wait: 240,
    },
    rule,
  }
})()

const INSIGHT_REPORT = insightReportFor(PREVIEW_GOAL.goal.id)

const DIALOG_OPTIONS = [
  'off', 'goal create', 'goal assign', 'goal wrap', 'finding carry', 'finding decision',
  'finding detail', 'finding before selection', 'finding not kept', 'finding publications', 'finding backfill', 'finding backfill wrapped',
  'add member', 'add work', 'hand out', 'shape save',
  'shape editor', 'trigger create', 'front door', 'findings rail',
] as const
type DialogOption = (typeof DIALOG_OPTIONS)[number]

/**
 * Goals, findings and shapes: a "goals dialog" dial for every sheet that
 * covers the page — create, assign, wrap, carry, decide, publish, add a
 * member, add work, hand work out, save a shape, the shape editor itself
 * (a `Dialog`), every time (`TriggerCreate`, also a `Dialog`), the front
 * door — off by default, one option each. Plain frames below it show the
 * parts a Goal's own page or rail already draws inline: a round's status, a
 * receipt as it reads once wrapped and its accounting (loading and loaded),
 * one shape step, one rule and the graph they compose, and the `/`-menu
 * every composer opens. The findings rail joins the dial rather than sitting
 * as its own frame: it names the same Goal `TeamRoomPane`'s own rail already
 * shows findings for, behind its "Findings" row — a second copy open by
 * default doubled the "Open" tab and `finding-open-1` row the existing
 * findings.spec.ts reaches for expecting one.
 */
/** A public frame mounts only the finding's synthetic surface, without unrelated preview tooltips. */
export const FindingFrames = ({ scene }: { readonly scene: string | null }) => scene === 'rail' ? (
  <Frame id="goal-findings-rail" title="Goal — its findings rail">
    <div className="max-h-[480px] overflow-y-auto p-4"><GoalFindings goal={PREVIEW_GOAL.goal.id} /></div>
  </Frame>
) : (
  <FindingDetail goal={PREVIEW_GOAL.goal.id} finding={scene === 'before' ? 'finding-before-selection' : scene === 'advisory-before' ? 'finding-before-advisory-selection' : scene === 'advisory' ? 'finding-not-kept-advisory' : 'finding-not-kept-1'} decide={RUN_VIEW} onClose={() => {}} />
)

export const GoalFrames = () => {
  const [dialog, setDialog] = useState<DialogOption>('off')
  return (
    <>
      <div className="my-4 flex flex-wrap items-center gap-3">
        <Dial label="goals sheet" value={dialog} options={DIALOG_OPTIONS} onChange={setDialog} />
      </div>
      {/* Bare, position:fixed, and not inside a `Frame` (which carries
          its own `Boundary`) — without one here a throw would unmount
          every frame this page draws, not just this file's own. */}
      <Boundary>
        {dialog === 'goal create' && <GoalCreate root={PREVIEW_ROOT} onClose={() => setDialog('off')} />}
        {dialog === 'goal assign' && <GoalAssign view={PREVIEW_GOAL} card={PREVIEW_INTENTS[0]?.id ?? 1} onClose={() => setDialog('off')} />}
        {dialog === 'goal wrap' && <GoalWrap view={PREVIEW_GOAL} onClose={() => setDialog('off')} />}
        {dialog === 'finding carry' && <FindingCarry source={CARRY_SOURCE} />}
        {dialog === 'finding decision' && <FindingDecision goal={PREVIEW_GOAL.goal.id} view={RUN_VIEW} onClose={() => setDialog('off')} />}
        {(dialog === 'finding detail' || dialog === 'finding before selection' || dialog === 'finding not kept') && (
          <FindingDetail goal={PREVIEW_GOAL.goal.id} finding={findingDetail(dialog === 'finding not kept' ? 'finding-not-kept-1' : dialog === 'finding before selection' ? 'finding-before-selection' : 'finding-open-1').finding.id} decide={RUN_VIEW} onClose={() => setDialog('off')} />
        )}
        {dialog === 'finding publications' && <FindingPublications goal={PREVIEW_GOAL.goal.id} run="run-preview" stamp="preview-stamp" />}
        {(dialog === 'finding backfill' || dialog === 'finding backfill wrapped') && (
          <FindingBackfillDialog backfill={BACKFILL_PREVIEW} busy={false} record={dialog === 'finding backfill wrapped'}
            onCancel={() => setDialog('off')} onConfirm={() => setDialog('off')} />
        )}
        {dialog === 'add member' && <AddMember room={PREVIEW_GOAL.goal.id} root={PREVIEW_ROOT} onClose={() => setDialog('off')} />}
        {dialog === 'add work' && <AddWork room={PREVIEW_GOAL.goal.id} intents={PREVIEW_INTENTS} onClose={() => setDialog('off')} />}
        {dialog === 'hand out' && (
          <HandOut room={PREVIEW_GOAL.goal.id} intents={PREVIEW_INTENTS} peers={[]} onClose={() => setDialog('off')} onTrouble={() => {}} />
        )}
        {dialog === 'shape save' && <ShapeSave input={SHAPE_SAVE_INPUT} onSaved={() => setDialog('off')} onClose={() => setDialog('off')} />}
        {dialog === 'shape editor' && (
          <ShapeEditor
            root={PREVIEW_ROOT}
            context={{ kind: 'project', root: PREVIEW_ROOT }}
            initialSource={PREVIEW_FLOW_SOURCE['fix']}
            onClose={() => setDialog('off')}
            onStarted={() => setDialog('off')}
          />
        )}
        {dialog === 'trigger create' && (
          <TriggerCreate root={PREVIEW_ROOT} opens={{ agent: 'code-reviewer' }} onSaved={() => setDialog('off')} onClose={() => setDialog('off')} />
        )}
        {dialog === 'front door' && (
          <FrontDoor context={{ kind: 'project', root: PREVIEW_ROOT }} onClose={() => setDialog('off')} onStarted={() => setDialog('off')} />
        )}
      </Boundary>
      {dialog === 'findings rail' && (
        <Frame id="goal-findings-rail" title="Goal — its findings rail">
          <div className="max-h-[480px] overflow-y-auto p-4">
            <GoalFindings goal={PREVIEW_GOAL.goal.id} />
          </div>
        </Frame>
      )}

      <Frame id="finding-status" title="Finding — a review round's status">
        <div className="p-4">
          <FindingRoundStatus view={RUN_VIEW} />
        </div>
      </Frame>
      <Frame id="goal-receipt" title="Goal — its receipt, as recorded when wrapped">
        <div className="max-h-[560px] overflow-y-auto p-4">
          <GoalReceipt receipt={WRAPPED_WITH_FINDINGS.receipt!} root={PREVIEW_ROOT} onOpenFinding={() => {}} />
        </div>
      </Frame>
      <Frame id="goal-accounting" title="Goal — its receipt's own accounting">
        <div className="p-4">
          <GoalReceiptCost receipt={WRAPPED_WITH_FINDINGS.receipt!} />
        </div>
      </Frame>
      <Frame id="insight-loaded" title="Insight — recorded usage, loaded">
        <div className="p-4">
          <InsightCost report={INSIGHT_REPORT} loading={false} problem={null} onRefresh={() => {}} />
        </div>
      </Frame>
      <Frame id="insight-partial" title="Project usage — partial source scan">
        <div className="p-4">
          <InsightUsage root={PREVIEW_ROOT} runtime={null} view="goal" onGoal={() => {}} report={{
            ...INSIGHT_REPORT, scan: 'partial', gaps: ['Insight stopped at 64 MiB of source data. Choose a narrower range.'],
            breakdowns: INSIGHT_REPORT.breakdowns.map((breakdown) => ({ ...breakdown, dimension: 'goal',
              rows: breakdown.rows.map((row) => ({ ...row, amounts: { ...row.amounts, usd: { ...row.amounts.usd, coverage: 'partial' } } })),
            })),
          }} />
        </div>
      </Frame>
      <Frame id="insight-loading" title="Insight — recorded usage, loading">
        <div className="p-4">
          <InsightCost report={null} loading problem={null} onRefresh={() => {}} />
        </div>
      </Frame>
      {/* `ShapeEditor` (a `Dialog`, chosen from the dial above) opens on its
          own "steps" tab, `ShapeStep` once per role; mounted directly too, so
          the step form is on the page whether or not that dialog is open. */}
      <Frame id="shape-step-form" title="Shape — one step's own form">
        <div className="max-w-[520px] p-4">
          <ShapeStep role={SHAPE_STEP_ROLE} agents={PREVIEW_AGENTS} runtimes={[]} onChange={() => {}} />
        </div>
      </Frame>
      <Frame id="shape-rule-form" title="Shape — one rule's own form">
        <div className="max-w-[520px] p-4">
          <ShapeRule rule={SHAPE_POLICY_WITH_RULE.rule} policy={SHAPE_POLICY_WITH_RULE.policy} onChange={() => {}} />
        </div>
      </Frame>
      {/* `ShapeEditor`'s own Graph tab reaches this same component from a real
          click; mounted directly too, so the graph is on the page whether or
          not that dialog is open. Two roles and the rule between them, so
          this draws an edge rather than one bare node. */}
      <Frame id="shape-graph" title="Shape — the graph">
        <div className="h-[420px] p-4">
          <ShapeGraph policy={SHAPE_POLICY_WITH_RULE.policy} selected={null} onSelect={() => {}} onPositions={() => {}} onEditRule={() => {}} />
        </div>
      </Frame>
      <Frame id="command-menu" title="The / and @ menu">
        <div className="w-[320px] p-4">
          <TriggerMenu title="Agents" items={TRIGGER_MENU_ITEMS} activeIndex={0} onHover={() => {}} onPick={() => {}} />
        </div>
      </Frame>
    </>
  )
}
