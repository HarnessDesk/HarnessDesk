import { runtimeId, type Library, type LibraryIntent, type LibraryPlan, type LibrarySkillOrigin, type LibrarySkillUpdate, type LibrarySourceResult } from '@harnessdesk/protocol'

export const UPDATE_ORIGIN: LibrarySkillOrigin = { url: 'https://github.com/acme-dev/skills', ref: 'main', commit: '1a2b3c4d5e6f789012345678901234567890123456', path: 'review/code-review' }
export const UPDATE_SOURCE: LibrarySourceResult = {
  ...UPDATE_ORIGIN, commit: '9f8e7d6c5b4a321098765432109876543210987654', repo: 'acme-dev/skills',
  skills: [{ name: 'code-review', dir: UPDATE_ORIGIN.path, sourcePath: '/home/jane/.harnessdesk/library/sources/review', files: 3, runnable: 1, binary: 0, bytes: 1492, bundle: 'review-update' }], refused: [],
}
export const libraryUpdateFixture = (status: LibrarySkillUpdate['status'] | 'unchecked' = 'behind'): Library => ({
  home: '/home/jane', generatedAt: 1, runtimes: [runtimeId('alpha')], gaps: [],
  locations: [{ runtime: runtimeId('alpha'), kind: 'skill', path: '/home/jane/.alpha/skills', scope: 'user', scanned: true, exists: true, readOnly: false }],
  entries: [{ kind: 'skill', name: 'code-review', title: 'Code review', description: 'Review the current diff for correctness bugs and missing tests.', catalogTokens: 26,
    copies: [{ path: '/home/jane/.alpha/skills/code-review', readBy: [runtimeId('alpha')], scope: 'user', hollow: false, digest: 'review', readOnly: false, origin: UPDATE_ORIGIN }],
    reach: [{ runtime: runtimeId('alpha'), state: 'reaches', basis: 'reported' }],
    ...(status === 'unchecked' ? {} : { update: [{ name: 'code-review', runtime: runtimeId('alpha'), origin: UPDATE_ORIGIN, latest: status === 'behind' ? UPDATE_SOURCE.commit : null, status, reason: status === 'gone' ? 'The branch main no longer exists.' : status === 'unreachable' ? 'The repository did not answer. Try again later.' : null }] }),
  }],
})
export const libraryUpdatePlan = (intents: readonly LibraryIntent[], edited: boolean): LibraryPlan => ({
  plannedAt: 1,
  ops: intents.flatMap((intent, index) => intent.kind !== 'updateSkill' ? [] : [{
    id: `update-${index}`, kind: 'skill' as const, name: intent.name, action: edited ? 'replace' as const : 'update' as const,
    targetRuntime: intent.targetRuntime, targetPath: `/home/jane/.${intent.targetRuntime}/skills/${intent.name}`,
    sourcePath: UPDATE_SOURCE.skills[0]!.sourcePath, origin: intent.origin, replaceBundle: true, guardDigest: 'review', backup: edited,
    ...(edited ? { reason: 'This copy has been edited since install; the edited copy is backed up before replacement.' } : {}),
    files: [
      { path: 'SKILL.md', bytes: 1230, runnable: false, binary: false, reason: null, change: 'changed' as const },
      { path: 'scripts/check.sh', bytes: 142, runnable: true, binary: false, reason: 'starts with #!', change: 'added' as const },
      { path: 'templates/old.md', bytes: 420, runnable: false, binary: false, reason: null, change: 'removed' as const },
    ],
    preview: '--- SKILL.md\n+++ SKILL.md\n@@ -1,5 +1,5 @@\n ---\n name: code-review\n-description: Review the current diff for correctness bugs.\n+description: Review the current diff for correctness bugs and missing tests.\n ---\n Correctness first.\n',
  }]),
})
