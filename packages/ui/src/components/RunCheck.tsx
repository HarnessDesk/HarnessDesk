import { useEffect, useState } from 'react'

import type { CheckUnseen } from '@harnessdesk/protocol'

import { CodeText, ConfirmDialog } from '../design'
import { shortPath } from '../lib/paths'
import { useSnapshot } from '../state/context'

export const ARM_MS = 600

export const RunCheck = ({
  unseen,
  card,
  busy,
  onRun,
  onCancel,
}: {
  readonly unseen: CheckUnseen
  readonly card: number
  readonly busy: boolean
  readonly onRun: () => void
  readonly onCancel: () => void
}) => {
  const snapshot = useSnapshot()
  const { check, previous } = unseen
  const [armed, setArmed] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ARM_MS)
    return () => clearTimeout(timer)
  }, [])
  return (
    <ConfirmDialog
      title={
        previous === null
          ? `Run ${check.name} on this Mac for the first time?`
          : `${check.name} has changed since it last ran here`
      }
      tone="default"
      confirmLabel={`Run ${check.name}`}
      cancelLabel="Not now"
      busy={busy}
      busyLabel="Starting…"
      pending={!armed}
      onConfirm={onRun}
      onCancel={onCancel}
    >
      <div className="flex flex-col gap-2">
        <p>{`For #${card}, in ${shortPath(unseen.cwd, snapshot.home)}, it runs exactly this:`}</p>
        <CodeText as="pre" className="whitespace-pre-wrap break-all">
          {check.run}
        </CodeText>
        {previous !== null && (
          <>
            <p>What ran under this name before:</p>
            <CodeText as="pre" className="whitespace-pre-wrap break-all">
              {previous}
            </CodeText>
          </>
        )}
        <p>
          It runs with your full authority, as it would in your terminal: it can read and change anything you can, and
          reach the network. It is given none of HarnessDesk&apos;s own settings or tokens.
        </p>
        <p>
          {`It comes from ${shortPath(unseen.file, snapshot.home)}, which anyone who can change this project can edit. This Mac asks once for each command, and again whenever that file changes.`}
        </p>
      </div>
    </ConfirmDialog>
  )
}
