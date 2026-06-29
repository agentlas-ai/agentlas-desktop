# Package Quality Audit

## Current Verdict

`repair-needed` before public or paid distribution.

The package has the correct folder architecture and verification script, but the first version was too shallow in three ways:

1. HQ `agent.md` files were short and did not encode enough source-grounded operating behavior.
2. Research links existed, but source-to-HQ traceability was not explicit.
3. Verification checked file presence more than prompt quality.

## Required Repairs Applied

- Strengthened root orchestrator prompt with research backbone, quality bar, and explicit failure cases.
- Strengthened Idea Foundry HQ with YC, Customer Development, BMC, VPC, JTBD, gates, and interview prompts.
- Strengthened Market Intelligence HQ with source priority, TAM/SAM/SOM, competitor/substitute/status-quo split, and persona-swarm labeling.
- Strengthened Business Plan HQ with SBA structure, financial discipline, and Word-ready failure conditions.
- Strengthened Product Development HQ with build-route matrix, architecture gates, credential policy, and visual QA rules.
- Added Pitch Deck / IR HQ from the paid Forge `defect-driven-slide-studio` package.
- Added deck-specific evidence, editability, and defect-QA gates.
- Added source-to-HQ traceability matrix.
- Added stricter verification checks for source traceability and minimum prompt depth.

## Remaining Manual Review

Before re-publishing to GitHub:

- Run a sample founder request through the orchestrator.
- Inspect whether each HQ produces useful artifacts, not only prose.
- Inspect one generated deck preview and PPTX export before external use.
- Decide whether to add a small CLI/demo runner.
- Decide whether Startup should include a web UI or remain agent-package only.
