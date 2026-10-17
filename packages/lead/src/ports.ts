import type { Client } from '@harnessdesk/client'

/** The loop receives cancellation; it never owns a process or a transport. */
export interface LeadCancellation {
  readonly aborted: boolean
  onCancel(listener: () => void): () => void
}

/** Provider request/response shapes stay local to the Messages implementation. */
export interface LeadMessagesPort<Request, Response> {
  request(request: Request, cancellation: LeadCancellation): Promise<Response>
}

/** All desk operations go through the public client door, including events/gaps. */
export type LeadDeskPort = Pick<Client, 'call' | 'events' | 'synced' | 'snapshot'>

/** Append resolves only after durability; rejection must prevent dispatch. */
export interface LeadPersistencePort<Record> {
  read(): Promise<readonly Record[]>
  append(record: Record): Promise<void>
}

export interface LeadPorts<Request, Response, Record> {
  readonly messages: LeadMessagesPort<Request, Response>
  readonly desk: LeadDeskPort
  readonly persistence: LeadPersistencePort<Record>
  readonly cancellation: LeadCancellation
}
