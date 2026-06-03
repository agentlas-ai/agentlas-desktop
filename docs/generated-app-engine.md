# Generated App Engine

Generated Apps are not standalone localhost web apps. Agents emit an Agentlas
Surface Manifest, and Agentlas renders that manifest as an internal app at
`/apps/generated?id=<appId>`.

The default owner for this flow is the background built-in Agentlas App Builder
(`agentlas-app-builder`). Apps Generate routes to it only when the request has enough
repeatable workflow, state, editing, automation, or explicit app-building intent. Domain
agents can inspire the product shape without becoming one-off external web prototypes.

## Flow

1. The chat runtime asks the agent for a `service-app` or `creative-studio`
   surface manifest with `app.routes`, `app.tools`, `data`, `widgets`, and
   `actions`.
2. App Factory persists the manifest as an `agent_apps` record.
3. The Apps launcher opens the record inside Agentlas through
   `/apps/generated?id=<appId>`.
4. The renderer builds a dedicated app blueprint from the manifest:
   app-specific inputs, counseling/recommendations, a workbench result, and
   export formats.
5. The user works inside Agentlas. No external Chrome window, localhost preview,
   or generated arbitrary code execution is required for the default experience.

## Contract

- Visual or creative apps get image-oriented outputs and PNG/JPG export.
- Internal tools and service apps get structured workbench outputs and
  JSON/Markdown/CSV export.
- Tool parameter schemas become input controls.
- Routes and widgets become workflow counseling choices.
- Actions and datasets remain visible as runtime affordances, not top-level app
  navigation.

Specialized renderers may exist later, but the default path must always be the
manifest-driven internal app runner. A generated app should never depend on a
Cardnews-specific exception to become usable.

Generated App copy must avoid third-party product names as taglines, comparisons,
or "X-style" shorthand. Real connector names are allowed only where a user is
connecting that provider or granting provider-specific permissions.
