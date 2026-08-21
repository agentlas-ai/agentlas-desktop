---
name: seed-design
description: "Comprehensive guide for SEED Design. Retrieves component specs and foundations from official documentation, guides platform-specific implementations (React/Lynx), and runs Doctor diagnostics."
---

# Skill Purpose
Serves as the single source of truth for the SEED Design system, routing to official documentation for component specifications, platform setup, migrations, and health diagnostics (Doctor).

# Preconditions
- A SEED Design-related question, component implementation request, foundation inquiry, or codebase diagnostic is requested.
- References `$doctor`, `$doctor-react`, `$doctor-lynx`, `$migration`, and `$upgrade`.

# Steps
1. **Classify Request**:
   - Common component specifications and Foundations (platform-agnostic).
   - Platform implementation for React or Lynx.
   - Doctor diagnostics and codebase migration.
2. **Determine Platform**: Check user input → `seed-design.json` configuration → direct package dependencies (`@seed-design/*`).
3. **Route to Official Docs**:
   - Query `https://seed-design.io/llms.txt` and platform indices to read authoritative leaf documentation.
4. **Execute Doctor (if requested)**:
   - Perform read-only inspection according to `$doctor` to diagnose package compatibility, snippet hygiene, and token contracts.
   - Output structured findings with remediation prompts.

# Outputs
- Authoritative design system specifications and implementation guidance.
- Diagnostic YAML/HTML reports in temporary directories when running Doctor.

# Verification
- Ensure all technical guidance aligns with the official live documentation index.
- Verify that diagnostic operations operate in read-only mode without mutating the target repository unexpectedly.
