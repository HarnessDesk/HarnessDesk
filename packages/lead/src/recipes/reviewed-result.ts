/** Private source, deliberately outside the host's built-in Flow catalogue.
 * Checks are the project's declared checks, run by the worker through its existing
 * tools and judged from desk evidence. No model-generated shell command is inserted. */
export const leadReviewedResultSource = `version: 2
name: Lead reviewed result
inputs: {}
roles:
  implement:
    kind: agent
    uses: [implementer]
    isolate: true
    grant: edit
    independentOf: []
  review:
    kind: agent
    uses: [code-reviewer]
    grant: read
    independentOf: [implement]
  accept:
    kind: person
    outcomes: [accepted, declined]
complete: { accept: [accepted, declined] }
seed:
  role: implement
  title: Implement the approved goal
  detail: Commit the change and run the project's declared required checks. Never publish, merge, delete or wrap the Goal.
rules:
  - id: check-and-review
    on: implement
    when: { every: [committed] }
    then:
      role: review
      title: Check and review the committed result
      detail: Inspect the required check evidence and committed revision independently. Record a structured review and all blocking findings. Missing checks are not approval.
  - id: repair
    on: review
    when: { any: [request-changes] }
    then:
      role: implement
      title: Repair the blocking findings and rerun required checks
  - id: person-acceptance
    on: review
    when: { every: [approve], evidence: [{ review: approve }] }
    then:
      role: accept
      title: Accept or decline the reviewed result
      detail: Acceptance records your decision only. Publishing, merging, deleting and wrapping remain separate actions.
messaging: board-only
budget: { rounds: 10, without-progress: 2 }
wait: 240
`
export const LEAD_REVIEWED_RESULT = Object.freeze({ id: 'lead-reviewed-result', revision: 'recipe-1', source: leadReviewedResultSource,
  outcomes: Object.freeze(['accepted', 'declined'] as const) })
