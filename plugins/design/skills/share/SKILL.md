---
name: share
description: "Builds and deploys a validated prototype to a hosting service, generating a live shareable URL for stakeholders and team members."
---

# Skill Purpose
Packages and publishes a locally validated prototype to an external hosting target (e.g., Vercel, Netlify, or static bundle hosting), delivering a direct shareable URL.

# Preconditions
- The prototype must have passed local validation and `$design-qa`.
- The user must explicitly request deployment or a public sharing link.

# Steps
1. **Confirm Target**: Determine the target platform or hosting mechanism requested by the user.
2. **Execute Production Build**: Run `npm run build` or equivalent to ensure error-free asset compilation.
3. **Deploy Bundle**: Publish the compiled assets using deployment CLI tools or API integration to obtain a live URL.
4. **Deliver URL**: Provide the generated URL to the user with a brief instruction on viewing the live deployment.

# Outputs
- Live public prototype URL.
- Production build bundle.

# Verification
- Confirm that the deployed URL is reachable and renders correctly in a web browser.
- Verify that no deployment errors or missing asset 404s occur in the live environment.
