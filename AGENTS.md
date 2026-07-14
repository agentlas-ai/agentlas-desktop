# Agentlas Desktop Repository Instructions

## Repository Constitution: Local Main Only

This repository uses one canonical development line: the local `main` branch in
`/Users/mason/Documents/Agentlas_F/agentlas_desktop`.

- Make every source change and commit directly on local `main`.
- Do not create feature, release, backup, agent-named, or temporary branches.
- Do not create Git worktrees. Use an external recovery directory or a verified
  Git bundle when a safety snapshot is required.
- Before editing, confirm that the canonical checkout is on `main`, inspect
  `git status`, fetch remote refs, and inspect `main...origin/main`. Never treat
  a GUI "Pull origin" button as permission to pull or merge blindly.
- If local `main` is dirty, preserve it with a reviewed checkpoint commit before
  reconciling remote changes on the same branch.
- Push only `main` (and intentional release tags). Do not publish side branches.
- Do not move Agentlas Terminal code into this repository. The independent
  Terminal checkout is outside the Desktop cleanup boundary unless the user
  explicitly includes it.

Run `scripts/install-main-only-git-guard.sh` after cloning. The tracked Git
hooks reject non-`main` local branch updates and non-`main` branch pushes.

## Verification

For substantive changes, run the smallest relevant focused tests first, then
`npm run typecheck` and the relevant contract/build gates before claiming the
Desktop is ready. Verify the actual Electron surface when UI or runtime behavior
changed.
