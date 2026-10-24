import { linuxProvider } from "./linux";
import { macosProvider } from "./macos";
import type { PlatformProvider } from "./provider";
import { windowsProvider } from "./windows";

export const REACH_PROVIDERS: readonly PlatformProvider[] = [macosProvider, windowsProvider, linuxProvider];
