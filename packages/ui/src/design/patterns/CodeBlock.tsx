import type { ReactNode } from 'react'

import { CopyButton } from './CopyButton'
import styles from './CodeBlock.module.css'

export type CodeBlockProps = {
  command?: string
  output?: string
  exitCode?: number | null
  copyLabel?: string
  /** A failed copy, for the caller to announce. */
  onCopyError?: () => void
  className?: string
  children?: ReactNode
}

/** Exact command text and its output, drawn as one readable plate. */
export const CodeBlock = ({
  command,
  output,
  exitCode,
  copyLabel = 'Copy this command',
  onCopyError,
  className,
  children,
}: CodeBlockProps) => {
  const hasBody = output !== undefined || children !== undefined

  return (
    <div data-slot="code-block" className={`${styles.plate} ${className ?? ''}`}>
      {command !== undefined && (
        <div data-slot="code-block-command" className={styles.command}>
          <span data-slot="code-block-prompt" className={styles.prompt} aria-hidden="true">$</span>
          <code className={styles.commandText}>{command}</code>
          <CopyButton text={command} label={copyLabel} onError={onCopyError} className={styles.copy} />
        </div>
      )}
      {hasBody && (
        <pre data-slot="code-block-body" className={styles.body}>
          {output}
          {children}
        </pre>
      )}
      {exitCode !== null && exitCode !== undefined && exitCode !== 0 && (
        <div data-slot="code-block-exit" className={styles.exit}>Exit code {exitCode}</div>
      )}
    </div>
  )
}
