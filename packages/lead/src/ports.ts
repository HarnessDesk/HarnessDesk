import type { Client } from '@harnessdesk/client'

/** The loop receives cancellation; it never owns a process or a transport. */
export interface LeadCancellation {
  readonly aborted: boolean
  /** If already aborted, invoke synchronously before returning. Otherwise invoke at most
   * once on cancellation. The idempotent detach function prevents any future invocation. */
  onCancel(listener: () => void): () => void
}

/** Provider request/response shapes stay local to the Messages implementation. */
export interface LeadMessagesPort<Request, Response> {
  request(request: Request, cancellation: LeadCancellation): Promise<Response>
}

/** All desk operations go through the public client door, including events/gaps. */
export type LeadDeskPort = Pick<Client, 'call' | 'events' | 'synced' | 'snapshot'>

/** Append resolves only after durability; rejection must prevent dispatch. */
export interface LeadPersistencePort<JournalEntry> {
  read(): Promise<readonly JournalEntry[]>
  append(record: JournalEntry): Promise<void>
}

export interface LeadPorts<Request, Response, JournalEntry> {
  readonly messages: LeadMessagesPort<Request, Response>
  readonly desk: LeadDeskPort
  readonly persistence: LeadPersistencePort<JournalEntry>
  readonly cancellation: LeadCancellation
}
