# Generated App Engine

Generated Apps are local web apps registered in Agentlas Desktop. Agents emit an
Agentlas Surface Manifest, App Factory scaffolds a normal web app package, and
the Apps surface keeps the app in the list with a `launchUrl` such as
`http://localhost:3000`.

The default owner for this flow is the background built-in Agentlas App Builder
(`agentlas-app-builder`). Apps Generate routes to it only when the request has enough
repeatable workflow, state, editing, automation, or explicit app-building intent. Domain
agents can inspire the product shape, but Desktop no longer embeds arbitrary
user-app UI inside the Agentlas renderer.

## Flow

1. The chat runtime asks the agent for a `service-app` or `creative-studio`
   surface manifest with `app.routes`, `app.tools`, `data`, `widgets`, and
   `actions`.
2. App Factory writes a local app package under `agentlas-apps/<appId>/` and
   persists an `agent_apps` registry record.
3. The Apps launcher keeps `/apps/generated?id=<appId>` as the management page:
   app name, root path, setup/smoke files, dev command, launch URL, and operation
   history.
4. The user-facing app opens through the generated `launchUrl` in the default
   browser/local web runtime. Desktop does not render generated user-app UI in
   the Electron/Next renderer.
5. The terminal path can run the same app package with the generated dev command,
   for example `PORT=3000 node scripts/serve.mjs`.

## Cloud Manifest Lane

Apps can also be installed or updated from Agentlas Cloud without rebuilding
Desktop when they target a runtime engine already shipped in Desktop.

- Desktop owns the registry, launcher, trust metadata, and operations ledger.
- Cloud owns App catalog records: `slug`, `version`, `runtimeEngine`,
  `minDesktopVersion`, permissions, trust metadata, and the Agentlas Surface
  Manifest.
- MongoDB is the marketplace/catalog source of truth for those records, not the
  storage layer for executable app code.
- Desktop stores cloud Apps in the same `agent_apps` registry using a virtual
  root path: `agentlas-cloud://apps/<slug>`.
- Updating catalog copy, route metadata, default launch URLs, and trust metadata
  is a cloud/MongoDB deploy only.
- Adding a new native permission or new Desktop registry capability still
  requires a Desktop release. User-app UI changes should ship in the generated
  web app package, not as embedded Desktop renderers.

## Contract

- Generated Apps must carry `runtimeMode: "external-local-webapp"` plus a
  `launchUrl`, `devCommand`, root path, setup path, and smoke path.
- `/apps` and `/apps/generated` remain management/list surfaces, not user-app
  runners.
- Tool parameter schemas, routes, widgets, and actions are scaffold inputs for
  the generated web app package.
- Generated app execution should work from terminal and browser without relying
  on Agentlas Desktop-specific React components.

Generated App copy must avoid third-party product names as taglines, comparisons,
or "X-style" shorthand. Real connector names are allowed only where a user is
connecting that provider or granting provider-specific permissions.
