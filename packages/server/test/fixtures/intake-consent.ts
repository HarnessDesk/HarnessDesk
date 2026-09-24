import { createHash } from 'node:crypto'

import type { AgentEntry, CeilingLevel, FlowSeat, SeatPlan } from '@harnessdesk/protocol'

import { plainCipher, type CredentialCipher } from '../../src/credentials.js'
import { FlowPreviews } from '../../src/flow-preview.js'
import { TriggerClosures, TriggerConsent, type TriggerConsentPort } from '../../src/intake/consent.js'
import { tempDir } from '../scratch.js'

/**
 * A trigger-consent rig: a real `TriggerConsent` over a real `FlowPreviews`
 * and `TriggerClosures`, with every outside read (the committed file, the
 * clone's identity, the forge sign-in and repository, the first observation)
 * a mutable field of `world`, so a test changes exactly one thing at a time.
 */

export const sha = (text: string): string => createHash('sha256').update(text).digest('hex')

export const agent = (id: string, digest = `${id}-digest`): AgentEntry => ({
  id, origin: 'project', path: `.harnessdesk/agents/${id}/AGENT.md`, digest, shadows: [], problems: [],
  definition: { id, name: id, ceiling: 'edit', ceilingFrom: 'ceiling', answers: ['approve', 'request-changes'], produces: [], skills: [], mcp: [], prefer: [{ runtime: 'alpha' }], brief: `${id} brief` },
})

export const reviewFlow = (timeout = 60): string => `
version: 2
name: Review a pull request
roles:
  reviewer: { kind: agent, uses: reviewer }
  gate: { kind: check, run: "pnpm test", timeout: ${timeout}, exits: { "0": pass }, otherwise: fail }
seed: { role: reviewer, title: Review it }
rules:
  - { id: verify, on: reviewer, when: { every: [approve] }, then: { role: gate, title: Verify } }
`

export const TRIGGERS = `- id: review
  on: pull-request
  opens: { flow: review-pr }
- id: nightly
  on: schedule
  every: 60
  opens: { agent: reviewer }
- id: forks
  on: pull-request
  forks: allow
  opens: { flow: review-pr }
`

export interface World {
  project: string
  text: string
  incarnation: string
  account: string | null
  repository: string | null
  flows: Record<string, string>
  agents: AgentEntry[]
  seating: 'prefer' | 'machine'
  seats: FlowSeat[]
  now: number
  baselineFails: boolean
  baselines: number
  /** Runs while the first observation is in flight: the gate a race is staged through. */
  duringBaseline: (() => void) | null
  /** Whether a seat can be taken right now: false passes every candidate over, as a runtime that is down does. */
  available: boolean
  /** The seat plan's read fails, as a runtime that cannot be asked right now does. */
  previewFails: boolean
  /** The unattended flag every seat plan was asked with, in order. */
  unattended: boolean[]
  /** Each Agent's resolved attachments, as their identities: kind, name, content digest, source. */
  attachments: Record<string, string[]>
}

export const rig = (options: { home?: string; cipher?: CredentialCipher } = {}) => {
  const world: World = {
    project: '/work/project',
    text: TRIGGERS,
    incarnation: 'clone-1',
    account: 'account-digest-1',
    repository: 'acme/widgets',
    flows: { 'review-pr': reviewFlow() },
    agents: [agent('reviewer')],
    seating: 'prefer',
    seats: [{ runtime: 'alpha' }],
    now: 1_000_000,
    baselineFails: false,
    baselines: 0,
    duringBaseline: null,
    available: true,
    previewFails: false,
    unattended: [],
    attachments: {},
  }
  const previews = new FlowPreviews({
    confine: async () => {},
    agents: async () => world.agents,
    previewAgent: async (_root, id, _seats, grant: CeilingLevel, options): Promise<SeatPlan> => {
      world.unattended.push(options?.unattended === true)
      if (world.previewFails) throw new Error('The runtime could not be asked which seats it has.')
      if (!world.available) {
        return {
          id, from: world.seating, winner: null, blocked: null, ceiling: null,
          candidates: world.seats.map((seat) => ({ seat, label: seat.runtime, runtimeName: seat.runtime, state: 'passed', reason: { kind: 'unavailable', detail: 'crashed' } as never, fix: null })),
        }
      }
      return {
        id, from: world.seating, winner: 0, blocked: null, ceiling: { level: grant, hold: 'held' },
        candidates: world.seats.map((seat, index) => ({ seat, label: seat.runtime, runtimeName: seat.runtime, state: index === 0 ? 'taken' : 'untried', reason: null, fix: null })),
      }
    },
    now: () => world.now,
  })
  const port: TriggerConsentPort = {
    confine: async (root) => {
      if (root !== world.project) throw new Error('That folder is not open.')
      return root
    },
    source: async () => ({
      project: world.project, incarnation: world.incarnation, revision: 'a'.repeat(40),
      sourceDigest: sha(world.text), text: world.text, workingCopyChanged: false,
    }),
    closure: new TriggerClosures({
      flowSource: async (_root, id) => {
        const source = world.flows[id]
        if (source === undefined) throw new Error(`There is no flow called "${id}".`)
        return { source, origin: 'project', path: `.harnessdesk/flows/${id}.yml` }
      },
      // As the host wires it: a trigger's closure is always read as unattended work would be seated.
      preview: (root, source) => previews.freeze(root, source, { unattended: true }),
      attachments: async (_root, agent) => world.attachments[agent] ?? [],
    }),
    account: async () => world.account ? { account: world.account } : { refused: 'The forge is not signed in.', fix: 'Sign in to the forge.' },
    repository: async () => world.repository ? { repository: world.repository } : { refused: 'No forge repository.', fix: 'Add a GitHub remote.' },
    baseline: async () => {
      if (world.baselineFails) throw new Error('The forge could not be read.')
      world.baselines += 1
      world.duringBaseline?.()
      return world.now
    },
    now: () => world.now,
  }
  const home = options.home ?? tempDir('hd-intake-consent-')
  const consent = new TriggerConsent(home, options.cipher ?? plainCipher, port)
  return { world, port, home, consent, previews }
}

