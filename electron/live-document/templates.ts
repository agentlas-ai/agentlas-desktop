import { strToU8, zipSync, type Zippable } from "fflate";
import type { LiveDocumentFormat } from "../../shared/live-document";

/*
 * Blank documents for document.create: written as code (no binary assets), the smallest packages each format's
 * readers accept, with A4 paper, a body style and heading styles 1-3 so the AI can build a document by ops alone.
 * HWP 5 binary is not created (no writer for a fresh compound file); a Hangul document is created as HWPX, the
 * format Hancom Office uses natively.
 */

export const CREATABLE_FORMATS = ["docx", "xlsx", "pptx", "hwpx"] as const;
export type CreatableFormat = (typeof CREATABLE_FORMATS)[number];

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const esc = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function pack(files: Array<[string, string, number?]>): Uint8Array {
  const zippable: Zippable = {};
  for (const [name, text, level] of files) zippable[name] = [strToU8(text), { level: (level ?? 6) as 0 | 6 }];
  return zipSync(zippable);
}

const RELS_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

function coreProps(title: string): string {
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  return `${XML}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>Agentlas</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
}

// ── docx ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function docx(title: string): Uint8Array {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const heading = (level: number, size: number) => `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:uiPriority w:val="9"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${level === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr><w:rPr><w:b/><w:bCs/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
  return pack([
    ["[Content_Types].xml", `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`],
    ["_rels/.rels", `${XML}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`],
    ["docProps/core.xml", coreProps(title)],
    ["word/_rels/document.xml.rels", `${XML}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/styles" Target="styles.xml"/></Relationships>`],
    ["word/styles.xml", `${XML}<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Malgun Gothic" w:eastAsia="맑은 고딕" w:hAnsi="Malgun Gothic" w:cs="Malgun Gothic"/><w:sz w:val="21"/><w:szCs w:val="21"/><w:lang w:val="en-US" w:eastAsia="ko-KR"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${heading(1, 32)}${heading(2, 26)}${heading(3, 23)}<w:style w:type="table" w:default="1" w:styleId="TableNormal"><w:name w:val="Normal Table"/><w:tblPr><w:tblInd w:w="0" w:type="dxa"/><w:tblCellMar><w:top w:w="0" w:type="dxa"/><w:left w:w="108" w:type="dxa"/><w:bottom w:w="0" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`],
    ["word/document.xml", `${XML}<w:document ${W}><w:body><w:p/><w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="851" w:footer="992" w:gutter="0"/><w:cols w:space="425"/><w:docGrid w:linePitch="360"/></w:sectPr></w:body></w:document>`],
  ]);
}

// ── xlsx ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function xlsx(title: string): Uint8Array {
  const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  return pack([
    ["[Content_Types].xml", `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`],
    ["_rels/.rels", `${XML}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`],
    ["docProps/core.xml", coreProps(title)],
    ["xl/workbook.xml", `${XML}<workbook ${S} xmlns:r="${OFFICE_REL}"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`],
    ["xl/_rels/workbook.xml.rels", `${XML}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${OFFICE_REL}/styles" Target="styles.xml"/></Relationships>`],
    ["xl/worksheets/sheet1.xml", `${XML}<worksheet ${S} xmlns:r="${OFFICE_REL}"><sheetFormatPr defaultRowHeight="16.5"/><sheetData/></worksheet>`],
    ["xl/styles.xml", `${XML}<styleSheet ${S}><fonts count="1"><font><sz val="11"/><color theme="1"/><name val="맑은 고딕"/><family val="2"/><charset val="129"/><scheme val="minor"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`],
  ]);
}

// ── pptx ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const P_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const xfrm = (x: number, y: number, w: number, h: number) => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;
const GRP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';
function placeholder(id: number, name: string, ph: string, box: string, body = '<a:p><a:endParaRPr lang="ko-KR"/></a:p>'): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${box}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>`;
}
const THEME = `${XML}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Agentlas"><a:themeElements><a:clrScheme name="Agentlas"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2A44"/></a:dk2><a:lt2><a:srgbClr val="EEF1F6"/></a:lt2><a:accent1><a:srgbClr val="2F5597"/></a:accent1><a:accent2><a:srgbClr val="D24726"/></a:accent2><a:accent3><a:srgbClr val="70AD47"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="7F7F7F"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Agentlas"><a:majorFont><a:latin typeface="Malgun Gothic"/><a:ea typeface="맑은 고딕"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Malgun Gothic"/><a:ea typeface="맑은 고딕"/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Agentlas"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;

function pptx(title: string): Uint8Array {
  const W = 12192000, H = 6858000;
  const titleBox = xfrm(838200, 365125, 10515600, 1325563), bodyBox = xfrm(838200, 1825625, 10515600, 4351338);
  const ctrBox = xfrm(1524000, 1122363, 9144000, 2387600), subBox = xfrm(1524000, 3602038, 9144000, 1655762);
  const level = (n: number, size: number) => `<a:lvl${n}pPr marL="${228600 + (n - 1) * 457200}" indent="-228600"><a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="${size}"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl${n}pPr>`;
  const layout = (type: string, name: string, shapes: string) => `${XML}<p:sldLayout ${P_NS} type="${type}" preserve="1"><p:cSld name="${name}"><p:spTree>${GRP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  const layoutRels = `${XML}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`;
  const ct = (part: string, type: string) => `<Override PartName="/ppt/${part}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.${type}+xml"/>`;
  return pack([
    ["[Content_Types].xml", `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${ct("presentation.xml", "presentation.main")}${ct("slideMasters/slideMaster1.xml", "slideMaster")}${ct("slideLayouts/slideLayout1.xml", "slideLayout")}${ct("slideLayouts/slideLayout2.xml", "slideLayout")}${ct("slides/slide1.xml", "slide")}${ct("presProps.xml", "presProps")}${ct("viewProps.xml", "viewProps")}<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/ppt/tableStyles.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`],
    ["_rels/.rels", `${XML}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`],
    ["docProps/core.xml", coreProps(title)],
    ["ppt/presentation.xml", `${XML}<p:presentation ${P_NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`],
    ["ppt/_rels/presentation.xml.rels", `${XML}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="${OFFICE_REL}/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="${OFFICE_REL}/presProps" Target="presProps.xml"/><Relationship Id="rId4" Type="${OFFICE_REL}/viewProps" Target="viewProps.xml"/><Relationship Id="rId5" Type="${OFFICE_REL}/theme" Target="theme/theme1.xml"/><Relationship Id="rId6" Type="${OFFICE_REL}/tableStyles" Target="tableStyles.xml"/></Relationships>`],
    ["ppt/presProps.xml", `${XML}<p:presentationPr ${P_NS}/>`],
    ["ppt/viewProps.xml", `${XML}<p:viewPr ${P_NS}><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`],
    ["ppt/tableStyles.xml", `${XML}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`],
    ["ppt/theme/theme1.xml", THEME],
    ["ppt/slideMasters/slideMaster1.xml", `${XML}<p:sldMaster ${P_NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GRP}${placeholder(2, "Title Placeholder 1", '<p:ph type="title"/>', titleBox)}${placeholder(3, "Text Placeholder 2", '<p:ph type="body" idx="1"/>', bodyBox)}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4000" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle>${level(1, 2400)}${level(2, 2000)}${level(3, 1800)}</p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill></a:defRPr></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`],
    ["ppt/slideMasters/_rels/slideMaster1.xml.rels", `${XML}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="${OFFICE_REL}/slideLayout" Target="../slideLayouts/slideLayout2.xml"/><Relationship Id="rId3" Type="${OFFICE_REL}/theme" Target="../theme/theme1.xml"/></Relationships>`],
    ["ppt/slideLayouts/slideLayout1.xml", layout("title", "Title Slide", `${placeholder(2, "Title 1", '<p:ph type="ctrTitle"/>', ctrBox, '<a:p><a:pPr algn="ctr"/><a:endParaRPr lang="ko-KR"/></a:p>')}${placeholder(3, "Subtitle 2", '<p:ph type="subTitle" idx="1"/>', subBox, '<a:p><a:pPr marL="0" indent="0" algn="ctr"><a:buNone/></a:pPr><a:endParaRPr lang="ko-KR"/></a:p>')}`)],
    ["ppt/slideLayouts/_rels/slideLayout1.xml.rels", layoutRels],
    ["ppt/slideLayouts/slideLayout2.xml", layout("obj", "Title and Content", `${placeholder(2, "Title 1", '<p:ph type="title"/>', titleBox)}${placeholder(3, "Content Placeholder 2", '<p:ph idx="1"/>', bodyBox)}`)],
    ["ppt/slideLayouts/_rels/slideLayout2.xml.rels", layoutRels],
    ["ppt/slides/slide1.xml", `${XML}<p:sld ${P_NS}><p:cSld><p:spTree>${GRP}${placeholder(2, "Title 1", '<p:ph type="ctrTitle"/>', ctrBox, `<a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="ko-KR" sz="4400" b="1"/><a:t>${esc(title)}</a:t></a:r></a:p>`)}${placeholder(3, "Subtitle 2", '<p:ph type="subTitle" idx="1"/>', subBox, '<a:p><a:pPr marL="0" indent="0" algn="ctr"><a:buNone/></a:pPr><a:endParaRPr lang="ko-KR" sz="2000"/></a:p>')}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`],
    ["ppt/slides/_rels/slide1.xml.rels", `${XML}<Relationships xmlns="${RELS_NS}"><Relationship Id="rId1" Type="${OFFICE_REL}/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`],
  ]);
}

// ── hwpx ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const HWPX_NS = 'xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf/" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"';
const LANGS = ["HANGUL", "LATIN", "HANJA", "JAPANESE", "OTHER", "SYMBOL", "USER"];
const ALL = (value: string | number) => LANGS.map((lang) => `${lang.toLowerCase()}="${value}"`).join(" ");

function charPr(id: number, height: number, bold: boolean, font: number): string {
  return `<hh:charPr id="${id}" height="${height}" textColor="#000000" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2"><hh:fontRef ${ALL(font)}/><hh:ratio ${ALL(100)}/><hh:spacing ${ALL(0)}/><hh:relSz ${ALL(100)}/><hh:offset ${ALL(0)}/>${bold ? "<hh:bold/>" : ""}<hh:underline type="NONE" shape="SOLID" color="#000000"/><hh:strikeout shape="NONE" color="#000000"/><hh:outline type="NONE"/><hh:shadow type="NONE" color="#B2B2B2" offsetX="10" offsetY="10"/></hh:charPr>`;
}

function paraPr(id: number, align: string, prev: number, next: number): string {
  const margin = `<hh:margin><hc:intent value="0" unit="HWPUNIT"/><hc:left value="0" unit="HWPUNIT"/><hc:right value="0" unit="HWPUNIT"/><hc:prev value="${prev}" unit="HWPUNIT"/><hc:next value="${next}" unit="HWPUNIT"/></hh:margin><hh:lineSpacing type="PERCENT" value="160" unit="HWPUNIT"/>`;
  return `<hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0"><hh:align horizontal="${align}" vertical="BASELINE"/><hh:heading type="NONE" idRef="0" level="0"/><hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/><hh:autoSpacing eAsianEng="0" eAsianNum="0"/><hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">${margin}</hp:case><hp:default>${margin}</hp:default></hp:switch><hh:border borderFillIDRef="2" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/></hh:paraPr>`;
}

function borderFill(id: number, border: "NONE" | "SOLID"): string {
  const side = (name: string) => `<hh:${name} type="${border}" width="0.12 mm" color="#000000"/>`;
  return `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/>${side("leftBorder")}${side("rightBorder")}${side("topBorder")}${side("bottomBorder")}<hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/><hc:fillBrush><hc:winBrush faceColor="none" hatchColor="#999999" alpha="0"/></hc:fillBrush></hh:borderFill>`;
}

function hwpx(title: string): Uint8Array {
  const fonts = LANGS.map((lang) => `<hh:fontface lang="${lang}" fontCnt="2"><hh:font id="0" face="함초롬바탕" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/></hh:font><hh:font id="1" face="함초롬돋움" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/></hh:font></hh:fontface>`).join("");
  const numberingHeads = Array.from({ length: 7 }, (_, i) => `<hh:paraHead start="1" level="${i + 1}" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0">^${i + 1}.</hh:paraHead>`).join("");
  const style = (id: number, name: string, eng: string, para: number, char: number) => `<hh:style id="${id}" type="PARA" name="${name}" engName="${eng}" paraPrIDRef="${para}" charPrIDRef="${char}" nextStyleIDRef="0" langID="1042" lockForm="0"/>`;
  const header = `${XML}<hh:head ${HWPX_NS} version="1.4" secCnt="1"><hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/><hh:refList>`
    + `<hh:fontfaces itemCnt="7">${fonts}</hh:fontfaces>`
    + `<hh:borderFills itemCnt="3">${borderFill(1, "NONE")}${borderFill(2, "NONE")}${borderFill(3, "SOLID")}</hh:borderFills>`
    + `<hh:charProperties itemCnt="4">${charPr(0, 1000, false, 0)}${charPr(1, 1600, true, 1)}${charPr(2, 1300, true, 1)}${charPr(3, 1100, true, 1)}</hh:charProperties>`
    + `<hh:tabProperties itemCnt="1"><hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/></hh:tabProperties>`
    + `<hh:numberings itemCnt="1"><hh:numbering id="1" start="0">${numberingHeads}</hh:numbering></hh:numberings>`
    + `<hh:paraProperties itemCnt="2">${paraPr(0, "JUSTIFY", 0, 0)}${paraPr(1, "LEFT", 1200, 600)}</hh:paraProperties>`
    + `<hh:styles itemCnt="4">${style(0, "바탕글", "Normal", 0, 0)}${style(1, "개요 1", "Outline 1", 1, 1)}${style(2, "개요 2", "Outline 2", 1, 2)}${style(3, "개요 3", "Outline 3", 1, 3)}</hh:styles>`
    + `</hh:refList><hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument><hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption><hh:trackchageConfig flags="56"/></hh:head>`;
  const note = (tag: string, place: string) => `<hp:${tag}><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="${place}" beneathText="0"/></hp:${tag}>`;
  const pageBorder = (type: string) => `<hp:pageBorderFill type="${type}" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill>`;
  const secPr = `<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/><hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/><hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/><hp:pagePr landscape="WIDELY" width="59528" height="84188" gutterType="LEFT_ONLY"><hp:margin header="4252" footer="4252" gutter="0" left="8504" right="8504" top="5668" bottom="4252"/></hp:pagePr>${note("footNotePr", "EACH_COLUMN")}${note("endNotePr", "END_OF_DOCUMENT")}${pageBorder("BOTH")}${pageBorder("EVEN")}${pageBorder("ODD")}</hp:secPr>`;
  const section = `${XML}<hs:sec ${HWPX_NS}><hp:p id="0" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0">${secPr}<hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl><hp:t/></hp:run></hp:p></hs:sec>`;
  return pack([
    ["mimetype", "application/hwp+zip", 0],
    ["version.xml", `${XML}<hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="0" micro="5" buildNumber="0" os="1" xmlVersion="1.4" application="Agentlas" appVersion="1.0"/>`],
    ["META-INF/container.xml", `${XML}<ocf:container xmlns:ocf="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"><ocf:rootfiles><ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/></ocf:rootfiles></ocf:container>`],
    ["META-INF/manifest.xml", `${XML}<odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>`],
    ["Contents/content.hpf", `${XML}<opf:package ${HWPX_NS} version="" unique-identifier="" id=""><opf:metadata><opf:title>${esc(title)}</opf:title><opf:language>ko</opf:language><opf:meta name="creator" content="text">Agentlas</opf:meta></opf:metadata><opf:manifest><opf:item id="header" href="Contents/header.xml" media-type="application/xml"/><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/><opf:item id="settings" href="settings.xml" media-type="application/xml"/></opf:manifest><opf:spine><opf:itemref idref="header" linear="no"/><opf:itemref idref="section0" linear="yes"/></opf:spine></opf:package>`],
    ["Contents/header.xml", header],
    ["Contents/section0.xml", section],
    ["settings.xml", `${XML}<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>`],
  ]);
}

export function blankDocument(format: CreatableFormat, title: string): Uint8Array {
  if (format === "docx") return docx(title);
  if (format === "xlsx") return xlsx(title);
  if (format === "pptx") return pptx(title);
  return hwpx(title);
}
