/** Portable entry. Process ownership and transports belong to separate entries. */
export type { LeadCancellation, LeadDeskPort, LeadMessagesPort, LeadPersistencePort, LeadPorts } from './ports.js'
export { decideLeadPermission, compareLeadPolicyAuthority, proposeLeadPolicyChange, applyLeadPolicyDecision } from './permissions.js'
export type { LeadPermissionEffect, LeadPermissionDecision, LeadPermissionRequest, LeadPermissionContext,
  LeadAuthorityChange, LeadPolicyProposal, LeadPolicyChange } from './permissions.js'
