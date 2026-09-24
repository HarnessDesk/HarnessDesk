import type { FrontDoorPreview, FrontDoorPreviewInput, StartContext } from '@harnessdesk/protocol'

import { previewFlowPreviewFor } from './flow-fixture'

/**
 * The front door's own dry run, for the preview harness: the same worked
 * `FlowPreview` every catalogue entry already answers with (`flow-fixture`'s
 * `previewFlowPreviewFor`), bound to whichever context it was opened on — a
 * branch, a pull request, a diff or the working tree read as words, never a
 * real git call. `sentence` matches what a real dry run fills before anyone
 * has touched it: the shape's own name, and where it runs.
 */
const targetLabel = (context: StartContext): string => {
  switch (context.kind) {
    case 'project': return 'this project'
    case 'branch': return context.branch
    case 'pull-request': return `PR #${context.number}`
    case 'diff': return `${context.from}..${context.to}`
    case 'working-diff': return 'the working tree (not committed)'
  }
}

export const frontDoorPreviewFor = (input: FrontDoorPreviewInput): FrontDoorPreview => {
  const flow = previewFlowPreviewFor(input.source)
  const label = targetLabel(input.context)
  const name = flow.compiled.document.format === 'agents' ? flow.compiled.document.flow.name : label
  return {
    flow,
    target: {
      label,
      base: input.context.kind === 'working-diff' ? null : 'a1b2c3d',
      head: input.context.kind === 'working-diff' ? null : 'e4f5a6b',
      dirty: input.context.kind === 'working-diff',
      independence: 'unknown',
    },
    vars: input.vars,
    source: input.source,
    sentence: `${name} — ${label}`,
    goal: input.goal ?? null,
  }
}
