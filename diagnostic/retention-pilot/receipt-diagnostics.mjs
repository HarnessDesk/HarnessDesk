const fields = ['epoch', 'generation', 'revision', 'sequence']

// Comparisons only: never return identities, watermarks, session data or errors.
export const compareReceipt = (snapshot, receipt) => ({
  identityMatches: typeof receipt?.identity === 'string' && receipt.identity === snapshot?.identity,
  ...Object.fromEntries(fields.map(field => [`${field}Matches`, receipt?.[field] !== undefined && receipt[field] === snapshot?.watermark?.[field]])),
})
export const compareSnapshot = (before, after) => ({
  present: !!after,
  identityMatches: !!after && after.identity === before?.identity,
  ...Object.fromEntries(fields.map(field => [`${field}Matches`, !!after && after.watermark?.[field] !== undefined && after.watermark[field] === before?.watermark?.[field]])),
})
