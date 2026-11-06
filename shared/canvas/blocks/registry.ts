import { installAssets } from "./core";
import { ASSETS as chart } from "./chart";
import { ASSETS as diagram } from "./diagram";
import { ASSETS as document } from "./document";
import { ASSETS as motion } from "./motion";
import { ASSETS as slide } from "./slide";
import { ASSETS as table } from "./table";
import { ASSETS as thumbnail } from "./thumbnail";

/**
 * Loads every asset category and installs it into the registry (core.ts). Importing this file is what makes asset blocks known: the host
 * (card builder, catalog, phone projection) imports it, the gallery and the gates import it, and the renderer imports it on demand when a card
 * holds an asset block. The names the rest of the code uses (assetByType, assetHtml, ...) are core's, re-exported here.
 */
installAssets({ document, thumbnail, chart, table, diagram, motion, slide });
export * from "./core";
