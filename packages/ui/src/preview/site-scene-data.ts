/** Website-only presentations over the camera's synthetic history. */
import { runtimeId, type LedgerQuery, type LedgerReport, type RuntimeId, type RuntimeInfo } from '@harnessdesk/protocol'
import { siteLedger, siteUsage } from './site-stills-data'

const presentations = {
  codex: { name: 'Codex', brand: 'codex' },
  claude: { name: 'Claude Code', brand: 'claudecode' },
  gemini: { name: 'Gemini', brand: 'geminicli' },
} as const

export const sceneRuntime = (id: RuntimeId): RuntimeId => id === 'cursor' ? runtimeId('gemini') : id
// These two public demo identities are approved by the owner for the website.
export const sceneAccount = (account: string | null): string | null =>
  account === 'dev@example.com' ? 'shane@harnessdesk.app'
    : account === 'work@example.com' ? 'olivia@harnessdesk.app' : account

export const sceneRuntimeInfo = (info: RuntimeInfo): RuntimeInfo => {
  const id = sceneRuntime(info.id)
  return { ...info, id, name: presentations[id as keyof typeof presentations].name,
    presentation: { ...info.presentation, ...presentations[id as keyof typeof presentations] } }
}

const sceneLedger = (report: LedgerReport, groupBy: LedgerQuery['groupBy']): LedgerReport => ({
  ...report,
  daily: report.daily.map(row => ({ ...row, runtime: sceneRuntime(row.runtime) })),
  hourly: report.hourly?.map(row => ({ ...row, runtime: sceneRuntime(row.runtime) })),
  rows: report.rows.map(row => {
    const runtime = sceneRuntime(row.runtime!)
    return { ...row, runtime, label: presentations[runtime as keyof typeof presentations].name,
      key: groupBy === 'model' ? `model-${runtime}` : runtime }
  }),
  coverage: { ...report.coverage,
    turnsKnownFor: report.coverage.turnsKnownFor?.map(sceneRuntime),
    hoursKnownFor: report.coverage.hoursKnownFor?.map(sceneRuntime),
  },
})

// The fictional source year never changes. Reuse it across scene mounts;
// dashboardData copies and shifts its timestamps for each visitor.
export const sceneUsage = siteUsage().map(report => ({ ...report,
  runtime: sceneRuntime(report.runtime), account: sceneAccount(report.account),
}))
const ledgers = new Map<string, LedgerReport>()
export const siteSceneLedger = (days: number, groupBy: LedgerQuery['groupBy']): LedgerReport => {
  const key = `${days}:${groupBy}`
  let report = ledgers.get(key)
  if (!report) { report = sceneLedger(siteLedger({ days, groupBy }), groupBy); ledgers.set(key, report) }
  return report
}
