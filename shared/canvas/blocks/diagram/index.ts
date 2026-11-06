import type { AnyAsset } from "../contract";
import { ASSETS as structure } from "./structure";
import { ASSETS as flow } from "./flow";
import { ASSETS as process } from "./process";
import { ASSETS as board } from "./board";
import { ASSETS as concept } from "./concept";
import { ASSETS as system } from "./system";

/** The diagram assets (one file per group of related blocks; this list is the category's index). */
export const ASSETS: readonly AnyAsset[] = [...structure, ...flow, ...process, ...board, ...concept, ...system];
