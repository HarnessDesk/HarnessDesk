/** Strip only a routing id from this Run, keeping user-written reasons whole. */
export const runReasonWords = (reason: string, rules: readonly { readonly id: string }[] = []): string => {
  const rule = rules.filter(one => reason.startsWith(`Rule ${one.id}: `)).sort((a, b) => b.id.length - a.id.length)[0]
  return rule ? reason.slice(`Rule ${rule.id}: `.length) : reason
}
