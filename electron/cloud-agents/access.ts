import type { CloudAgentPackageRequest, CloudAgentPublishRequest } from "../../shared/types";
import { pathFromGrant } from "../fs/access";

/** Convert an opaque native-picker capability into the main-owned package root. */
export function resolveCloudAgentPackageRequest(
  input: CloudAgentPublishRequest,
): CloudAgentPackageRequest {
  if (!input || typeof input !== "object") throw new Error("Cloud agent package request is required");
  const { rootGrant, ...options } = input;
  return {
    ...options,
    rootPath: pathFromGrant(rootGrant, "directory"),
  };
}
