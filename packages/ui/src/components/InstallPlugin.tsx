import { useCallback, useState } from 'react'

import {
  ActionError,
  Button,
  CodeText,
  Dialog,
  Input,
  Note,
  Section,
  SectionBody,
  Text,
} from '../design'
import { useStore } from '../state/context'
import { AlertIcon, FolderIcon, PluginIcon } from './Icons'
import styles from './InstallPlugin.module.css'

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
 */

interface Inspected {
  readonly id: string
  readonly name: string
  readonly description?: string
  readonly version?: string
  readonly permissions: readonly string[]
  readonly alreadyInstalled: boolean
}

export const InstallPlugin = ({ onClose }: { onClose: () => void }) => {
  const store = useStore()
  const [specifier, setSpecifier] = useState('')
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

  const confirm = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      await store.transport.request('plugin/install', { specifier: specifier.trim() })
      await store.loadPlugins()
      store.notice('info', `${inspected?.name ?? 'Plugin'} installed.`)
      onClose()
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : String(thrown))
    } finally {
      setBusy(false)
    }
  }, [inspected, onClose, specifier, store])

  return (
    <Dialog
      title="Install a plugin"
      icon={<PluginIcon size={16} />}
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
        ) : undefined
      }
    >
      {!inspected ? (
        <>
          <Text as="p" role="muted" className={styles.blurb}>
            A folder on this machine, or a package on npm. Its manifest is read and shown to you
            before anything is installed or run.
          </Text>
          <div className={styles.ask}>
            <Input
              placeholder="/path/to/plugin  or  @scope/plugin-name"
              value={specifier}
              autoFocus
              onChange={(event) => setSpecifier(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void look()
              }}
            />
            <Button variant="default" disabled={busy || specifier.trim().length === 0} onClick={() => void look()}>
              {busy ? 'Reading…' : 'Continue'}
            </Button>
          </div>
          <Note className={styles.note} ink="muted" icon={<FolderIcon size={13} />}>
            A plugin folder needs a <CodeText as="code" size="inherit">harnessdesk.plugin.json</CodeText> at
            its root.
          </Note>
        </>
      ) : (
        <>
          <Text as="div" role="subject">{inspected.name}</Text>
          <Text as="p" role="muted" className={styles.blurb}>
            {inspected.description ?? 'No description provided.'}
            {inspected.version ? ` · v${inspected.version}` : ''}
          </Text>

          <Section variant="quiet" className={styles.grant}>
            <SectionBody spacing="compact">
              <Text as="div" role="muted">This plugin will be able to</Text>
              <div className={styles.permissions} role="list">
                {inspected.permissions.map((line) => (
                  <div className={styles.permission} role="listitem" key={line}>
                    <Text aria-hidden="true" role="muted">•</Text>
                    <Text role="muted">{line}</Text>
                  </div>
                ))}
              </div>
            </SectionBody>
          </Section>

          <Note className={styles.note} ink="muted" icon={<AlertIcon size={13} />}>
            Plugins run in the HarnessDesk plugin host. Permissions are enforced at every call,
            but a plugin is still code from its author — install ones you would be willing to run.
          </Note>

          {inspected.alreadyInstalled && (
            <Note className={styles.note} ink="muted">
              A plugin with this id is already installed and will be replaced.
            </Note>
          )}
        </>
      )}

      {error && (
        <ActionError className="mt-2">{error}</ActionError>
      )}
    </Dialog>
  )
}
