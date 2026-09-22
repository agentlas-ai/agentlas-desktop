import type { LocalModelHubSnapshot } from "../../shared/local-model-hub";
import type { Runner } from "../runtime/runner";
import type { LocalModelHubManager } from "./manager";

/** Structural GUI/control surface. No child handles, bearer headers, executor
 * callbacks or process-wide shutdown authority cross this port. A remote
 * adapter converts AbortSignal to its own operation-id cancellation message. */
export type LocalModelHubControlPort = Pick<LocalModelHubManager,
  "snapshot" | "searchModels" | "inspectRepository" | "addModel"
  | "downloadEngine" | "downloadModel" | "importModel" | "installEngine"
  | "installDownloadedModel" | "loadModel" | "unload" | "testCapabilities">;

export interface LocalModelHubSnapshotPort {
  snapshot(): Promise<LocalModelHubSnapshot>;
}

/** Detection and invocation share one local owner or one remote facade. */
export interface LocalModelHubRuntimePort extends LocalModelHubSnapshotPort {
  run: Runner;
}

/** In-process only: never implement by publishing the engine bearer token. */
export type LocalModelHubOwnerPort = Pick<LocalModelHubManager,
  "snapshot" | "endpoint" | "authorizationHeaders" | "residentInstallation" | "executeWithReceipt">;
