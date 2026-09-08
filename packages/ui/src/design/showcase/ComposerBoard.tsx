import { useState } from 'react'

import { BrandMark } from '@/components/BrandIcons'
import {
  AtIcon,
  HandoffIcon,
  ImageIcon,
  ModelIcon,
  PaperclipIcon,
  QueueIcon,
  SendIcon,
  SlashIcon,
  StopIcon,
  UsageIcon,
} from '@/components/Icons'
import {
  Button,
  ComposerChip,
  ComposerChips,
  ComposerGap,
  ComposerShell,
  ComposerText,
  ComposerTools,
  Progress,
} from '../ui'
import styles from './composer-board.module.css'

/**
 * The composer, in every state it is actually in.
 *
 * The box you type into is the one component a user touches on every single
 * turn, which makes it the component whose states matter most and the one most
 * often designed in only its empty state. The five below are the ones that
 * exist in this app, and each changes something real:
 *
 *   Resting        Nothing typed. The tool row still says who will answer and
 *                  on what model, because that is the decision most often got
 *                  wrong — not the words, the recipient.
 *   Carrying       Attachments and addressed agents ride above the text as
 *                  chips, so they are visible while typing rather than
 *                  discovered on send.
 *   Running        Send becomes Stop. Not disabled — a turn you cannot
 *                  interrupt is the single most frustrating state an agent app
 *                  has, and greying the only control there is says "wait".
 *   Queueing       A turn is running and you typed anyway. The button says
 *                  what will happen, because "send" during a run is a
 *                  different act and pretending otherwise loses messages.
 *   Full           Context is nearly spent. The meter appears only here; a bar
 *                  on every turn is a bar nobody reads.
 *
 * All five are the same `ComposerShell`. What differs is what is in it — which
 * is the test: if a state needed its own component, the shell would be wrong.
 */

const Case = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div>
    <div className={styles.caseLabel}>{label}</div>
    {children}
  </div>
)

export const ComposerBoard = () => {
  const [text, setText] = useState('')

  return (
    <div className={styles.composerCases}>
      <Case label="resting — live, type in it">
        <ComposerShell>
          <ComposerText
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="Ask anything, or / for a command"
          />
          <ComposerTools>
            <Button variant="ghost" size="icon-sm" aria-label="Attach">
              <PaperclipIcon />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Mention a file">
              <AtIcon />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Commands">
              <SlashIcon />
            </Button>
            <Button variant="ghost" size="sm">
              <BrandMark brand="claudecode" size={14} /> Claude Code
            </Button>
            <Button variant="ghost" size="sm">
              <ModelIcon /> Opus 5
            </Button>
            <ComposerGap />
            <Button size="sm" disabled={text.trim() === ''}>
              <SendIcon /> Send
            </Button>
          </ComposerTools>
        </ComposerShell>
      </Case>

      <Case label="carrying — attachments and an addressed agent">
        <ComposerShell>
          <ComposerChips>
            <ComposerChip onRemove={() => undefined}>
              <ImageIcon aria-hidden className="size-3" /> screenshot.png
            </ComposerChip>
            <ComposerChip onRemove={() => undefined}>src/api/auth.ts</ComposerChip>
            <ComposerChip onRemove={() => undefined}>
              <HandoffIcon aria-hidden className="size-3" /> Hand-off from Codex
            </ComposerChip>
          </ComposerChips>
          <ComposerText defaultValue="Same failure as the screenshot — take it from where Codex stopped." />
          <ComposerTools>
            <Button variant="ghost" size="icon-sm" aria-label="Attach">
              <PaperclipIcon />
            </Button>
            <Button variant="ghost" size="sm">
              <BrandMark brand="claudecode" size={14} /> Claude Code
            </Button>
            <ComposerGap />
            <Button size="sm">
              <SendIcon /> Send
            </Button>
          </ComposerTools>
        </ComposerShell>
      </Case>

      <Case label="running — Stop, not a disabled Send">
        <ComposerShell>
          <ComposerText placeholder="Claude Code is working…" />
          <ComposerTools>
            <Button variant="ghost" size="icon-sm" aria-label="Attach">
              <PaperclipIcon />
            </Button>
            <span className="text-xs text-(--hd-muted-foreground) tabular-nums">
              Working for 1m 14s
            </span>
            <ComposerGap />
            <Button size="sm" variant="outline">
              <StopIcon /> Stop
            </Button>
          </ComposerTools>
        </ComposerShell>
      </Case>

      <Case label="queueing — the button says what will happen">
        <ComposerShell>
          <ComposerChips>
            <ComposerChip>
              <QueueIcon aria-hidden className="size-3" /> 2 queued
            </ComposerChip>
          </ComposerChips>
          <ComposerText defaultValue="Also update the changelog when you are done." />
          <ComposerTools>
            <Button variant="ghost" size="icon-sm" aria-label="Attach">
              <PaperclipIcon />
            </Button>
            <ComposerGap />
            <Button size="sm" variant="outline">
              <QueueIcon /> Queue for next turn
            </Button>
          </ComposerTools>
        </ComposerShell>
      </Case>

      <Case label="full — the meter appears only when it is news">
        <ComposerShell>
          <ComposerText defaultValue="One more thing before we compact —" />
          <ComposerTools>
            <Button variant="ghost" size="icon-sm" aria-label="Attach">
              <PaperclipIcon />
            </Button>
            <span className="flex items-center gap-1.5 text-xs text-(--hd-warning-ink)">
              <UsageIcon aria-hidden className="size-3.5" />
              Context 92% used
            </span>
            <Progress value={92} tone="warning" size="sm" label={false} className="w-20" />
            <ComposerGap />
            <Button size="sm">
              <SendIcon /> Send
            </Button>
          </ComposerTools>
        </ComposerShell>
      </Case>
    </div>
  )
}
