import type { AnyAsset } from "../contract";
import { ASSETS as files } from "./files";
import { ASSETS as media } from "./media";
import { ASSETS as tech } from "./tech";
import { ASSETS as objects } from "./objects";
import { ASSETS as grid } from "./grid";

/** The thumbnail assets (one file per group of related blocks; this list is the category's index). */
export const ASSETS: readonly AnyAsset[] = [...files, ...media, ...tech, ...objects, ...grid];
