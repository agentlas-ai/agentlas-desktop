/** Authenticated owner repository reads; the server enforces workspace ownership. */
export interface OwnerCloudFilesInput {
  manifestId: string;
  path?: string;
  packageHash?: string;
}

/** Keep reads bound to the paired account, including a switch during I/O. */
export async function readCloudFilesForDevice(input: OwnerCloudFilesInput, deviceId: string, dependencies: {
  accountGuard?: (deviceId: string) => "ok" | "mismatch" | "signed-out" | "unknown";
  read?: (input: OwnerCloudFilesInput) => Promise<Record<string, unknown>>;
}): Promise<Record<string, unknown>> {
  const accountMatches = (): boolean => {
    try { return dependencies.accountGuard?.(deviceId) === "ok"; }
    catch { return false; }
  };
  if (!accountMatches()) return { ok: false, code: "account_mismatch" };
  if (!dependencies.read) return { ok: false, code: "cloud_files_unavailable" };
  const result = await dependencies.read(input);
  if (!accountMatches()) return { ok: false, code: "account_mismatch" };
  return result;
}

export async function readOwnerCloudFiles(input: OwnerCloudFilesInput, dependencies: {
  session(): string | null;
  get(cookie: string, endpoint: string): Promise<Response>;
}): Promise<Record<string, unknown>> {
  const cookie = dependencies.session();
  if (!cookie) return { ok: false, code: "sign_in_required" };
  if (!input.manifestId || input.manifestId.length > 256 || /[\x00-\x1f]/.test(input.manifestId)) {
    return { ok: false, code: "invalid_manifest" };
  }
  const query = new URLSearchParams();
  if (input.path !== undefined) {
    if (!input.path || input.path.length > 1024 || !/^[a-f0-9]{64}$/i.test(input.packageHash ?? "")) {
      return { ok: false, code: "invalid_file_request" };
    }
    query.set("path", input.path);
    query.set("packageHash", input.packageHash!);
  }
  try {
    const response = await dependencies.get(cookie,
      `/api/agent-cloud/manifests/${encodeURIComponent(input.manifestId)}/files${query.size ? `?${query}` : ""}`);
    // Never send a previous account's pending response to a newly signed-in phone.
    if (dependencies.session() !== cookie) return { ok: false, code: "account_changed" };
    if (!response.ok) return { ok: false, code: response.status === 401 ? "sign_in_required" : `cloud_files_${response.status}` };
    const raw: unknown = await response.json();
    if (dependencies.session() !== cookie) return { ok: false, code: "account_changed" };
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, code: "invalid_cloud_files" };
    const data = raw as Record<string, unknown>;
    if (input.path !== undefined) {
      if (data.path !== input.path || typeof data.content !== "string" || Buffer.byteLength(data.content) > 512 * 1024) {
        return { ok: false, code: "invalid_cloud_file" };
      }
      return { ok: true, manifestId: input.manifestId, path: data.path, packageHash: input.packageHash, content: data.content };
    }
    if (data.sourceAllowed !== true || typeof data.packageHash !== "string" || !/^[a-f0-9]{64}$/i.test(data.packageHash) || !Array.isArray(data.files)) {
      return { ok: false, code: "invalid_cloud_files" };
    }
    const files = data.files.map((entry: unknown) => {
      const file = entry as Record<string, unknown> | null;
      if (!file || typeof file.path !== "string" || !file.path || file.path.length > 1024 ||
          typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes < 0) return null;
      return { path: file.path, bytes: file.bytes };
    });
    if (files.some((file) => file === null)) return { ok: false, code: "invalid_cloud_files" };
    return { ok: true, manifestId: input.manifestId, packageHash: data.packageHash, sourceAllowed: true, files };
  } catch {
    return { ok: false, code: "cloud_files_unavailable" };
  }
}
