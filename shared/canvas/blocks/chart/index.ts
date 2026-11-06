import type { AnyAsset } from "../contract";
import { ASSETS as line } from "./line";
import { ASSETS as schedule } from "./schedule";
import { ASSETS as markets } from "./markets";
import { ASSETS as compare } from "./compare";
import { ASSETS as parts } from "./parts";
import { ASSETS as stats } from "./stats";
import { ASSETS as specials } from "./specials";
import { ASSETS as bars } from "./bars";
import { ASSETS as areas } from "./areas";

/** The chart assets (one file per group of related blocks; this list is the category's index). */
export const ASSETS: readonly AnyAsset[] = [...line, ...bars, ...parts, ...stats, ...specials, ...areas, ...compare, ...markets, ...schedule];
