const stages = new Set(['open-visible','pending','quiescence','eligibility','recovery','workload-metadata','representative-selection','receipt-retained','receipt-released','restore-immediate','automatic-release','post-restore-stability','heap','target','listeners'])
const fields = ['metadata','loaded','released','recovery','pressureRunning','pressureDirty','enabled','visibleMounted','visibleLoaded','draftPresent','draftLoaded','pendingPresent','pendingLoaded','pendingActive','pendingMounted','pendingCloseSent','knownLoaded','knownMissing','selectedLoaded','selectedPresent','stateUnavailable','eligibilityKnown','receiptPresent','identityMatches','epochMatches','generationMatches','revisionMatches','sequenceMatches','restoreOk','restoreLoaded','restoreVisibleMounted','restoreVisibleLoaded','sampledEligibilityKnown','sampledRecovery','capturedMissing','retainedFound','releasedFound']
export const stageRecord = (stage, state) => {
 if(!stages.has(stage))throw Error('invalid diagnostic stage')
 const clean={}
 for(const key of fields){const value=state?.[key];if(typeof value==='boolean'||(typeof value==='number'&&Number.isFinite(value)))clean[key]=value}
 return {stage,state:clean}
}
