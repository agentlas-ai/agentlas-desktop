import type { AnyAsset } from "../contract";
import { ASSETS as title } from "./title";
import { ASSETS as structure } from "./structure";
import { ASSETS as content } from "./content";
import { ASSETS as data } from "./data";
import { ASSETS as flow } from "./flow";

/** The slide assets (one file per group of related blocks; this list is the category's index). */
export const ASSETS: readonly AnyAsset[] = [...title, ...structure, ...content, ...data, ...flow];
