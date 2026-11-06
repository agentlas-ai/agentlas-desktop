import type { AnyAsset } from "../contract";
import { ASSETS as datas } from "./data";
import { ASSETS as lower } from "./lower";
import { ASSETS as numbers } from "./numbers";
import { ASSETS as scenes } from "./scene";
import { ASSETS as socials } from "./social";
import { ASSETS as types } from "./type";

/** The motion assets (one file per group of related blocks; this list is the category's index). */
export const ASSETS: readonly AnyAsset[] = [...datas, ...lower, ...numbers, ...scenes, ...socials, ...types];
