# Worktree listing previews

These frames use the actual worktree manager, conversation composer and bring-home dialog in the preview harness, rendered headlessly in both themes. Listings come from a throwaway Git submodule whose module name is `widgets-module` and whose working folder is `widgets`, with a managed `harnessdesk/parser` worktree.

Before uses the PR base `c23ea8cbc87135b2f52ee2a5c8f7c65d6f224ffa`; after uses the code revision recorded in [listing-evidence.json](listing-evidence.json). Temporary paths are mapped to synthetic `/work/super` and `/state/worktrees` paths before rendering. No real desk or account is used.

The manager shows the corrected folder and the current and managed markers. The bring-home dialog now names the working folder. The composer menu keeps its labels and layout; the runner checks that selecting Main checkout uses the corresponding listing path.

To reproduce from the repository root, install the repository dependencies and browser binary, run `pnpm build:node`, then run `node docs/images/worktree-listing/capture.mjs`. Use the team's machine-wide gate for browser runs where one is configured. The runner owns its temporary fixtures under `/tmp/review-1373`, requires its own preview server on port 6574 and closes that server when it finishes.

The manager-refusal frames compare the round 1 code with the round 2 repair after a real Git configuration points the submodule at an unrelated repository. Before shows that unrelated folder as the main checkout; after shows the host refusal. This case uses the same headless preview harness and both themes. The evidence records source hashes as well as the code commit for the captured listings.
