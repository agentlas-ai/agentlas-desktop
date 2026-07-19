import type {
  AgentlasSurfaceManifest,
  JsonObject,
  JsonValue,
} from "../../shared/types";
import {
  SURFACE_CLOSE_FENCE,
  SURFACE_OPEN_FENCE,
  parseSurfaces,
} from "../surface-emitter";

const MAX_SOURCE_COUNT = 12;
const MAX_TABLE_ROWS = 40;
const MAX_TABLE_COLUMNS = 10;
const MAX_CELL_LENGTH = 1_000;

function cleanText(value: string, maximum = MAX_CELL_LENGTH): string {
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maximum);
}

function parseCells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of trimmed) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === "|") {
      cells.push(cleanText(current));
      current = "";
    } else {
      current += character;
    }
  }
  cells.push(cleanText(current));
  return cells.slice(0, MAX_TABLE_COLUMNS);
}

function separatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
}

function recommendationProductName(value: string): string {
  const text = cleanText(value.replace(/\*\*/g, ""), 300)
    .replace(/^(?:추천|recommended?)[ \t:：-]+/i, "")
    .trim();
  const koreanChoice = text.match(
    /(?:^(?:(?:셋|세|후보|제품(?:들)?)\s*중(?:에서)?(?:는)?\s+)?)(.+?)(?:을|를)\s*(?:고르시면|선택하시면|추천(?:합니다|해요|드립니다))/i,
  );
  if (koreanChoice?.[1]) return cleanText(koreanChoice[1], 160);
  const englishChoice = text.match(/^(?:choose|pick|recommend(?:ing)?)\s+(.+?)(?:\s+(?:because|for|as)\b|$)/i);
  if (englishChoice?.[1]) return cleanText(englishChoice[1], 160);
  return cleanText(text.replace(/\s+추천\s*$/i, ""), 300);
}

function firstMarkdownTable(markdown: string): { columns: string[]; rows: JsonObject[] } | null {
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index < lines.length - 2; index += 1) {
    if (!lines[index].includes("|") || !lines[index + 1].includes("|")) continue;
    const header = parseCells(lines[index]);
    const separator = parseCells(lines[index + 1]);
    if (header.length < 2 || separator.length !== header.length || !separatorRow(separator)) continue;
    const columns = header.map((cell, columnIndex) => cell || `Column ${columnIndex + 1}`);
    const rows: JsonObject[] = [];
    for (let cursor = index + 2; cursor < lines.length && rows.length < MAX_TABLE_ROWS; cursor += 1) {
      if (!lines[cursor].includes("|")) break;
      const cells = parseCells(lines[cursor]);
      if (cells.length !== columns.length) break;
      const row: JsonObject = {};
      columns.forEach((column, columnIndex) => {
        row[column] = (cells[columnIndex] || "—") as JsonValue;
      });
      rows.push(row);
    }
    if (rows.length >= 2) return { columns, rows };
  }
  return null;
}

function explicitRecommendation(markdown: string): { product: string; detail: string } | null {
  const match = markdown.match(
    /^#{1,3}[ \t]+(?:(?:최종[ \t]+)?추천|결론)[ \t]*:[ \t]*([^\r\n]+?)(?:[ \t]+[—-][ \t]+([^\r\n]+))?[ \t]*$/mi,
  );
  if (!match) return null;
  const product = recommendationProductName(match[1]);
  return product ? { product, detail: cleanText(match[2] || "", MAX_CELL_LENGTH) } : null;
}

function productIdentityTokens(value: string): string[] {
  return [...value.toUpperCase().matchAll(/\b(?=[A-Z0-9-]{4,}\b)(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g)]
    .map((match) => match[0].replace(/-/g, ""));
}

function normalizedProductName(value: string): string {
  return value
    .replace(/\*\*/g, "")
    .replace(/(?:약|최저(?:가)?)[ \t]*\d[\d,.]*(?:[ \t]*만)?[ \t]*원.*$/i, "")
    .replace(/\b(?=[A-Z0-9-]{4,}\b)(?=[A-Z0-9-]*\d)[A-Z0-9]+(?:-[A-Z0-9]+)*\b/gi, "")
    .replace(/[^A-Za-z0-9가-힣]+/g, "")
    .toLocaleLowerCase();
}

function tableContainsProduct(table: { columns: string[]; rows: JsonObject[] }, productColumn: string, product: string): boolean {
  const expectedTokens = productIdentityTokens(product);
  const expectedName = normalizedProductName(product);
  return table.rows.some((row) => {
    const value = String(row[productColumn] ?? "");
    const candidateTokens = productIdentityTokens(value);
    if (expectedTokens.length > 0 && candidateTokens.some((token) => expectedTokens.includes(token))) return true;
    const candidateName = normalizedProductName(value);
    return Boolean(expectedName && candidateName && candidateName === expectedName);
  });
}

function productRowLooksLikeFact(value: JsonValue | undefined): boolean {
  const text = cleanText(String(value ?? "").replace(/\*\*/g, ""), 300);
  return /^(?:표준)?사용면적|^(?:에너지)?효율|^소비전력|^(?:필터|인증|가격|커버리지|스펙)(?:[ \t(:：]|$)/i.test(text)
    || /(?:대안|제품).{0,24}(?:없음|없습니다|없다)$/.test(text);
}

function addMissingRecommendationToTable(
  markdown: string,
  table: { columns: string[]; rows: JsonObject[] } | null,
): { columns: string[]; rows: JsonObject[] } | null {
  if (!table) return null;
  const recommendation = explicitRecommendation(markdown);
  if (!recommendation) return table;
  const productColumn = table.columns.find((column) => /^(?:제품|상품|모델|product|item|model)$/i.test(cleanText(column, 80)));
  if (!productColumn) return table;
  const cleanedTable = {
    columns: table.columns,
    rows: table.rows.filter((row) => !productRowLooksLikeFact(row[productColumn])),
  };
  if (tableContainsProduct(cleanedTable, productColumn, recommendation.product)) return cleanedTable;
  if (
    recommendation.product.length > 100
    || /(?:고르시면|선택하시면|추천(?:합니다|해요|드립니다)|(?:입|됩|없|있)니다)(?:[.!?]|$)/i.test(recommendation.product)
  ) return cleanedTable;

  const ko = /[가-힣]/.test(markdown);
  const price = `${recommendation.product} ${recommendation.detail}`.match(/(?:약[ \t]*)?\d[\d,.]*(?:[ \t]*만)?[ \t]*원/i)?.[0] ?? "—";
  const area = markdown.match(/(?:표준)?사용면적[^\d\r\n]{0,24}(\d[\d,.]*[ \t]*㎡(?:[ \t]*\([^\r\n)]{1,30}평\))?)/i)?.[1] ?? "—";
  const row: JsonObject = {};
  for (const column of table.columns) {
    const label = cleanText(column, 80);
    if (column === productColumn) row[column] = recommendation.product;
    else if (/^(?:선택|choice)$/i.test(label)) row[column] = ko ? "추천" : "Recommended";
    else if (/(?:가격|최저가|price|cost)/i.test(label)) row[column] = price;
    else if (/(?:사용면적|면적|coverage|area)/i.test(label)) row[column] = area;
    else if (/(?:비고|이유|설명|reason|notes?|why)/i.test(label)) row[column] = recommendation.detail || (ko ? "조건에 가장 잘 맞는 추천" : "Best match for the request");
    else row[column] = "—";
  }
  return { columns: table.columns, rows: [row, ...cleanedTable.rows].slice(0, MAX_TABLE_ROWS) };
}

function recommendationComparison(markdown: string): { columns: string[]; rows: JsonObject[] } | null {
  const rankedParagraphs = [...markdown.matchAll(
    /^\*\*((?:(?:공동[ \t]+)?1순위(?:\([^)*\r\n]{1,40}\))?|추천|대안(?:[ \t]+[A-Z0-9가-힣]+)?)[^*\r\n]{2,300}?):\*\*[ \t]*([^\r\n]+)$/gmi,
  )].slice(0, MAX_TABLE_ROWS);
  if (rankedParagraphs.length >= 2) {
    return {
      columns: ["선택", "제품", "핵심 내용"],
      rows: rankedParagraphs.map((candidate, index) => {
        const label = cleanText(candidate[1], 300);
        const selection = label.match(/^(?:(?:공동[ \t]+)?1순위(?:\([^)*\r\n]{1,40}\))?|추천|대안(?:[ \t]+[A-Z0-9가-힣]+)?)/i)?.[0]
          ?? (index === 0 ? "추천" : `대안 ${index}`);
        return {
          선택: cleanText(selection, 80),
          제품: cleanText(label.slice(selection.length).replace(/^[ \t]*[—:-][ \t]*/, ""), 300),
          "핵심 내용": cleanText(candidate[2], MAX_CELL_LENGTH),
        };
      }),
    };
  }

  const rankedProductSections = [...markdown.matchAll(
    /^\*\*((\d+위(?:\([^)*\r\n]{1,60}\))?|추천|대안(?:[ \t]+[A-Z0-9가-힣]+)?)\s*[—:-]\s*([^*\r\n]{3,300}))\*\*[ \t]*\r?\n([^\r\n]+)/gmi,
  )].slice(0, MAX_TABLE_ROWS);
  if (rankedProductSections.length >= 2) {
    return {
      columns: ["선택", "제품", "핵심 내용"],
      rows: rankedProductSections.map((candidate) => ({
        선택: cleanText(candidate[2], 80),
        제품: cleanText(candidate[3], 300),
        "핵심 내용": cleanText(candidate[4], MAX_CELL_LENGTH),
      })),
    };
  }

  const recommendation = markdown.match(
    /^#{1,3}[ \t]+(?:(?:최종[ \t]+)?추천|결론)[ \t]*:[ \t]*([^\r\n]+?)(?:[ \t]+[—-][ \t]+([^\r\n]+))?[ \t]*$/mi,
  );
  const alternativeHeading = /^(?:#{2,4}[ \t]+대안(?:[ \t]*\([^)*\r\n]{1,80}\))?[ \t]*|\*\*대안(?:[ \t]*\([^)*\r\n]{1,80}\))?[ \t]*\*\*)$/mi.exec(markdown);
  let alternativeSection = "";
  if (alternativeHeading?.index !== undefined) {
    const afterHeading = markdown.slice(alternativeHeading.index + alternativeHeading[0].length);
    const nextHeading = afterHeading.search(/^#{1,4}[ \t]+/m);
    alternativeSection = nextHeading >= 0 ? afterHeading.slice(0, nextHeading) : afterHeading;
  }
  const alternativeBullets = [...alternativeSection.matchAll(/^\s*-\s+\*\*(.+?)\*\*\s*(?::|[—-])\s*(.+)$/gm)]
    .slice(0, MAX_TABLE_ROWS - 1);
  if (recommendation && alternativeBullets.length >= 1) {
    const recommendationName = cleanText(recommendation[1].replace(/\s+추천\s*$/i, ""), 300);
    return {
      columns: ["선택", "제품", "핵심 내용"],
      rows: [
        {
          선택: "추천",
          제품: recommendationName,
          "핵심 내용": cleanText(recommendation[2] || "조건에 가장 잘 맞는 선택", MAX_CELL_LENGTH),
        },
        ...alternativeBullets.map((candidate, index) => ({
          선택: `대안 ${index + 1}`,
          제품: cleanText(candidate[1].replace(/^차선\s*:\s*/i, ""), 300),
          "핵심 내용": cleanText(candidate[2], MAX_CELL_LENGTH),
        })),
      ],
    };
  }

  const candidateBullets = [...markdown.matchAll(/^\s*-\s+\*\*(.+?)\*\*\s*(?::|[—-])\s*(.+)$/gm)]
    .slice(0, MAX_TABLE_ROWS);
  const productCandidateBullets = candidateBullets.filter((candidate) =>
    !/^(?:커버리지|가격|스펙|장점|단점|한계|사용면적|소음|크기|무게|성능|근거|적정[ \t]+용량[ \t]+기준|평판)(?:[ \t(:（]|$)/i.test(cleanText(candidate[1], 80)),
  );
  if (productCandidateBullets.length >= 2) {
    return {
      columns: ["선택", "제품", "핵심 내용"],
      rows: productCandidateBullets.map((candidate, index) => ({
        선택: index === 0 ? "추천" : `대안 ${index}`,
        제품: cleanText(candidate[1].replace(/^차선\s*:\s*/i, ""), 300),
        "핵심 내용": cleanText(candidate[2], MAX_CELL_LENGTH),
      })),
    };
  }

  const productFactBullets = markdown
    .split(/\r?\n/)
    .flatMap((line) => {
      const bold = /^\s*-\s+\*\*(.+?)\*\*\s*(?:—|-|:)\s*(.+)$/.exec(line);
      const plain = bold ? null : /^\s*-\s+([^*\r\n][^—\r\n]{2,240}?)\s+—\s+(.+)$/.exec(line);
      const match = bold ?? plain;
      if (!match) return [];
      const product = cleanText(match[1], 300);
      const detail = cleanText(match[2], MAX_CELL_LENGTH);
      if (
        !product
        || /^(?:커버리지|가격|스펙|장점|단점|한계|사용면적|소음|크기|무게|성능|근거|이유|참고)(?:[ \t(:（]|$)/i.test(product)
        || !/(?:\d[\d,.]*\s*(?:원|만원|㎡|평)|[A-Z]{2,}[A-Z0-9-]*\d)/i.test(`${product} ${detail}`)
      ) return [];
      return [{ product, detail }];
    })
    .slice(0, MAX_TABLE_ROWS);
  if (productFactBullets.length >= 2) {
    return {
      columns: ["선택", "제품", "핵심 내용"],
      rows: productFactBullets.map((candidate, index) => ({
        선택: index === 0 ? "추천" : `대안 ${index}`,
        제품: candidate.product,
        "핵심 내용": candidate.detail,
      })),
    };
  }

  const priceListSegment = /(?:현재[ \t]+)?최저가(?:가|는)?[ \t]+([^\.\r\n]{10,500})/i.exec(markdown)?.[1] ?? "";
  const priceCandidates = [...priceListSegment.matchAll(
    /(?:^|[,·/][ \t]*)([A-Za-z가-힣][A-Za-z0-9가-힣˚°+ .-]{0,40}?)[ \t]+(\d[\d,]*(?:\.\d+)?[ \t]*(?:만)?원)/g,
  )].map((match) => ({ product: cleanText(match[1], 160), price: cleanText(match[2], 80) }));
  const proseRecommendation = /\*\*([^*\r\n]{2,160})\*\*(?:을|를)?[ \t]*추천(?:합니다|해요|드립니다)/i.exec(markdown)?.[1];
  if (priceCandidates.length >= 2 && proseRecommendation) {
    const recommended = normalizedProductName(proseRecommendation);
    const ordered = [...priceCandidates].sort((left, right) => {
      const leftMatch = recommended.includes(normalizedProductName(left.product));
      const rightMatch = recommended.includes(normalizedProductName(right.product));
      return Number(rightMatch) - Number(leftMatch);
    });
    return {
      columns: ["선택", "제품", "가격"],
      rows: ordered.map((candidate, index) => ({
        선택: index === 0 && recommended.includes(normalizedProductName(candidate.product)) ? "추천" : `대안 ${index}`,
        제품: candidate.product,
        가격: candidate.price,
      })),
    };
  }

  const alternatives = [...markdown.matchAll(/^\s*(\d+)\.\s+\*\*(.+?)\*\*\s*[—-]\s*(.+)$/gm)]
    .slice(0, MAX_TABLE_ROWS - 1);
  if (recommendation && alternatives.length >= 2) {
    const rows: JsonObject[] = [{
      선택: "추천",
      제품: cleanText(recommendation[1], 300),
      "핵심 내용": cleanText(recommendation[2] || "가장 잘 맞는 선택", MAX_CELL_LENGTH),
    }];
    for (const alternative of alternatives) {
      rows.push({
        선택: `대안 ${cleanText(alternative[1], 20)}`,
        제품: cleanText(alternative[2], 300),
        "핵심 내용": cleanText(alternative[3], MAX_CELL_LENGTH),
      });
    }
    return { columns: ["선택", "제품", "핵심 내용"], rows };
  }

  // Some runtimes write a recommendation paragraph followed by bold inline
  // product specs instead of a formal list. Promote only spans that contain a
  // product-like name plus parenthesized price/area facts.
  if (!recommendation) return null;
  const inlineProducts = [...markdown.matchAll(/\*\*([^*\n]{3,400})\*\*/g)]
    .map((match) => cleanText(match[1], 400))
    .filter((value) =>
      /\([^)]*(?:원|만원|㎡|평)/.test(value)
      && !/^(?:최저가|가격|사용면적|거실|만약|교차)/.test(value))
    .slice(0, MAX_TABLE_ROWS - 1);
  if (inlineProducts.length < 1) return null;
  const recommendationName = cleanText(recommendation[1].replace(/\s+추천\s*$/i, ""), 300);
  const rows: JsonObject[] = [{
    선택: "추천",
    제품: recommendationName,
    "핵심 내용": cleanText(recommendation[2] || "가장 잘 맞는 선택", MAX_CELL_LENGTH),
  }];
  for (const [index, product] of inlineProducts.entries()) {
    if (product.includes(recommendationName) || recommendationName.includes(product)) continue;
    rows.push({ 선택: `대안 ${index + 1}`, 제품: product, "핵심 내용": "본문에서 확인한 대안" });
  }
  if (rows.length < 2) return null;
  return { columns: ["선택", "제품", "핵심 내용"], rows };
}

const GENERIC_RESULT_HEADINGS = new Set([
  "assumptions",
  "comparison",
  "conclusion",
  "evidence",
  "key findings",
  "memory",
  "memory events",
  "recommendation",
  "research notes",
  "results",
  "session memory",
  "sources",
  "summary",
  "work log",
  "전제",
  "결론",
  "근거",
  "메모리",
  "메모리 이벤트",
  "비교",
  "추천",
  "요약",
  "주요 결과",
  "출처",
  "핵심 결론",
  "핵심 요약",
  "확인한 출처",
]);

function normalizedHeading(value: string): string {
  return cleanText(value, 160)
    .replace(/^\d+[.)]\s*/, "")
    .replace(/[：:]$/, "")
    .trim()
    .toLocaleLowerCase();
}

function informativeHeading(markdown: string, fallbackTitle: string): string {
  const headings = [...markdown.matchAll(/^#{1,3}[ \t]+(.+)$/gm)]
    .map((match) => cleanText(match[1], 160))
    .filter(Boolean);
  const heading = headings.find((candidate) => !GENERIC_RESULT_HEADINGS.has(normalizedHeading(candidate)));
  const recommendation = explicitRecommendation(markdown);
  if (
    heading
    && recommendation
    && /(?:고르시면|선택하시면|\b(?:choose|pick)\b)/i.test(heading)
  ) {
    return cleanText(
      /[가-힣]/.test(heading) ? `${recommendation.product} 추천` : `${recommendation.product} recommendation`,
      160,
    );
  }
  return cleanText(heading || fallbackTitle, 160) || "One result";
}

function processPrefaceSentence(value: string): boolean {
  const sentence = cleanText(value, 1_000);
  if (!sentence) return true;
  if (/(?:스크립트).{0,100}(?:오타|수정|고쳤|오류|에러)/i.test(sentence)) return true;
  if (/(?:파일|문서).{0,180}(?:생성(?:되었|됐)습니다|만들고.{0,100}검증했습니다)(?:[.!?]|$)/.test(sentence)) return true;
  return /(?:python[ -]?docx|openpyxl|python[ 	]+라이브러리|라이브러리.{0,80}(?:확인|사용[ 	]+가능|준비)|스크립트.{0,80}(?:작성|실행))/i.test(sentence)
    || /(?:파일|문서).{0,120}(?:만들겠습니다|생성합니다|생성되었습니다|열리는지.{0,40}검증합니다)(?:[.!?]|$)/.test(sentence)
    || /(?:조사|검색|탐색|조회|확인|검증|비교|정리|분석|진행|살펴보|찾아보|시작)(?:하겠습니다|할게요|해보겠습니다|해볼게요)(?:[.!?]|$)/.test(sentence)
    || /^(?:이제|먼저|우선)?[, \t]*.{0,120}(?:조사|검색|탐색|조회|확인|검증|비교|분석)[^.!?]{0,120}(?:실행하겠습니다|진행하겠습니다|하겠습니다|할게요|해보겠습니다|해볼게요|조회합니다)(?:[.!?]|$)/.test(sentence)
    || /^[^.!?]{0,160}(?:병렬|동시에)[^.!?]{0,80}(?:검색|조회|확인|비교)(?:합니다|하겠습니다)(?:[.!?]|$)/.test(sentence)
    || /(?:스킬|도구).{0,60}(?:사용|불러오|열어보)(?:할게요|겠습니다|겠어요)(?:[.!?]|$)/.test(sentence)
    || /^(?:세|여러|각)[ 	]+.{0,120}(?:조회합니다|확인하겠습니다|갖추겠습니다)(?:[.!?]|$)/.test(sentence)
    || /^(?:이전|앞선).{0,100}(?:결과|내용).{0,50}(?:확인|불러).{0,80}(?:비교|정리).*(?:드릴게요|하겠습니다)(?:[.!?]|$)/.test(sentence)
    || /^(?:렌탈|중고|광고).{0,60}(?:잡혔|나왔).{0,80}(?:다시|재)[ 	]*(?:조회|검색)/.test(sentence)
    || /^(?:렌탈|중고|광고).{0,80}(?:잡혔|나왔)(?:네요|습니다)(?:[.!?]|$)/.test(sentence)
    || /^(?:가격|제품|결과|응답|데이터|API|JSON).{0,50}(?:필드|키|속성).{0,100}(?:다른|없|찾|이름|형식)/i.test(sentence)
    || /(?:field|key|property).{0,100}(?:different|missing|not found|named)/i.test(sentence)
    || /^(?:일시불|구매가|가격).{0,100}(?:걸러|추려).{0,60}(?:조회|검색)합니다(?:[.!?]|$)/.test(sentence)
    || /메모리.{0,80}(?:기록|남기)(?:겠습니다|할게요|합니다)/.test(sentence)
    || /^(?:내용|결과|자료).{0,30}(?:읽어|불러오|확인해)[ \t]*(?:볼게요|보겠습니다|드릴게요)(?:[.!?]|$)/.test(sentence)
    || /(?:조사|검색|탐색|조회|확인|검증|비교|분석).{0,100}(?:추천|결과|내용).{0,40}(?:드리겠습니다|알려드리겠습니다)(?:[.!?]|$)/.test(sentence)
    || /^(?:먼저|우선).{0,100}(?:검색|조사|확인)[ 	]*(?:도구|기능).{0,50}(?:불러오|열어보|사용하)(?:겠습니다|겠어요|려 합니다)(?:[.!?]|$)/.test(sentence)
    || /^결과를[ 	]+정리해[ 	]+(?:드립니다|드릴게요)(?:[.!?]|$)/.test(sentence)
    || /^정리해[ 	]+(?:드립니다|드릴게요)(?:[.!?]|$)/.test(sentence)
    || /^(?:먼저|우선)[, ]+.{0,160}(?:조사|검색|탐색|조회|확인|검증|비교|분석|살펴보|찾)(?:한|해|하겠|하고|할게|해볼)/.test(sentence)
    || /(?:조사|검색|탐색|조회|확인|검증|비교|분석)[^.!?]{0,100}(?:끝났습니다|마쳤습니다|완료했습니다)/.test(sentence)
    || /(?:작업[ \t]*폴더|세션[ \t]*메모리|메모리[ \t]*디렉토리|스냅샷|조사[ \t]*기록)[^.!?]{0,140}(?:없|확인|찾|읽|복원|불러)/.test(sentence)
    || /(?:이전[ \t]*조사[ \t]*결과|조사[ \t]*기록)[^.!?]{0,140}(?:확인한[ \t]*뒤|판단해[ \t]*드리겠습니다|불러올게요)/.test(sentence)
    || /^결론부터 .{0,40}(?:정리|말씀).{0,20}(?:드립니다|드릴게요)/.test(sentence)
    || /(?:work[ -]?folder|session[ -]?memory|snapshot|research[ -]?record).{0,140}(?:missing|check|find|read|restore|load)/i.test(sentence)
    || /^(?:i\s+will|i'll|let\s+me|first[, ]+i(?:\s+will|'ll))\b/i.test(sentence);
}

function hasMeaningfulSurfacePayload(surface: AgentlasSurfaceManifest): boolean {
  return Object.values(surface.data).some((dataset) => {
    if (!["markdown", "metrics", "table", "timeline", "routes", "pricing", "media", "artifacts", "launch-checklist"].includes(dataset.type)) {
      return false;
    }
    if (Array.isArray(dataset.rows) && dataset.rows.length > 0) return true;
    if (Array.isArray(dataset.items) && dataset.items.length > 0) return true;
    if (typeof dataset.summary === "string" && cleanText(dataset.summary, 2_000).length >= 24) return true;
    if (typeof dataset.value === "string" && cleanText(dataset.value, 2_000).length >= 24) return true;
    if (Array.isArray(dataset.value) && dataset.value.length > 0) return true;
    if (dataset.value && typeof dataset.value === "object") return true;
    return false;
  });
}

function surfaceContentKinds(surface: AgentlasSurfaceManifest): Set<string> {
  const kinds = new Set<string>();
  for (const dataset of Object.values(surface.data)) {
    if (dataset.type === "markdown" && typeof dataset.value === "string" && cleanText(dataset.value, 2_000).length >= 24) {
      kinds.add("narrative");
    }
    if (dataset.type === "table" && Array.isArray(dataset.rows) && dataset.rows.length > 0) {
      kinds.add("table");
    }
    if (dataset.type === "timeline" && (dataset.items?.length || dataset.rows?.length)) kinds.add("timeline");
    if (dataset.type === "pricing" && (dataset.items?.length || dataset.rows?.length)) kinds.add("budget");
    if (dataset.type === "routes" && (dataset.items?.length || dataset.rows?.length)) kinds.add("map");
    if (dataset.type === "launch-checklist" && (dataset.items?.length || dataset.rows?.length)) kinds.add("checklist");
    if (dataset.type === "artifacts" && (dataset.items?.length || dataset.rows?.length)) kinds.add("artifacts");
    if (dataset.type === "media" && (dataset.items?.length || dataset.rows?.length)) kinds.add("media");
  }
  return kinds;
}

function recommendationMatchesSurfaceTable(surface: AgentlasSurfaceManifest): boolean {
  const titleTokens = productIdentityTokens(surface.title);
  if (titleTokens.length === 0) return true;
  const normalizedTitle = normalizedProductName(surface.title);
  for (const dataset of Object.values(surface.data)) {
    if (dataset.type !== "table" || !Array.isArray(dataset.rows)) continue;
    const columns = dataset.columns?.length ? dataset.columns : Object.keys(dataset.rows[0] ?? {});
    const productColumn = columns.find((column) => /^(?:제품|상품|모델|product|item|model)$/i.test(cleanText(column, 80)));
    if (!productColumn) continue;
    return dataset.rows.some((row) => {
      const value = String(row[productColumn] ?? "");
      const codeMatches = productIdentityTokens(value).some((token) => titleTokens.includes(token));
      const candidateName = normalizedProductName(value);
      return codeMatches || Boolean(candidateName.length >= 6 && normalizedTitle.includes(candidateName));
    });
  }
  return true;
}

/**
 * A model-authored Surface may pass the closed schema while containing only a
 * title and sources. When the same visible answer deterministically produces
 * real narrative or comparison data, prefer that richer closed Surface so One
 * never hides the useful answer behind an empty-looking card.
 */
export function chooseOneSurfaceForDisplay(
  parsed: AgentlasSurfaceManifest | null,
  deterministic: AgentlasSurfaceManifest | null,
): AgentlasSurfaceManifest | null {
  const safeParsed = sanitizeSurfaceNarrative(parsed);
  const safeDeterministic = sanitizeSurfaceNarrative(deterministic);
  if (!safeParsed) return safeDeterministic;
  if (!safeDeterministic) return safeParsed;
  const parsedKinds = surfaceContentKinds(safeParsed);
  const deterministicKinds = surfaceContentKinds(safeDeterministic);
  // Markdown reconstruction cannot prove or recreate a real file, media byte,
  // coordinate set, budget contract, or task checklist. Never trade one of
  // those model-authored semantic blocks for an extra prose block.
  const nonReconstructableKinds = new Set(["artifacts", "media", "timeline", "budget", "map", "checklist"]);
  if ([...parsedKinds].some((kind) => nonReconstructableKinds.has(kind) && !deterministicKinds.has(kind))) {
    return safeParsed;
  }
  if ([...deterministicKinds].some((kind) => !parsedKinds.has(kind))) return safeDeterministic;
  return hasMeaningfulSurfacePayload(safeParsed) && recommendationMatchesSurfaceTable(safeParsed)
    ? safeParsed
    : safeDeterministic;
}

function removeProcessPreface(paragraph: string): string {
  const sentences = paragraph
    .split(/(?<=[.!?。！？])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence && !processPrefaceSentence(sentence));
  return sentences.join(" ").trim();
}

/**
 * A schema-valid model Surface can still contain a tool plan copied from an
 * earlier streaming turn. One results are the deliverable, not an execution
 * log, so strip those future-tense process sentences from markdown datasets
 * before the Surface is selected and persisted for display.
 */
function sanitizeSurfaceNarrative(surface: AgentlasSurfaceManifest | null): AgentlasSurfaceManifest | null {
  if (!surface) return null;
  const removed = new Set<string>();
  let changed = false;
  const data = Object.fromEntries(Object.entries(surface.data).flatMap(([key, dataset]) => {
    if (dataset.type !== "markdown" || typeof dataset.value !== "string") return [[key, dataset]];
    const value = dataset.value
      .split(/\n\s*\n/)
      .map(removeProcessPreface)
      .filter(Boolean)
      .join("\n\n")
      .trim();
    if (!value) {
      changed = true;
      removed.add(key);
      return [];
    }
    if (value === dataset.value) return [[key, dataset]];
    changed = true;
    return [[key, { ...dataset, value }]];
  }));
  if (Object.keys(data).length === 0) return null;
  const widgets = removed.size > 0
    ? surface.widgets.filter((widget) => !widget.data || !removed.has(widget.data))
    : surface.widgets;
  if (widgets.length === 0) return null;
  return changed ? { ...surface, data, widgets } : surface;
}

function summaryMarkdown(markdown: string): string {
  const withoutTable = markdown.replace(/^\|?.+\|.+\r?\n\|?\s*:?-{3,}[^\n]*\r?\n(?:\|?.+\|.*\r?\n?){2,40}/m, "");
  const withoutProcessLines = withoutTable
    .split(/\r?\n/)
    .map(removeProcessPreface)
    .join("\n");
  const paragraphs = withoutProcessLines
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph && !/^#{1,4}[ \t]+/.test(paragraph) && !/^(?:Sources?|출처)[ \t]*:/i.test(paragraph))
    .map(removeProcessPreface)
    .filter(Boolean)
    .slice(0, 4)
    .join("\n\n");
  return paragraphs.slice(0, 6_000);
}

function orderedChecklist(markdown: string): JsonObject[] {
  const heading = /^(?:(?:#{1,4})[ \t]+|\*\*)(?:제안[ \t]+)?(?:실행[ \t]+순서|다음[ \t]+단계|할[ \t]+일|(?:출발[ \t]+전[ \t]+|준비[ \t]+)?체크리스트|action[ \t]+plan|next[ \t]+steps|(?:pre-?trip[ \t]+)?checklist)(?:\*\*)?[ \t]*$/gmi.exec(markdown);
  if (!heading?.index && heading?.index !== 0) return [];
  const afterHeading = markdown.slice(heading.index + heading[0].length);
  const nextHeading = afterHeading.search(/^(?:#{1,4}[ \t]+|\*\*[^*\r\n]{2,120}\*\*[ \t]*$)/m);
  const section = nextHeading >= 0 ? afterHeading.slice(0, nextHeading) : afterHeading;
  const rows = [...section.matchAll(/^\s*(?:\d+[.)]|[-*])\s+(.+)$/gm)]
    .map((match) => cleanText(match[1].replace(/^\[[ xX]\][ \t]*/, ""), 500))
    .filter(Boolean)
    .slice(0, MAX_TABLE_ROWS);
  return rows.length >= 2
    ? rows.map((label) => ({ label, status: "pending" }))
    : [];
}

function inlineTravelChecklist(markdown: string): JsonObject[] {
  const heading = /^(?:(?:#{1,4})[ \t]+|\*\*)[^\r\n*]{0,80}체크리스트[^\r\n*]{0,80}(?:\*\*)?[ \t]*$/mi.exec(markdown);
  if (heading?.index == null) return [];
  const afterHeading = markdown.slice(heading.index + heading[0].length);
  const boundary = afterHeading.search(/^(?:#{1,4}[ \t]+|\*\*[^*\r\n]{2,120}\*\*[ \t]*$|(?:Sources?|출처)[ :])/mi);
  const section = (boundary >= 0 ? afterHeading.slice(0, boundary) : afterHeading)
    .replace(/\*\*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!section) return [];
  const labels: string[] = [];
  const reservations = /예약\s*\d+건\s*\(([^)]+)\)/i.exec(section)?.[1] ?? "";
  for (const item of reservations.split(/\s*,\s*/)) {
    const label = cleanText(item, 500);
    if (!label) continue;
    const [rawSubject, ...detailParts] = label.split(/\s*[—–-]\s*/);
    const subject = rawSubject === "항공" ? "항공권" : rawSubject;
    const detail = detailParts.join(" — ");
    labels.push(detail ? `${subject} 예약: ${detail}` : `${subject} 예약 확인`);
  }
  const packing = /짐\s*준비\s*\(([^)]+)\)/i.exec(section)?.[1] ?? "";
  for (const item of packing.split(/\s*,\s*/)) {
    const label = cleanText(item, 500);
    if (label) labels.push(`${label} 챙기기`);
  }
  const weather = section.match(/출발\s*\d+(?:~|-)?\d*일\s*전[^.!?]{0,160}(?:날씨|태풍|기상)[^.!?]{0,160}확인/i)?.[0]
    ?? section.match(/출발[^.!?]{0,160}(?:날씨|태풍|기상)[^.!?]{0,160}확인/i)?.[0];
  if (weather) labels.push(cleanText(weather, 500));
  return labels.length >= 3
    ? [...new Set(labels)].slice(0, 20).map((label) => ({ label, status: "pending" }))
    : [];
}

function krwAmount(value: unknown): number | null {
  const text = cleanText(String(value ?? ""), 120).replace(/\s+/g, "");
  const match = text.match(/(\d[\d,.]*)(만원|원)/);
  if (!match) return null;
  const numeric = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return Math.round(numeric * (match[2] === "만원" ? 10_000 : 1));
}

function travelBudget(
  table: { columns: string[]; rows: JsonObject[] } | null,
  taskPrompt: string,
): { limit: number; items: JsonObject[] } | null {
  if (!table) return null;
  const itemColumn = table.columns.find((column) => /^(?:항목|내역|구분|category|item)$/i.test(cleanText(column, 80)));
  const amountColumn = table.columns.find((column) => /^(?:금액|비용|예상[ \t]*비용|price|amount|cost)$/i.test(cleanText(column, 80)));
  if (!itemColumn || !amountColumn) return null;
  const evidenceColumn = table.columns.find((column) => /(?:근거|확인|상태|evidence|status|verification)/i.test(cleanText(column, 80)));
  const items = table.rows.flatMap((row) => {
    const amount = krwAmount(row[amountColumn]);
    const label = cleanText(String(row[itemColumn] ?? ""), 300);
    if (amount == null || !label || /^(?:합계|총액|total)$/i.test(label)) return [];
    const evidence = cleanText(String(evidenceColumn ? row[evidenceColumn] ?? "" : ""), 500);
    const verificationStatus = /(?:공식|확인(?:됨)?|verified)/i.test(evidence) && !/(?:미확인|추정|estimated|unverified)/i.test(evidence)
      ? "verified"
      : /(?:추정|예상|estimated)/i.test(evidence)
        ? "estimated"
        : "unverified";
    return [{ label, amount, verificationStatus }];
  });
  if (items.length < 2) return null;
  const requestedLimit = krwAmount(taskPrompt.match(/(?:총[ \t]*)?예산[^\d]{0,12}\d[\d,.]*[ \t]*(?:만원|원)/i)?.[0]);
  const total = items.reduce((sum, item) => sum + Number(item.amount), 0);
  return { limit: requestedLimit ?? total, items };
}

function travelTimeline(markdown: string): JsonObject[] {
  const lines = markdown.split(/\r?\n/);
  const items: JsonObject[] = [];
  let day = "";
  let dayDetail = "";
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const compactDay = line.match(/^[-*][ \t]+\*\*(\d{1,2}일차(?:[ \t]*\([^)]+\))?)\*\*[ \t]*[·—–:-][ \t]*(.+)$/i);
    if (compactDay) {
      items.push({
        title: cleanText(compactDay[1], 160),
        detail: cleanText(compactDay[2].replace(/\*\*/g, ""), 1_500),
        status: "upcoming",
      });
      if (items.length >= MAX_TABLE_ROWS) break;
      continue;
    }
    const dayMatch = line.match(/^(?:#{1,4}[ \t]+)?(?:\*\*)?(\d{1,2}일차)(?:[ \t]*\(([^)]+)\))?(?:[ \t]*[·—–:-][ \t]*([^*\r\n]+))?(?:\*\*)?/i);
    if (dayMatch) {
      day = cleanText([dayMatch[1], dayMatch[2]].filter(Boolean).join(" · "), 120);
      dayDetail = cleanText(dayMatch[3] || "", 300);
      continue;
    }
    if (/^#{1,4}[ \t]+/.test(line)) {
      day = "";
      dayDetail = "";
      continue;
    }
    if (!day) continue;
    const eventMatch = line.match(/^[-*][ \t]+(?:(\d{1,2}:\d{2}(?:경)?)\s+)?(.+)$/);
    if (!eventMatch) continue;
    const detail = cleanText(eventMatch[2].replace(/\*\*/g, ""), 800);
    if (!detail || /^(?:출처|sources?)[ :]/i.test(detail)) continue;
    items.push({
      title: cleanText([day, eventMatch[1], detail].filter(Boolean).join(" · "), 300),
      ...(dayDetail ? { detail: dayDetail } : {}),
      status: "upcoming",
    });
    if (items.length >= MAX_TABLE_ROWS) break;
  }
  return items.length >= 3 ? items : [];
}

function structurallyRichNarrative(markdown: string): boolean {
  const headings = markdown.match(/^#{1,4}[ \t]+[^\r\n]+$/gm)?.length ?? 0;
  const bullets = markdown.match(/^\s*[-*]\s+[^\r\n]{16,}$/gm)?.length ?? 0;
  const clearRecommendation = /(?:\*\*[^*\r\n]{3,180}\*\*|[^\r\n]{3,180})\s*(?:을|를)?\s*(?:고르시면|추천(?:합니다|해요|드립니다))|(?:best choice|recommend(?:ed)?|choose)\b/i.test(markdown);
  const length = cleanText(markdown, 10_000).length;
  return (headings >= 2 && length >= 160)
    || (clearRecommendation && bullets >= 2 && length >= 180);
}

function markdownSources(markdown: string, observedUrls: string[] = []): Array<{ label: string; url: string }> {
  const sources: Array<{ label: string; url: string }> = [];
  const seen = new Set<string>();
  const representedHosts = new Set<string>();
  for (const match of markdown.matchAll(/\[([^\]]{1,200})\]\((https:\/\/[^\s)]+)\)/g)) {
    const label = cleanText(match[1], 200);
    const url = match[2];
    if (!label || seen.has(url)) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:") continue;
      representedHosts.add(parsed.hostname.replace(/^www\./i, "").toLocaleLowerCase());
    } catch {
      continue;
    }
    seen.add(url);
    sources.push({ label, url });
    if (sources.length >= MAX_SOURCE_COUNT) break;
  }
  for (const value of observedUrls) {
    if (sources.length >= MAX_SOURCE_COUNT) break;
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" || parsed.username || parsed.password || seen.has(parsed.href)) continue;
      const host = parsed.hostname.replace(/^www\./i, "").toLocaleLowerCase();
      if (representedHosts.has(host)) continue;
      seen.add(parsed.href);
      representedHosts.add(host);
      sources.push({ label: parsed.hostname, url: parsed.href });
    } catch {
      continue;
    }
  }
  return sources;
}

function markdownArtifacts(markdown: string): JsonObject[] {
  const extensionKinds: Record<string, string> = {
    pdf: "document", docx: "document", txt: "document", md: "document",
    xlsx: "spreadsheet", csv: "spreadsheet", json: "data", zip: "archive",
    png: "image", jpg: "image", jpeg: "image", webp: "image", gif: "image", avif: "image", bmp: "image",
    mp4: "video", webm: "video", mov: "video", m4v: "video", ogv: "video",
    mp3: "audio", m4a: "audio", wav: "audio", ogg: "audio", flac: "audio", aac: "audio",
  };
  const items: JsonObject[] = [];
  const seen = new Set<string>();
  for (const match of markdown.matchAll(/(?:\*\*)?([^`*|<>\r\n\\/]{1,180}\.([A-Za-z0-9]{2,5}))(?:\*\*)?/gu)) {
    const label = cleanText(match[1], 200);
    const extension = match[2].toLocaleLowerCase();
    const type = extensionKinds[extension];
    if (!type || !label || seen.has(label.toLocaleLowerCase())) continue;
    seen.add(label.toLocaleLowerCase());
    items.push({ label, type, path: label, trust: "unverified" });
    if (items.length >= 24) break;
  }
  return items;
}

/**
 * Deterministic One fallback for runtimes that return useful Markdown but do
 * not obey the hidden Surface JSON contract. It promotes only trusted semantic
 * primitives (recognized comparisons, cited narrative, and HTTPS sources); no
 * model HTML or executable code is accepted.
 */
export function buildOneSurfaceFromMarkdown(input: {
  markdown: string;
  fallbackTitle: string;
  taskPrompt?: string;
  observedSourceUrls?: string[];
  /**
   * A completed One tool run may be rendered as an explicitly unverified
   * operational report without public URLs. The caller owns that receipt
   * boundary; ordinary prose never receives this exception.
   */
  allowUncitedStructured?: boolean;
}): AgentlasSurfaceManifest | null {
  const sources = markdownSources(input.markdown, input.observedSourceUrls);
  const markdownTable = addMissingRecommendationToTable(input.markdown, firstMarkdownTable(input.markdown));
  const travelRequest = /(?:여행|trip|itinerary)/i.test(input.taskPrompt ?? "")
    && /(?:일정|동선|예산|schedule|route|budget)/i.test(input.taskPrompt ?? "");
  const budget = travelRequest ? travelBudget(markdownTable, input.taskPrompt ?? "") : null;
  const timeline = travelRequest ? travelTimeline(input.markdown) : [];
  const table = budget ? null : markdownTable ?? recommendationComparison(input.markdown);
  const checklist = orderedChecklist(input.markdown)
    || [];
  const resolvedChecklist = checklist.length > 0
    ? checklist
    : travelRequest
      ? inlineTravelChecklist(input.markdown)
      : [];
  const artifacts = markdownArtifacts(input.markdown);
  const uncitedStructured = input.allowUncitedStructured === true
    && (
      resolvedChecklist.length >= 2
      || structurallyRichNarrative(input.markdown)
      || (markdownTable?.rows.length ?? 0) >= 2
      || artifacts.length > 0
    );
  if (sources.length < 2 && !uncitedStructured) return null;

  const title = informativeHeading(input.markdown, input.fallbackTitle);
  const hangulCount = input.markdown.match(/[가-힣]/g)?.length ?? 0;
  const ko = hangulCount >= 12 || /[가-힣]/.test(title);
  const productComparison = table?.columns.some((column) => /^(?:제품|상품|모델|product|item|model)$/i.test(cleanText(column, 80))) ?? false;
  const narrative = summaryMarkdown(input.markdown);
  if (!table && !narrative && timeline.length === 0 && !budget && resolvedChecklist.length === 0) return null;
  const candidate: AgentlasSurfaceManifest = {
    version: "0.1",
    kind: "surface",
    title,
    domain: sources.length >= 2 ? "research" : "operations",
    layout: timeline.length ? "timeline" : table ? "table" : resolvedChecklist.length ? "workflow" : "report",
    data: {
      ...(narrative ? { summary: { type: "markdown", value: narrative } } : {}),
      ...(timeline.length ? { schedule: {
        type: "timeline",
        items: timeline.map((item) => ({
          ...item,
          evidenceIds: sources.map((_, index) => `source_${index + 1}`),
        })),
      } } : {}),
      ...(budget ? { costs: {
        type: "pricing",
        currency: "KRW",
        limit: budget.limit,
        items: budget.items.map((item) => ({
          ...item,
          evidenceIds: sources.map((_, index) => `source_${index + 1}`),
        })),
      } } : {}),
      ...(table ? { comparison: {
        type: "table",
        columns: table.columns,
        // The source list is attached to every row because Markdown tables do
        // not carry cell-level citation ids. This preserves the trust linter's
        // important-value boundary without upgrading a claim to "verified".
        rows: table.rows.map((row) => ({
          ...row,
          ...(sources.length
            ? { evidenceIds: sources.map((_, index) => `source_${index + 1}`) }
            : { trust: "unverified" }),
        })),
      } } : {}),
      ...(resolvedChecklist.length ? { checklist: {
        type: "launch-checklist",
        items: resolvedChecklist,
      } } : {}),
      ...(artifacts.length ? { artifacts: {
        type: "artifacts",
        items: artifacts,
      } } : {}),
    },
    widgets: [
      ...(narrative ? [{ type: "report", data: "summary", title: ko ? "핵심 요약" : "Summary" }] : []),
      ...(timeline.length ? [{ type: "timeline", data: "schedule", title: ko ? "날짜별 일정" : "Schedule" }] : []),
      ...(budget ? [{ type: "cost-summary", data: "costs", title: ko ? "예상 예산" : "Budget" }] : []),
      ...(table ? [{
        type: "table",
        data: "comparison",
        title: productComparison ? (ko ? "비교" : "Comparison") : (ko ? "확인한 내용" : "Details"),
      }] : []),
      ...(resolvedChecklist.length ? [{ type: "launch-checklist", data: "checklist", title: ko ? "출발 전 확인" : "Before you go" }] : []),
      ...(artifacts.length ? [{ type: "report", data: "artifacts", title: ko ? "만든 파일" : "Files" }] : []),
      ...(sources.length ? [{ type: "source-matrix", title: ko ? "확인한 출처" : "Sources" }] : []),
    ],
    ...(sources.length ? {
      evidence: sources.map((source, index) => ({
        id: `source_${index + 1}`,
        kind: "claimed",
        label: source.label,
        source: source.label,
        url: source.url,
      })),
      provenance: sources.map((source) => ({ source: source.label, url: source.url })),
    } : {}),
  };

  // Reuse the same closed validator as model-emitted manifests. A code-built
  // fallback never receives a weaker admission path.
  const parsed = parseSurfaces(`${SURFACE_OPEN_FENCE}\n${JSON.stringify(candidate)}\n${SURFACE_CLOSE_FENCE}`);
  return parsed.errors.length === 0 && parsed.surfaces.length === 1
    ? parsed.surfaces[0].manifest
    : null;
}
