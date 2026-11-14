const allowed = new Set(["base_mismatch", "body_changed", "cache_not_closed", "descriptor_identity", "durable_body_mismatch", "generation_conflict", "held_partial_history", "identity_mismatch", "invalid_identity", "missing_base", "missing_durable_descriptor", "missing_record", "missing_retained_turns", "owner_record_changed", "owner_revision_changed", "owner_session_changed", "pending_overlay", "persist_exact_refused", "quiet_approvals", "quiet_cache_not_closed", "quiet_detached", "quiet_dispatching", "quiet_draining", "quiet_live", "quiet_queue", "quiet_queue_busy", "quiet_reattaching", "quiet_reopen_waiter", "quiet_running", "quiet_tasks", "quiet_transcript_operation", "recovered_base", "sequence_changed", "session_partial_history", "transcript_incomplete", "verified_base_identity", "verified_base_kind", "verified_base_missing", "exact_invalid_body", "exact_body_difference", "exact_pending", "exact_writing", "exact_failed_write", "exact_removed", "exact_unreadable_body", "exact_fact_title", "exact_fact_preview", "exact_fact_cwd", "exact_fact_createdat", "exact_fact_updatedat", "exact_fact_usage", "exact_insight", "exact_observe_error", "exact_base_mismatch", "exact_write_refused", "exact_pending_after_write", "exact_writing_after_write", "exact_prepared_missing", "exact_row_verification", "exact_write_protected", "exact_write_stale", "write_entry", "write_read", "write_source", "write_identity", "write_database", "write_after_database"])
// Keep only fixed, validated reason counters; no raw output is written or returned.
export const makeGuardMetrics = () => {
  const counts = Object.fromEntries([...allowed].map(label => [label, 0]))
  let pending = '', acceptedBytes = 0, truncated = false
  const add = chunk => {
    pending += String(chunk)
    let end
    while ((end = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, end).replace(/\r$/, '')
      pending = pending.slice(end + 1)
      const match = /^HD1545_RECEIPT \{"reason":"([a-z_]+)"\}$/.exec(line)
      if (!match || !allowed.has(match[1])) continue
      if (acceptedBytes + line.length > 65536) { truncated = true; continue }
      acceptedBytes += line.length
      counts[match[1]]++
    }
    if (pending.length > 1024) { pending = ''; truncated = true }
  }
  return { add, summary: () => ({ counts: Object.fromEntries(Object.entries(counts).filter(([, count]) => count)), truncated }) }
}
