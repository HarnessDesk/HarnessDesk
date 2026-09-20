import type { CaptureHealth, CommitProvenance, WorkspaceEntry } from '@harnessdesk/protocol'

/** Capture is a local observation, never a check verdict. */
export const captureWords = (health: CaptureHealth): { label: string; tone: 'success' | 'warning' | 'neutral' } =>
  health.state === 'healthy'
    ? { label: 'Healthy', tone: 'success' }
    : health.state === 'degraded'
      ? { label: 'Degraded', tone: 'warning' }
      : { label: 'Stopped', tone: 'neutral' }

export const provenanceWords = (value: CommitProvenance): string =>
  value.state === 'pending'
    ? 'Capture is catching up'
    : value.state === 'unattributed'
      ? 'Unattributed'
      : value.coverage === 'partial'
        ? 'Partly attributed'
        : 'Associated Seat'

/** A linked checkout queries by path but capture is retained at its project root. */
export const captureForRoot = (
  root: string,
  health: ReadonlyMap<string, CaptureHealth>,
  workspaces: readonly WorkspaceEntry[],
): CaptureHealth | undefined => {
  const project = workspaces.find((workspace) => workspace.path === root)?.repo?.root ?? root
  return health.get(project) ?? health.get(root)
}
