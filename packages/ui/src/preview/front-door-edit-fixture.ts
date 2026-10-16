// Current specimens share the canonical shipped policy. Only the explicitly
// named before case retains the former publication contract. No account data.
import type { FlowPolicy } from '@harnessdesk/protocol'
import { TEAM_START_POLICIES } from './team-start-fixture'

export const EDIT_TEAM_START_POLICY: FlowPolicy = TEAM_START_POLICIES['fix-and-review']

export const BEFORE_TEAM_START_POLICY: FlowPolicy = {
  ...EDIT_TEAM_START_POLICY,
  roles: EDIT_TEAM_START_POLICY.roles.map(role => role.id === 'fixer' && role.kind === 'agent' ? { ...role, grant: 'publish' } : role),
  rules: EDIT_TEAM_START_POLICY.rules.map(rule => rule.id === 'review-it' ? {
    ...rule, when: { every: ['published'] },
    then: { role: 'reviewer', title: 'Review the pull request', detail: "Review the pull request the fixer's context package names independently." },
  } : rule.id === 'fix-again' ? {
    ...rule, then: { role: 'fixer', title: 'Answer the reviews', detail: 'Answer every finding, push to the same branch, and publish again.' },
  } : rule.id === 'hand-to-the-person' ? {
    ...rule, then: { role: 'referee', title: 'Merge it — every reviewer approved', detail: 'Merging is yours; no agent in this flow may do it.' },
  } : rule),
  seed: { role: 'fixer', title: '{{work}}', detail: 'Open a pull request for it when it is done and working.' },
}
