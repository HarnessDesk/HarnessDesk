import { useState } from 'react'

import { CheckIcon, CopyIcon, copyIconMarkup } from '../../components/Icons'
import { Button } from '../ui/button'

export const copyButtonIconMarkup = copyIconMarkup

/**
 * The one copy control: an icon that becomes a tick for a moment once the
 * text is on the clipboard.
 *
 * A message's footer, an answer's actions and a code plate each drew their
 * own, and one of them swallowed a failed write while the other two said so.
 * A failure is the caller's to announce — the app does it with a notice, and
 * this layer has no store — so it is handed back rather than dropped. A row
 * that stays shown while the tick is up hears about it through
 * `onCopiedChange`.
 */
export const CopyButton = ({
  text,
  label,
  onError,
  onCopiedChange,
  className,
}: {
  text: string
  /** The accessible name: what is copied, not just "Copy". */
  label: string
  onError?: () => void
  onCopiedChange?: (copied: boolean) => void
  className?: string
}) => {
  const [copied, setCopied] = useState(false)
  const show = (next: boolean) => {
    setCopied(next)
    onCopiedChange?.(next)
  }
  return (
    <Button
      variant="quiet"
      size="icon-xs"
      title="Copy"
      aria-label={label}
      className={className}
      onClick={() =>
        void navigator.clipboard
          .writeText(text)
          .then(() => {
            show(true)
            window.setTimeout(() => show(false), 1500)
          })
          .catch(() => onError?.())
      }
    >
      {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
    </Button>
  )
}
