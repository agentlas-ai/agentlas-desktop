/** The Science management handoff reads registrations before any health check. */
export async function readMcpManagementInventory<T, S>(ports: {
  listInstalled(): Promise<T[]>;
  status(): Promise<S[]>;
}, probeStatus: boolean): Promise<[T[], S[] | null]> {
  if (!probeStatus) return [await ports.listInstalled(), null];
  return Promise.all([ports.listInstalled(), ports.status()]);
}
