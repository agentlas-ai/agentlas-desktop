---
name: prove
description: Prove router injection and invoke one installed workflow.
---

# Steps

1. Refresh the installed plugin router cache and ask the host for the explicit plugin prompt block.
2. Confirm the router body is present for the installed mention.
3. Invoke the simplest workflow with a concrete proof input and retain its runtime summary.

# Outputs

- A proof receipt that distinguishes proven from installed-but-unproven.

# Verification

- Router injection is true.
- The workflow run is completed with a non-empty summary; missing tools or runtimes remain an explicit unproven result.
