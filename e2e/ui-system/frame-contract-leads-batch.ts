import { test, type Page } from '@playwright/test'
import { checkLead } from './frame-contract-leads-rules'
import { LEAD_STATES, readLead, readLeadReference, type LeadState } from './frame-contract-leads-snapshot'
import { runSnapshotBatch } from './frame-snapshot-batch'
import type { WallDestination } from './frame-wall-destinations'

/**
 * B10 for a batch of non-work destinations in one window state, captured once
 * and checked many times (`frame-snapshot-batch.ts`): the work conversation's
 * place origin is read once for the batch, then each destination once.
 */
export const checkNonworkLeads = async (page: Page, destinations: readonly WallDestination[], state: LeadState) => {
  const referenceX = await readLeadReference(page, state)
  const measured: NonNullable<ReturnType<typeof checkLead>>[] = []
  await runSnapshotBatch(page, destinations, LEAD_STATES[state].width, destination => readLead(page, destination, state), reading => {
    const place = checkLead(reading, referenceX, state)
    if (place) measured.push(place)
  })
  if (state !== 'standing') await test.info().attach('nonwork-place-measurements', { body: JSON.stringify(measured, null, 2), contentType: 'application/json' })
}

export const leadBatchIds = (destinations: readonly WallDestination[]) => destinations.map(destination => destination.id).join(', ')
