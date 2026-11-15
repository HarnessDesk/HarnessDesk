const CODES = new Map([
  ['prepared only; no run authorized','not_authorized'], ['final source pin missing','pin_invalid'],
  ['hosted macOS runner required','environment_refused'], ['source base mismatch','source_mismatch'],
  ['production source or checkout changed','source_mismatch'], ['source fingerprint mismatch','source_mismatch'],
  ['fixture fingerprint mismatch','source_mismatch'], ['ambient profile location exists','ambient_refused'],
  ['privacy audit failed','privacy_refused'], ['frame changed or privacy audit failed','privacy_refused'],
  ['invalid frame','frame_invalid'], ['invalid frame dimensions','frame_invalid'], ['frame unavailable','frame_unavailable'],
  ['ledger mismatch','ledger_invalid'], ['ledger identity mismatch','ledger_invalid'], ['ledger state mismatch','ledger_invalid'],
  ['unexpected pre-review effect','effect_observed'], ['unexpected review effect','effect_observed'],
  ['unexpected restart effect','effect_observed'], ['transport unavailable','transport_unavailable'],
])
export async function runGuarded(result, body, cleanup) {
  let passed=false
  try { await body(); passed=true }
  catch (error) {
    result.failurePhase=result.phase
    const message=typeof error?.message==='string'?error.message:''
    result.reason=CODES.get(message)??(message.endsWith(': readiness deadline')?'readiness_timeout':'other')
    result.phase='failed'
  }
  try { await cleanup() } catch { result.cleanupError=true;passed=false }
  result.passed=passed
  return passed
}
