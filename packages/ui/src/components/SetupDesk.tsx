import { useEffect } from 'react'

import type { RuntimeId } from '@harnessdesk/protocol'

import { readinessOf, type Readiness } from '../lib/readiness'
import { useSnapshot, useStore } from '../state/context'
import { RuntimeMark } from './BrandIcons'
import { Btn } from '../design/primitives/Kit'
import styles from './SetupDesk.module.css'

/**
 * The whole desk, surveyed — shown by the empty pane when the selected agent
 * cannot start, and the first-run answer to "now what?".
 *
 * One row per agent on this machine, each with its state and its one next
 * move: a dead agent carries the real error and the fix, a signed-out one a
 * sign-in button, a healthy one the offer to use it instead. The last line
 * opens the add-agent page, because "install an agent HarnessDesk can see"
 * used to require knowing that `agents.json` exists.
 */
export const SetupDesk = ({
  onSignIn,
  onOpenAgents,
}: {
  onSignIn: (runtime?: RuntimeId) => void
  onOpenAgents: () => void
}) => {
  const store = useStore()
  const snapshot = useSnapshot()

  // A registry can hold more than one entry for the same agent. Until account
  // data arrives their shared brand and tagline are identical, so the entry's
  // registry name is the only stable way to keep the actions distinguishable.
  // Show it only for duplicate brands, and never repeat the brand itself.
  const brandCount = new Map<string, number>()
  for (const info of snapshot.runtimes) {
    brandCount.set(info.presentation.name, (brandCount.get(info.presentation.name) ?? 0) + 1)
  }
  const whichOf = (info: (typeof snapshot.runtimes)[number]): string | null =>
    (brandCount.get(info.presentation.name) ?? 0) > 1 && info.name !== info.presentation.name
      ? info.name
      : null

  // Sign-in state per agent comes from the same read the settings page uses;
  // without it every agent here would look signed out.
  useEffect(() => {
    void store.loadAccounts()
  }, [store])

  return (
    <>
      <div className={styles.list}>
        {snapshot.runtimes.map((info) => {
          const health = snapshot.healthByRuntime[info.id] ?? null
          const account = snapshot.accountsByRuntime[info.id] ?? null
          const state: Readiness = readinessOf({
            registered: true,
            health,
            account,
            accounts: info.capabilities.account,
            usage: snapshot.usage.filter((report) => report.runtime === info.id),
          })
          const sentence =
            state === 'broken' && health?.state === 'unavailable'
              ? `${health.message}${health.remediation ? ` ${health.remediation}` : ''}`
              : state === 'signin'
                ? 'Signed out — a session sent to it would not start.'
                : state === 'limit'
                  ? 'Its plan window is spent; it comes back when the window resets.'
                  : (info.presentation.tagline ?? 'Ready.')
          const which = whichOf(info)
          return (
            <div key={info.id} className={styles.row}>
              <span className={styles.rowMark}>
                <RuntimeMark runtime={info} size={14} />
              </span>
              <span className={styles.rowText}>
                <span className={styles.rowName}>
                  {info.presentation.name}
                  {which && <span className={styles.rowWhich}>{which}</span>}
                </span>
                <span className={styles.rowState}>{sentence}</span>
              </span>
              <span className={styles.rowAction}>
                {state === 'signin' ? (
                  <Btn small variant="primary" onClick={() => onSignIn(info.id)}>
                    Sign in
                  </Btn>
                ) : state === 'ready' && info.id !== snapshot.activeRuntime ? (
                  <Btn small onClick={() => void store.selectRuntime(info.id)}>
                    Use this agent
                  </Btn>
                ) : null}
              </span>
            </div>
          )
        })}
      </div>
      <p className={styles.foot}>
        Another agent on this machine?{' '}
        <button type="button" className={styles.footLink} onClick={onOpenAgents}>
          Add an agent…
        </button>
      </p>
    </>
  )
}
