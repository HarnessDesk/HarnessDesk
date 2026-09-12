/**
 * Who every seat is signed in as — answered by the rig, for every runtime.
 *
 * `seed.mjs` isolates what *HarnessDesk* stores. It does not isolate what the
 * **agents** store: a runtime owns its credential store outside that home and
 * the adapter reads through to it, so a desk of twelve invented agents can
 * still seat one real person. Measured at this head, there are three ways in,
 * and only the first is about an agent the rig seeded:
 *
 *  - a seeded row whose id matches an agent the desk knows inherits that
 *    agent's identity reader (`server/src/installs/identity.ts`), which reads
 *    the agent's own file under the real `$HOME`. `cline` among the twelve is
 *    exactly that, and the reader takes a home from its caller that the
 *    overlay does not pass — so `HARNESSDESK_HOME` cannot redirect it;
 *  - the built-in Codex runtime is registered on every boot with the real
 *    `~/.codex` as its home and answers `account/read` out of it;
 *  - anything that appears mid-take — a second Codex slot, an agent someone
 *    registers from the interface — arrives after the staging did.
 *
 * So this does not stub the seats it knows about. It answers `runtime/account`
 * for **every** runtime, and an id it has never heard of gets an anonymous
 * "Signed in" rather than a read-through. A rig that only covers the runtimes
 * it anticipated is a rig with a hole the shape of the next agent.
 *
 * The identities are the ones rule 13 sanctions: the project's own demo
 * persona, and states rather than people everywhere else. They mirror the
 * accounts `usage.mjs` bills its reports to, because the dashboard card and
 * the seat row are the same account seen twice — when those drifted apart in
 * the site rig the sidebar said one thing and the board header another.
 * Deliberately only a few carry an address: a desk where all twelve seats
 * carry one photographs as a mailing list.
 */
import { CAST, OLIVIA, PRIMARY, SHANE } from './cast.mjs'

/**
 * `kind` is the runtime's own word for the sort of identity this is, opaque to
 * the shell, which uses it as a key. Every seat here is the same fake ACP
 * agent, and `agent` is what the desk's own reader writes for one of those —
 * so it is what these say, rather than a vendor word no fixture earned.
 */
const person = (email, planType) => ({ kind: 'agent', label: email, email, planType })

/** Signed in, with nobody named: what an ACP agent can honestly report. */
const ANYBODY = { kind: 'agent', label: 'Signed in', anonymous: true }

const status = (...accounts) => ({ accounts, signInMethods: [] })

/**
 * The seats that carry a person, and what they are on.
 *
 * Two accounts on one agent is deliberate — it is a state the interface has a
 * shape for (the name rides along in the picker, the seat cards pair off) and
 * a rig that never produces it cannot photograph it.
 */
export const ACCOUNTS = {
  codex: status(person(SHANE.email, 'Team')),
  'claude-code': status(person(SHANE.email, 'Max 20x'), person(OLIVIA.email, 'Pro')),
  // A label that is a handle rather than an address, because that is what some
  // agents report and the row has to render one.
  cursor: status({ kind: 'agent', label: `${PRIMARY.name}-Cursor`, planType: 'Pro' }),
  'gemini-cli': status(person(SHANE.email, 'Free')),
  copilot: status(person(SHANE.email, null)),
}

/** What any other runtime says, including one the rig has never heard of. */
export const ANONYMOUS = status(ANYBODY)

/** The rig's answer to `runtime/account`, for every runtime there can be. */
export const accountFor = (runtime) => ACCOUNTS[runtime] ?? ANONYMOUS

/**
 * Every identity the rig authored, as the audit's allowlist.
 *
 * A display name has no shape to match on, so the only way to refuse a real
 * one is to know every name that is invented. That is what makes this list the
 * audit's account arm rather than a convenience: anything on screen that is
 * not in here reached the window from a credential store on this machine.
 */
export const VOUCHED = new Set(
  [...Object.values(ACCOUNTS), ANONYMOUS]
    .flatMap((one) => one.accounts)
    .flatMap((account) => [account.label, account.email])
    .filter((one) => typeof one === 'string' && one !== ''),
)

/** Only seat accounts on agents the desk actually has, so a rename cannot orphan one. */
const cast = new Set(CAST.map((one) => one.id))
for (const id of Object.keys(ACCOUNTS)) {
  if (!cast.has(id)) throw new Error(`accounts.mjs names "${id}", which is not in the cast`)
}
