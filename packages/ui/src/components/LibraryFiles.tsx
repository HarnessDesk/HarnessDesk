import { useState } from 'react'
import type { LibraryPlannedOp } from '@harnessdesk/protocol'
import { ActionError, Button, Chip, CodeBlock, CodeText, FormStack, Note, Row, Rows, SectionHead, Text, Toolbar } from '../design'
import { useStore } from '../state/context'

type PlannedFile = NonNullable<LibraryPlannedOp['files']>[number]
export const needsLibraryAcknowledgement = (op: LibraryPlannedOp): boolean => op.origin !== undefined && (op.files ?? []).some(file => file.change !== 'removed' && (file.runnable || file.binary))

const FileRow = ({ file, sourcePath }: { file: PlannedFile; sourcePath?: string | undefined }) => {
  const store = useStore()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [answer, setAnswer] = useState<{ text: string | null; truncated: boolean } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const read = async () => {
    if (open) { setOpen(false); return }
    if (!sourcePath) return
    setOpen(true); setBusy(true); setAnswer(null); setFailed(null)
    try { setAnswer(await store.transport.request('library/source/file', { sourcePath, path: file.path })) }
    catch (error) { setFailed(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }
  return <div>
    <Row title={<Toolbar><CodeText as="code">{file.path}</CodeText>{file.runnable && <Chip tone="warning" size="sm">Can run</Chip>}{file.binary && <Chip tone="warning" size="sm">Binary</Chip>}</Toolbar>}
      desc={file.runnable ? file.reason : undefined}
      control={<Toolbar><Text role="meta">{file.change ? `${file.change[0]!.toUpperCase()}${file.change.slice(1)} · ` : ''}{file.bytes < 1024 ? `${file.bytes} B` : `${(file.bytes / 1024).toFixed(1)} KB`}</Text>{sourcePath && file.change !== 'removed' && (file.runnable || file.binary) && <Button variant="secondary" size="sm" onClick={() => void read()}>{open ? 'Hide' : 'Read'}</Button>}</Toolbar>} />
    {open && <FormStack>
      {busy && <Note>Reading…</Note>}
      {failed !== null && <ActionError>{failed}</ActionError>}
      {answer && <>{answer.text === null ? <Note>This file is binary and is not shown.</Note> : <CodeBlock output={answer.text} />}{answer.truncated && <Note>Showing the first 256 KB.</Note>}</>}
    </FormStack>}
  </div>
}

/** The file vocabulary is shared with the later update review. */
export const LibraryFiles = ({ op }: { op: LibraryPlannedOp }) => {
  if (!op.files) return null
  const runnable = op.files.filter(f => f.runnable).length, binary = op.files.filter(f => f.binary).length
  return <FormStack>
    <SectionHead level="label" name={`${op.files.length} files · ${runnable} can run${binary ? ` · ${binary} binary` : ''}`} />
    <Rows>{op.files.map(file => <FileRow key={file.path} file={file} sourcePath={op.origin ? op.sourcePath : undefined} />)}</Rows>
  </FormStack>
}
