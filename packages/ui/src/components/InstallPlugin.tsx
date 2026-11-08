import { useCallback, useEffect, useRef, useState } from 'react'

import {
  ActionError,
  Button,
  CodeText,
  Dialog,
  Input,
  Field,
  Rows,
  Row,
  Note,
  Text,
} from '../design'
import { useStore } from '../state/context'
import { AlertIcon, FolderIcon } from './Icons'

/**
 * Installing a plugin.
 *
 * Two steps on purpose. The manifest is read and shown before anything is
 * installed or imported, because "what is this allowed to do" is a question the
 * user must be able to answer *before* the answer stops mattering. An install
 * flow that hides the grant defeats the permission gate it is feeding.
 *
 * The surface, Escape, focus and where the buttons go are `Dialog`'s. This
 * screen used to draw all four out of `Settings.module.css`, and got one of
 * them wrong by omission: there was no Escape handler at all, so the only ways
 * out were the × and the ground behind it.
 *
 * Updating a plugin from its source folder is the same two steps, started on
 * the second: the new manifest is what the person agrees to, and the install
 * carries back the digest of the one shown, so a manifest that changes after
 * it was read is refused rather than accepted unseen.
 */

interface Inspected {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly version?: string
  readonly permissions: readonly string[]
  readonly alreadyInstalled: boolean
  readonly manifestDigest: string
}

export const InstallPlugin = ({ onClose, source }: {
  onClose: () => void
  /** An installed plugin's source folder: reads it at once, to update from it. */
  source?: string
}) => {
  const store = useStore()
  const [specifier, setSpecifier] = useState(source ?? '')
  const [inspected, setInspected] = useState<Inspected | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const look = useCallback(async () => {
    const value = specifier.trim()
    if (value.length === 0) return
    setBusy(true)
    setError(null)
    try {
      setInspected(await store.transport.request('plugin/inspect', { specifier: value }))
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown))
      setInspected(null)
    } finally {
      setBusy(false)
    }
  }, [specifier, store])

  const started = useRef(false)
  useEffect(() => {
    if (!source || started.current) return
    started.current = true
    void look()
  }, [look, source])

  const confirm = useCallback(async () => {
    if (!inspected) return
    setBusy(true)
    setError(null)
    try {
      await store.transport.request('plugin/install', {
        specifier: specifier.trim(),
        manifestDigest: inspected.manifestDigest,
      })
      await store.loadPlugins()
      store.notice('info', source ? `${inspected.name} updated from ${source}.` : `${inspected.name} installed.`)
      onClose()
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setBusy(false)
    }
  }, [inspected, onClose, source, specifier, store])

  return (
    <Dialog
      title={source ? 'Update from source' : 'Install a plugin'}
      size="md"
      onClose={onClose}
      footer={
        inspected ? (
          <>
            <Button variant="default" disabled={busy} onClick={() => void confirm()}>
              {busy ? 'Installing…' : 'Install and enable'}
            </Button>
            <Button variant="secondary"
              disabled={busy}
              onClick={() => {
                setInspected(null)
                setError(null)
              }}
            >
              Back
            </Button>
          </>
        ) : <>
          <Button variant="default" disabled={busy || specifier.trim().length === 0} onClick={() => void look()}>
            {busy ? 'Reading…' : 'Continue'}
          </Button>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
        </>
      }
    >
      {!inspected ? (
        <>
          <Text as="p" role="muted">
            A folder on this machine, or a package on npm. Its manifest is read and shown to you
            before anything is installed or run.
          </Text>
          <Field label="Plugin folder or package">{control =>
            <Input {...control}
              placeholder="/path/to/plugin  or  @scope/plugin-name"
              value={specifier}
              autoFocus
              onChange={(event) => setSpecifier(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void look()
              }}
            />
          }</Field>
          <Note ink="muted" icon={<FolderIcon size={13} />}>
            A plugin folder needs a <CodeText as="code" size="inherit">harnessdesk.plugin.json</CodeText> at
            its root.
          </Note>
        </>
      ) : (
        <>
          <Text as="div" role="subject">{inspected.name}</Text>
          <Text as="p" role="muted">
            {inspected.description ?? 'No description provided.'}
            {inspected.version ? ` · v${inspected.version}` : ''}
          </Text>

          <Rows>
            <Row title="This plugin will be able to" />
            {inspected.permissions.map((line, index) => <Row key={`${index}:${line}`} title={line} />)}
          </Rows>

          <Note ink="muted" icon={<AlertIcon size={13} />}>
            Plugins run in the HarnessDesk plugin host. Permissions are enforced at every call,
            but a plugin is still code from its author — install ones you would be willing to run.
          </Note>

          {inspected.alreadyInstalled && (
            <Note ink="muted">
              A plugin with this id is already installed and will be replaced.
            </Note>
          )}
        </>
      )}

      {error && (
        <ActionError>{error}</ActionError>
      )}
    </Dialog>
  )
}
