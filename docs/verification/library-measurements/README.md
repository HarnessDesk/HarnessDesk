# Library measurements

This directory holds versioned, fixture-only observations of installed agent
builds. A measurement is made only by the isolated manual harness described in
[`script/measure/README.md`](../../../script/measure/README.md). The harness is
not run in CI, and a build that cannot be safely isolated or queried is recorded
as `could-not-ask` rather than assigned inferred capabilities.

No live agent measurements have been recorded yet. The tier table and links to
the exact result files will be added after the measurement questions are
implemented and run.
