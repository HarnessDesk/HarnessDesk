import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ASSESS_UNCONFIRMED } from '../../src/intake/mentions.js'

export const stopProject = '/synthetic/project', stopTrigger = 'ask', stopRepository = 'demo/project'
export const stopFiring = 'a'.repeat(64)
export const stopRun = JSON.stringify({ epoch: '00000000-0000-4000-8000-000000000001', version: 0, id: 'run-1', goal: 'goal-1', intake: stopFiring })
export const stopArm = { project: stopProject, id: stopTrigger, armedAt: 1, definition: { handle: 'dex' }, binding: { account: '7', repository: stopRepository } } as never
export const stopFact = { source: 'mention', project: stopProject, repository: stopRepository, subject: '1', thread: 'issue', author: '7', login: 'jane-doe',
  body: '@dex stop', url: 'https://example.com/issue#issuecomment-9999', at: 15 } as never
export const noAdmission = async (): Promise<never> => { throw new Error('a stop must not admit work') }

/** Seed before constructing triage: a cached ledger must never be patched under a running instance. */
export const seedStopCapacity = async (home: string, protectedCount: number): Promise<string> => {
  const thread = { id: 'thread-1', trigger: stopTrigger, project: stopProject, repository: stopRepository, origin: { kind: 'issue', number: 1 },
    links: { issues: [1], pulls: [], goals: ['goal-1'] }, state: 'open', closed: null, resumes: 0, observations: 0,
    openedAt: 0, firings: [stopFiring], seen: [] }
  const make = (i: number, reason: string) => ({ id: `d-capacity-${i}`, trigger: stopTrigger, project: stopProject, repository: stopRepository,
    thread: { kind: 'issue', number: i + 2 }, comment: { id: String(80000 + i), url: `https://example.com/issue#issuecomment-${80000 + i}`,
      at: 10, author: 'jane-doe', excerpt: '@dex please fix' }, decision: 'ask', reason, by: 'assessment', rules: [], mode: 'act', acted: false, work: null, decidedAt: 10, evaluations: 0 })
  const decisions = Array.from({ length: protectedCount }, (_, i) => make(i, ASSESS_UNCONFIRMED))
  if (protectedCount === 499) decisions.push(make(499, 'Ordinary old decision'))
  const bytes = JSON.stringify({ version: 1, decisions, threads: [thread], pendingThreads: [], stopIntents: [],
    modes: { [`${stopProject}\u0000${stopTrigger}`]: { mode: 'act', armedAt: 1 } }, assessed: { day: '', count: 0 } })
  await writeFile(join(home, 'triggers-mentions.json'), bytes)
  return bytes
}
