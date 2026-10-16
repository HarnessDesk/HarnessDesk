import type { LibraryIntent, LibraryPlan, LibraryPlannedOp, LibrarySourceResult } from '@harnessdesk/protocol'

const FILES = [
  { path: 'SKILL.md', bytes: 1024, runnable: false, binary: false, reason: null },
  { path: 'references/checklist.md', bytes: 2150, runnable: false, binary: false, reason: null },
  { path: 'scripts/list-files.sh', bytes: 118, runnable: true, binary: false, reason: 'starts with #!' },
] as const
export const GITHUB_SOURCE: LibrarySourceResult = {
  url: 'https://github.com/acme-dev/skills', repo: 'acme-dev/skills', ref: 'main', commit: '1a2b3c4d5e6f789012345678901234567890123456', path: '',
  skills: [
    { name: 'code-review', dir: 'review/code-review', sourcePath: '/home/jane/.harnessdesk/library/sources/review', files: 3, runnable: 1, binary: 0, bytes: 3292, bundle: 'fixture-review' },
    { name: 'project-checks', dir: 'review/project-checks', sourcePath: '/home/jane/.harnessdesk/library/sources/checks', files: 4, runnable: 1, binary: 1, bytes: 3308, bundle: 'fixture-checks' },
    { name: 'changelog', dir: '', sourcePath: '/home/jane/.harnessdesk/library/sources/changelog', files: 1, runnable: 0, binary: 0, bytes: 1024, bundle: 'fixture-changelog' },
  ], refused: [{ dir: 'legacy-tools', reason: 'It contains a link at bin/run; links are not carried.' }],
}
export const githubPlan = (intents: readonly LibraryIntent[]): LibraryPlan => ({
  plannedAt: 1,
  ops: intents.flatMap((intent, index): LibraryPlannedOp[] => {
    if (intent.kind !== 'installSkill' || !intent.origin) return []
    const skill = GITHUB_SOURCE.skills.find(s => s.sourcePath === intent.sourcePath)
    if (!skill) return []
    return [{ id: `github-${index}`, kind: 'skill', name: intent.name, action: 'create', targetRuntime: intent.targetRuntime,
      targetPath: `/home/jane/.${intent.targetRuntime}/skills/${intent.name}`, sourcePath: skill.sourcePath, origin: intent.origin,
      files: skill.runnable === 0 ? [FILES[0]] : skill.binary > 0 ? [...FILES, { path: 'data/index.bin', bytes: 16, binary: true, runnable: false, reason: null }] : FILES,
      preview: '--- /dev/null\n+++ SKILL.md\n@@ -0,0 +1,2 @@\n+# Review\n+Read the checklist before reviewing.', content: '# Review\nRead the checklist before reviewing.\n', guardDigest: null, backup: false,
    }]
  }),
})
export const githubFile = (path: string) => ({
  text: path.endsWith('.bin') ? null : '#!/bin/sh\n# Lists the files the current diff touches, for the review checklist.\ngit diff --name-only "$1"...HEAD\n', truncated: false,
})
