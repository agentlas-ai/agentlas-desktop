# Desktop updater recovery contract

The updater uses two startup gates. Before `initStore()` can migrate the live
database, the install journal and its recovery paths must validate, the SQLite
copy must pass `quick_check`, and the managed-agent and route copies must match
their recorded hashes. After migration, but before built-in seeding,
materialization, automations, Telegram workers, dreaming, triggers, or the
browser approval server start, Agentlas compares the live state with that
recovery set.

## Preserved and verified

- A hot SQLite backup made by SQLite's backup API, not a raw copy of a live WAL
  database.
- Every pre-update row and protected value in the user-value tables declared by
  `CONTINUITY_CORE_TABLES`, including chats/messages, memory, automations,
  evolution history and versions, agent apps/tools/surfaces, MCP bindings, and
  runtime overrides. Known migration deletions require an explicit migration
  receipt.
- Every pre-update regular file and symbolic-link target under
  `userData/agents`, with a SHA-256 inventory and a contained recovery copy.
  New files may be added by a newer version, but old assets may not disappear or
  change silently.
- `agent-routes.json`, by content hash and contained recovery copy.
- The same `userData` and database paths, non-regressing schema, and restoration
  of a still-valid signed-in account session.

## Deliberate boundaries

- OS Keychain values and the encrypted account-cookie file are not duplicated
  into the recovery directory. Their presence and successful account restore
  are checked instead.
- Local-import source folders outside `userData/agents` are user-owned external
  paths. The updater preserves and hashes the route record but does not copy the
  external folder.
- The updater does not claim automatic binary rollback after macOS has replaced
  the app bundle. Before replacement it fails closed and keeps the old app. If a
  post-replacement continuity check fails, all background writers stay stopped
  and the renderer or native startup fallback exposes the recovery copy.
- A legacy cache is discarded only at process startup, before any new update
  check/download and when no durable install journal owns it. Removal is
  verified; an undeletable `ShipItState.plist`, `update.*`, pending directory, or
  update ZIP pauses automatic updates instead of starting another loop.

