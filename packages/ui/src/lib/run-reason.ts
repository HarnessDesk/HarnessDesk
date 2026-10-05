/** Engine routing names do not help someone answer the wait. Keep the recorded reason intact. */
export const runReasonWords = (reason: string): string => reason.replace(/^Rule [^:\n]+:\s*/, '')
