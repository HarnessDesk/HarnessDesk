import { useState } from 'react'

import { CodeEditor } from '../../components/CodeEditor'
import { FolderIcon, SendIcon } from '../../components/Icons'
import { terminalAppearance } from '../adapters/terminal'
import { Dialog } from '../patterns/ModalDialog'
import { Menu, MenuItem } from '../patterns/Menu'
import { Popover } from '../patterns/Popover'
import { PageHead, Row, RowChoice, Rows } from '../patterns/Settings'
import {
  Board,
  BoardCard,
  BoardColumn,
  Button,
  ComposerGap,
  ComposerShell,
  ComposerText,
  ComposerTools,
  Input,
  Switch,
} from '../ui'
import styles from './propagation-page.module.css'

/**
 * A browser-test fixture made only from production implementations.
 *
 * It puts unrelated consumers of the same foundation on one deterministic
 * page so a token perturbation can prove propagation without starting an
 * agent, touching persisted preferences, or copying production markup.
 */
export const PropagationPage = () => {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [terminalRevision, setTerminalRevision] = useState(0)
  const terminal = terminalAppearance()

  return (
    <div className={styles.page}>
      <section data-testid="prop-settings">
        <PageHead
          title="Appearance"
          blurb="The real Settings page furniture and controls."
          actions={<Button data-testid="prop-button">Save</Button>}
        />
        <Rows>
          <Row
            title="Compact rows"
            desc="Use the shared density contract."
            control={<Switch aria-label="Compact rows" />}
          />
        </Rows>
      </section>

      <section data-testid="prop-composer">
        <h2 className={styles.heading}>Composer</h2>
        <ComposerShell>
          <ComposerText defaultValue="One change should reach every surface." />
          <ComposerTools>
            <Button variant="ghost" size="sm">Attach</Button>
            <ComposerGap />
            <Button size="sm"><SendIcon /> Send</Button>
          </ComposerTools>
        </ComposerShell>
      </section>

      <section className={styles.actions}>
        <Button variant="secondary" onClick={() => setDialogOpen(true)}>Open dialog</Button>
        <Popover label="Open menu" align="left">
          {(close) => (
            <Menu close={close}>
              <MenuItem label="Open workspace" onSelect={() => undefined} />
              <MenuItem label="Unavailable action" disabled="No repository is open" onSelect={() => undefined} />
            </Menu>
          )}
        </Popover>
      </section>

      <section className={styles.actions} data-testid="state-contracts">
        <Button variant="navigation" size="navigation" data-selected="">Selected page</Button>
        <Button variant="row" size="row" data-insert="into">Drop target</Button>
        <Button variant="action" size="icon-circle" data-when="later" aria-label="Queue message"><SendIcon /></Button>
        <Input aria-label="Icon input" variant="quiet" controlSize="compact" data-icon="leading" />
        <Button variant="ghost" size="content" data-on="" aria-label="Avatar mark"><FolderIcon size={32} /></Button>
        <Button variant="row" size="row" data-current="" data-indent="">Current branch</Button>
        <Button variant="quiet" size="inline" aria-pressed>Background tasks</Button>
        <span data-register="light"><Button variant="quiet" size="row">Transcript step</Button></span>
      </section>

      {/* Each selectable role at rest beside each way it can be chosen, so the
          contract compares like with like: a fill that differs, and a weight
          that does not. */}
      {/* Wrapping, so the settings answers get a line of their own: a `Rows`
          card has no width of its own to offer a shrinking flex row, and one
          squeezed beside the buttons clipped its answers to their padding. */}
      <section className={`${styles.actions} flex-wrap`} data-testid="selection-contracts">
        <Button variant="navigation" size="navigation">Resting page</Button>
        <Button variant="navigation" size="navigation" data-selected="">Chosen page</Button>
        <Button variant="row" size="row">Resting branch</Button>
        <Button variant="row" size="row" data-current="">Checked-out branch</Button>
        <Button variant="choice" size="default">Resting option</Button>
        <Button variant="choice" size="default" data-on="">Option turned on</Button>
        <Button variant="choice" size="default" role="radio" aria-checked="true">Option checked</Button>
        <Rows className="basis-full">
          <RowChoice title="Resting answer" selected={false} onClick={() => undefined} />
          <RowChoice title="Chosen answer" selected onClick={() => undefined} />
        </Rows>
      </section>

      {dialogOpen && (
        <Dialog
          title="Add a workspace"
          icon={<FolderIcon />}
          onClose={() => setDialogOpen(false)}
          footer={<Button onClick={() => setDialogOpen(false)}>Add</Button>}
        >
          This is the production dialog pattern in its real portal.
        </Dialog>
      )}

      <section data-testid="prop-board">
        <h2 className={styles.heading}>Board</h2>
        <Board>
          <BoardColumn title="In progress" count={1}>
            <BoardCard title="Verify foundation propagation" note="Long enough to exercise the card anatomy." />
          </BoardColumn>
        </Board>
      </section>

      <section data-testid="prop-editor">
        <h2 className={styles.heading}>Specialized renderer adapter</h2>
        <div className={styles.editor}>
          <CodeEditor
            value={'const shared = "foundation"\n'}
            path="foundation.ts"
            dark={false}
            look={{ fontFamily: 'var(--hd-font-code)', fontSize: 12, lineHeight: 1.5 }}
            ariaLabel="Foundation adapter editor"
          />
        </div>
        <div
          className={styles.terminalProbe}
          data-testid="terminal-adapter"
          data-revision={terminalRevision}
          data-background={terminal.theme.background}
          data-cursor={terminal.theme.cursor}
          data-font={terminal.fontFamily}
        >
          <code>❯ pnpm verify</code>
          <Button size="sm" variant="ghost" onClick={() => setTerminalRevision((value) => value + 1)}>
            Refresh renderer bridge
          </Button>
        </div>
      </section>
    </div>
  )
}
