import { z } from "zod";
import { esc } from "../../kit";
import { list, loose, num, optionalNum, optionalText, text, unit } from "../../fields";
import { defineAsset, type AnyAsset } from "../contract";
import { LABEL, MUTED, ROW, accent, cents, count, day, docCss, hue, initials, money, optList, plain } from "./_shared";

/** Business pages: invoice, receipt, one-pager, executive brief, fact sheet and proposal summary. */

// ── invoice ──────────────────────────────────────────────────────────────────────────────────────────────────
const STATUS: Record<string, [string, string]> = { paid: ["#e3f1eb", "var(--green)"], due: ["#fbf1de", "var(--amber)"], overdue: ["#f8e6e8", "var(--red)"], draft: ["#eef0ee", "var(--muted)"] };
const status = loose(["paid", "due", "overdue", "draft"] as [string, ...string[]], { unpaid: "due", open: "due", pending: "due", outstanding: "due", sent: "due", late: "overdue", past_due: "overdue", settled: "paid", complete: "paid", completed: "paid" }, "due");
const party = z.object({ name: text(40), lines: optList(text(48), 3) }).strip();
const lineItem = z.object({ description: text(56), qty: num, unitPrice: num }).strip();

/** The invoice's arithmetic, done once here so the figures can never disagree with each other. */
function invoiceTotals(b: { items: { qty: number; unitPrice: number }[]; adjustments?: { amount: number }[]; taxRate?: number }) {
  const subtotal = cents(b.items.reduce((sum, i) => sum + cents(i.qty * i.unitPrice), 0)), adjusted = cents(subtotal + (b.adjustments ?? []).reduce((sum, a) => sum + a.amount, 0));
  const tax = b.taxRate ? cents((adjusted * b.taxRate) / 100) : 0;
  return { subtotal, tax, total: cents(adjusted + tax) };
}

export const invoice = defineAsset({
  type: "invoice", category: "document", width: "half", frame: "a4",
  use: "An invoice: from and bill-to parties, invoice number, dates, a paid/due/overdue chip, line items, subtotal, tax and total.",
  useKo: "청구서: 발행자·청구 대상, 청구서 번호, 날짜, 결제 상태, 품목 내역, 소계·세금·합계.",
  tags: ["invoice", "bill", "billing", "line items", "payment due", "청구서", "인보이스", "결제", "견적", "세금계산서"],
  notes: "Give quantity and unit price per line; the page computes amounts, subtotal, tax (taxRate in percent) and total. adjustments: up to 2 extra lines such as shipping (+) or a discount (-). currency: usd, eur, gbp, krw ...",
  fields: { invoiceNo: text(24), status, issued: text(24), due: optionalText(24), from: party, to: party, items: list(lineItem, 1, 8), adjustments: optList(z.object({ label: text(24), amount: num }).strip(), 2), taxRate: optionalNum, currency: unit.default("usd"), note: optionalText(130), accent },
  sample: {
    invoiceNo: "INV-2026-0187", status: "due", issued: "", due: "", from: { name: "Brightline Studio LLC", lines: ["418 Alder Street, Portland, OR 97205", "billing@brightline.example"] }, to: { name: "Calder & Finch", lines: ["Accounts Payable", "88 Mill Road, Providence, RI 02903"] },
    items: [{ description: "Brand identity system", qty: 1, unitPrice: 6500 }, { description: "Website design, 12 pages", qty: 1, unitPrice: 9800 }, { description: "Copywriting (hours)", qty: 24, unitPrice: 95 }, { description: "Stock photography licences", qty: 6, unitPrice: 45 }, { description: "Project management (hours)", qty: 20, unitPrice: 80 }],
    adjustments: [{ label: "Early-signing discount", amount: -500 }], taxRate: 7.5, currency: "usd", note: "Payment by bank transfer within 30 days, quoting the invoice number. Thank you for your business.", accent: "blue",
  },
  render(b, { ko, T }) {
    const t = invoiceTotals(b), m = (v: number) => money(v, b.currency, ko), [bg, fg] = STATUS[b.status] ?? STATUS.due;
    const words: Record<string, string> = { paid: T("Paid", "결제 완료"), due: T("Due", "결제 예정"), overdue: T("Overdue", "연체"), draft: T("Draft", "초안") };
    const cell = (k: string, v: string, extra = "") => `<div style="min-width:0"><div style="${LABEL}">${k}</div><b class="a-el" style="display:block;margin-top:.4cqw;${extra}">${v}</b></div>`;
    const who = (k: string, p: { name: string; lines?: string[] }) => `<div style="min-width:0"><h3>${k}</h3><b class="a-el" style="display:block;margin-top:.8cqw;font-size:2.4cqw">${esc(p.name)}</b>${(p.lines ?? []).map(l => `<div class="a-el" style="${MUTED}">${esc(l)}</div>`).join("")}</div>`;
    const tot = (k: string, v: string, big = false) => `<div style="display:flex;justify-content:space-between;gap:3cqw;padding:.7cqw 0${big ? ";margin-top:.8cqw;padding-top:1.6cqw;border-top:.35cqw solid var(--ink);font-size:3cqw;font-weight:800;color:var(--ink)" : ""}"><span>${k}</span><b class="a-el"${big ? ' style="color:var(--ac)"' : ""}>${v}</b></div>`;
    return `<div class="a-pg" ${hue(b.accent, "blue", "", ko)}><div style="${ROW};align-items:flex-start"><div style="min-width:0"><h2 style="font-size:5.6cqw;letter-spacing:.06em;text-transform:uppercase;color:var(--ac)">${T("Invoice", "청구서")}</h2><div class="a-el" style="${MUTED};margin-top:.6cqw">${T("No.", "번호")} ${esc(b.invoiceNo)}</div></div><em style="background:${bg};color:${fg};font-size:2cqw;padding:.6cqw 2.2cqw">${words[b.status]}</em></div>`
      + `<div style="display:grid;grid-template-columns:1fr 1fr 1.25fr;gap:2.4cqw;padding:2.2cqw 2.8cqw;margin:3.2cqw 0;border-radius:1.4cqw;background:var(--surface)">${cell(T("Issued", "발행일"), esc(day(b.issued, ko)))}${cell(T("Due", "결제 기한"), esc(b.due ? day(b.due, ko) : "—"))}${cell(T("Amount due", "청구 금액"), m(t.total), "font-size:3cqw;color:var(--ac)")}</div>`
      + `<div style="display:grid;grid-template-columns:1fr 1fr;gap:4cqw;margin-bottom:3cqw">${who(T("From", "발신"), b.from)}${who(T("Bill to", "청구 대상"), b.to)}</div>`
      + `<div class="a-ro" style="padding-top:0;border-bottom:.3cqw solid var(--ink);${LABEL}"><span>${T("Description", "내용")}</span><span>${T("Qty", "수량")}</span><span>${T("Unit price", "단가")}</span><span>${T("Amount", "금액")}</span></div>`
      + b.items.map(i => `<div class="a-ro"><span class="a-el" style="color:var(--ink)">${esc(i.description)}</span><span>${esc(count(i.qty))}</span><span>${esc(m(i.unitPrice))}</span><b>${esc(m(cents(i.qty * i.unitPrice)))}</b></div>`).join("")
      + `<div style="width:46cqw;margin:2cqw 0 0 auto">${tot(T("Subtotal", "소계"), esc(m(t.subtotal)))}${(b.adjustments ?? []).map(a => tot(esc(a.label), esc(m(a.amount)))).join("")}${b.taxRate ? tot(`${T("Tax", "세금")} (${count(b.taxRate)}%)`, esc(m(t.tax))) : ""}${tot(T("Total", "합계"), esc(m(t.total)), true)}</div>`
      + `${b.note ? `<p class="a-lc" style="--n:3;margin:auto 0 0;padding-top:2cqw;${MUTED}">${esc(b.note)}</p>` : ""}</div>`;
  },
  summary: b => { const t = invoiceTotals(b); return `Invoice ${plain(b.invoiceNo)} (${b.status}) from ${plain(b.from.name)} to ${plain(b.to.name)}, issued ${plain(b.issued)}${b.due ? `, due ${plain(b.due)}` : ""}: ${b.items.length} items, subtotal ${money(t.subtotal, b.currency, false)}, tax ${money(t.tax, b.currency, false)}, total ${money(t.total, b.currency, false)}.`; },
  css: docCss("invoice", ["pg", "fx", "h", "k", "e", "el", "lc"], `
    § .a-ro{display:grid;grid-template-columns:minmax(0,1fr) 5cqw 13cqw 14cqw;gap:1.5cqw;align-items:baseline;padding:1.1cqw 0;border-bottom:.2cqw solid var(--line)}
    § .a-ro>*{min-width:0;overflow:hidden;text-overflow:ellipsis}
    § .a-ro>:nth-child(n+2){text-align:right;white-space:nowrap}
    § .a-ro b{color:var(--ink)}`),
});

// ── receipt ──────────────────────────────────────────────────────────────────────────────────────────────────
/** A barcode-like strip that is the same every time for the same text: decoration, not data. */
function bars(seed: string): { rects: string; width: number } {
  let h = 2166136261, x = 0, rects = "";
  for (const c of seed) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  for (let i = 0; x < 118; i++) {
    h = Math.imul(h ^ (h >>> 15), 2246822507) >>> 0; h = Math.imul(h ^ (h >>> 13), 3266489909) >>> 0;
    const w = 1 + (h % 3), gap = 1 + ((h >>> 7) % 2);
    rects += `<rect x="${x}" width="${w}" height="14"/>`; x += w + gap;
  }
  return { rects, width: x };
}
const ZIG = (flip: boolean) => `<svg viewBox="0 0 100 3" preserveAspectRatio="none" aria-hidden="true" style="width:100%;height:1.6cqw;margin:${flip ? "-.1cqw 0 0" : "0 0 -.1cqw"}"><path d="M0 ${flip ? 0 : 3}${Array.from({ length: 25 }, (_, i) => `L${i * 4 + 2} ${(i % 2 === 0) === flip ? 3 : 0}L${i * 4 + 4} ${flip ? 0 : 3}`).join("")}V${flip ? 0 : 3}Z" fill="#fffefb"/></svg>`;

export const receipt = defineAsset({
  type: "receipt", category: "document", width: "half", frame: "a4",
  use: "A till or card receipt: merchant, items with prices, tax, total, payment line and a barcode, on narrow thermal paper.",
  useKo: "영수증: 상호, 품목과 가격, 세금, 합계, 결제 수단과 바코드를 감열지 모양으로 보여줍니다.",
  tags: ["receipt", "till", "pos", "purchase", "payment proof", "영수증", "구매", "결제 내역", "카드 전표"],
  notes: "Each item has a line price (qty optional, shown as 2 x). The total is computed: items + tax + tip. Up to 10 items.",
  fields: { merchant: text(36), address: optionalText(60), datetime: text(28), receiptNo: optionalText(20), items: list(z.object({ name: text(30), qty: optionalNum, price: num }).strip(), 1, 10), tax: optionalNum, tip: optionalNum, currency: unit.default("usd"), payment: optionalText(36), footer: optionalText(44), accent },
  sample: {
    merchant: "Juniper Coffee Roasters", address: "1420 Market Street, San Francisco, CA", datetime: "Oct 14, 2026  08:42", receiptNo: "#20417",
    items: [{ name: "Oat flat white", qty: 2, price: 9.5 }, { name: "Cold brew, 16 oz", price: 5.25 }, { name: "Almond croissant", qty: 2, price: 9 }, { name: "Single-origin beans 250g", price: 17.5 }, { name: "Sparkling water", price: 3 }],
    tax: 3.62, tip: 4, currency: "usd", payment: "VISA •••• 4242 · Approved", footer: "Thank you, see you tomorrow", accent: "amber",
  },
  render(b, { ko, T }) {
    const m = (v: number) => money(v, b.currency, ko), sum = cents(b.items.reduce((s, i) => s + i.price, 0)), total = cents(sum + (b.tax ?? 0) + (b.tip ?? 0));
    const dash = `<div style="border-top:.3cqw dashed #9aa2a7;margin:1.6cqw 0"></div>`, line = (k: string, v: string, big = false) => `<div style="display:flex;justify-content:space-between;gap:2cqw;${big ? "font-size:2.7cqw;font-weight:800;color:var(--ink);margin-top:.6cqw" : ""}"><span>${k}</span><span>${v}</span></div>`;
    const code = bars(`${b.merchant}${b.receiptNo ?? ""}${b.datetime}`);
    return `<div class="a-pg" ${hue(b.accent, "amber", "background:var(--surface);padding:4.5cqw 0;align-items:center;justify-content:center", ko)}><div style="width:58cqw;max-height:100%;display:flex;flex-direction:column;min-height:0;filter:drop-shadow(0 .4cqw 1cqw rgba(16,29,36,.14))">${ZIG(false)}`
      + `<div class="a-sf" style="font-family:ui-monospace,'SF Mono',Menlo,Consolas,monospace;font-size:1.85cqw;line-height:1.5;background:#fffefb;padding:1.2cqw 4cqw;min-height:0;overflow:hidden;color:var(--ink2)">`
      + `<div style="display:flex;flex-direction:column;align-items:center;text-align:center"><i style="display:flex;align-items:center;justify-content:center;width:6.4cqw;height:6.4cqw;border-radius:50%;background:var(--ac);margin-bottom:1.2cqw;color:#fff;font-style:normal;font-weight:800;font-size:2.3cqw;line-height:1">${esc(initials(b.merchant))}</i><b class="a-lc" style="--n:2;font-size:2.7cqw;line-height:1.2;letter-spacing:.06em;text-transform:uppercase">${esc(b.merchant)}</b>${b.address ? `<div class="a-lc" style="--n:2;${MUTED};font-size:1.6cqw">${esc(b.address)}</div>` : ""}</div>${dash}`
      + `<div style="${ROW};font-size:1.6cqw;color:var(--muted)"><span class="a-el">${esc(b.datetime)}</span><span class="a-el">${esc(b.receiptNo ?? "")}</span></div>${dash}`
      + b.items.map(i => `<div style="display:flex;justify-content:space-between;gap:2cqw"><span class="a-el">${i.qty ? `${esc(count(i.qty))} × ` : ""}${esc(i.name)}</span><span style="flex:none">${esc(m(i.price))}</span></div>`).join("") + dash
      + line(T("Subtotal", "소계"), esc(m(sum))) + (b.tax ? line(T("Tax", "세금"), esc(m(b.tax))) : "") + (b.tip ? line(T("Tip", "팁"), esc(m(b.tip))) : "") + line(T("TOTAL", "합계"), esc(m(total)), true)
      + `${b.payment ? `${dash}<div class="a-el" style="text-align:center;font-size:1.6cqw">${esc(b.payment)}</div>` : ""}<svg viewBox="0 0 ${code.width} 14" preserveAspectRatio="none" aria-hidden="true" style="width:80%;height:7cqw;margin:2.4cqw auto 1cqw;display:block" fill="var(--ink)">${code.rects}</svg>`
      + `${b.footer ? `<div class="a-el" style="text-align:center;font-size:1.6cqw;color:var(--muted);margin-bottom:1cqw">${esc(b.footer)}</div>` : ""}</div>${ZIG(true)}</div></div>`;
  },
  summary: b => { const sum = cents(b.items.reduce((s, i) => s + i.price, 0)), total = cents(sum + (b.tax ?? 0) + (b.tip ?? 0)); return `Receipt from ${plain(b.merchant)}, ${plain(b.datetime)}: ${b.items.map(i => plain(i.name)).join(", ")}. Total ${money(total, b.currency, false)}${b.payment ? `, paid ${plain(b.payment)}` : ""}.`; },
  css: docCss("receipt", ["pg", "h", "el", "lc"], ""),
});

// ── one_pager ────────────────────────────────────────────────────────────────────────────────────────────────
export const onePager = defineAsset({
  type: "one_pager", category: "document", width: "half", frame: "a4",
  use: "A one-page summary: a headline, three key points each with a number, a strip of metrics and a call to action.",
  useKo: "한 장 요약: 제목, 숫자가 있는 핵심 3가지, 지표 띠, 행동 유도 막대.",
  tags: ["one pager", "one-pager", "summary", "key points", "metrics", "leave behind", "한 장", "요약", "핵심", "원페이저"],
  notes: "Exactly three points (figure at most 12 characters, e.g. 42% or $1.2M), up to 4 metrics, one call to action.",
  fields: { kicker: optionalText(30), org: optionalText(40), headline: text(80), standfirst: optionalText(150), points: list(z.object({ figure: text(12), label: text(36), detail: text(100) }).strip(), 3, 3), metrics: optList(z.object({ label: text(20), value: text(12) }).strip(), 4), cta: z.object({ text: text(70), action: optionalText(24) }).strip(), accent },
  sample: {
    kicker: "Customer success", org: "Lumen Learning", headline: "Teams that onboard in the first week keep 2.3 times more learners", standfirst: "A look at 1,800 company accounts shows that the first seven days decide whether a rollout sticks.",
    points: [{ figure: "2.3×", label: "Higher 90-day retention", detail: "Accounts that enrol a first cohort within seven days of signing keep far more active learners." }, { figure: "41%", label: "Fewer support tickets", detail: "A named internal champion cuts setup questions by two fifths in the first month." }, { figure: "6 days", label: "Median time to first course", detail: "Guided setup brings the median down from 19 days, and most of the gain comes from templates." }],
    metrics: [{ label: "Accounts", value: "1,800" }, { label: "Learners", value: "212K" }, { label: "Completion", value: "74%" }, { label: "NPS", value: "+48" }], cta: { text: "Book a 20-minute onboarding review for your team", action: "lumen.example/start" }, accent: "violet",
  },
  render(b, { ko }) {
    return `<div class="a-pg" ${hue(b.accent, "blue", "padding-top:0", ko)}><div style="${ROW};margin:0 -8cqw;padding:3.6cqw 8cqw;background:var(--ac);color:#fff;font-size:1.7cqw;font-weight:800;letter-spacing:.12em;text-transform:uppercase"><span class="a-el">${esc(b.kicker ?? "")}</span><span class="a-el" style="font-weight:700;opacity:.85">${esc(b.org ?? "")}</span></div>`
      + `<h2 class="a-lc" style="--n:3;font-size:5.6cqw;line-height:1.12;margin-top:4cqw">${esc(b.headline)}</h2>${b.standfirst ? `<p class="a-lc" style="--n:3;margin:1.6cqw 0 0;font-size:2.5cqw;line-height:1.4;color:var(--muted)">${esc(b.standfirst)}</p>` : ""}`
      + `<div style="margin-top:3cqw;border-top:.35cqw solid var(--ink)">${b.points.map(p => `<div style="display:grid;grid-template-columns:23cqw minmax(0,1fr);gap:3cqw;align-items:center;padding:2cqw 0;border-bottom:.2cqw solid var(--line)"><div class="a-sf a-el" style="font-size:6.4cqw;font-weight:700;line-height:1;color:var(--ac)">${esc(p.figure)}</div><div style="min-width:0"><b class="a-el" style="display:block;font-size:2.4cqw">${esc(p.label)}</b><div class="a-lc" style="--n:3;${MUTED};margin-top:.4cqw">${esc(p.detail)}</div></div></div>`).join("")}</div>`
      + `${b.metrics ? `<div style="display:grid;grid-template-columns:repeat(${b.metrics.length},1fr);gap:1.6cqw;margin-top:3cqw">${b.metrics.map(x => `<div style="min-width:0;padding:1.8cqw 2cqw;border-radius:1.2cqw;background:var(--at)"><div class="a-el" style="${LABEL}">${esc(x.label)}</div><b class="a-el a-sf" style="display:block;font-size:3.4cqw;line-height:1.2;color:var(--ac)">${esc(x.value)}</b></div>`).join("")}</div>` : ""}`
      + `<div style="${ROW};margin-top:auto;padding:2.6cqw 3.2cqw;border-radius:1.6cqw;background:var(--ac);color:#fff"><b class="a-lc" style="--n:2;color:#fff;font-size:2.4cqw;line-height:1.3">${esc(b.cta.text)}</b>${b.cta.action ? `<span class="a-el" style="flex:none;max-width:42%;padding:.8cqw 1.8cqw;border-radius:9cqw;background:rgba(255,255,255,.2);font-size:1.7cqw;font-weight:750">${esc(b.cta.action)} →</span>` : ""}</div></div>`;
  },
  summary: b => `${plain(b.headline)}: ${b.points.map(p => `${plain(p.figure)} ${plain(p.label)}`).join("; ")}.${b.metrics ? ` Metrics: ${b.metrics.map(x => `${plain(x.label)} ${plain(x.value)}`).join(", ")}.` : ""} Call to action: ${plain(b.cta.text)}.`,
  css: docCss("one_pager", ["pg", "fx", "h", "el", "lc"], ""),
});

// ── brief_page ───────────────────────────────────────────────────────────────────────────────────────────────
const LEVEL: Record<string, [string, string]> = { low: ["var(--green)", "#e3f1eb"], medium: ["var(--amber)", "#fbf1de"], high: ["var(--red)", "#f8e6e8"] };
const level = loose(["low", "medium", "high"] as [string, ...string[]], { med: "medium", mid: "medium", moderate: "medium", minor: "low", critical: "high", severe: "high", major: "high" }, "medium");

export const briefPage = defineAsset({
  type: "brief_page", category: "document", width: "half", frame: "a4",
  use: "An executive brief: bottom line up front, three to four key findings with evidence, risks with levels and recommended next steps.",
  useKo: "경영진 브리프: 결론 먼저, 근거가 있는 핵심 발견 3~4개, 위험 수준, 권고 다음 단계.",
  tags: ["brief", "executive summary", "bluf", "bottom line", "findings", "risks", "브리프", "경영진", "결론", "핵심 발견", "리스크"],
  notes: "bluf is the answer in at most 200 characters; 3-4 findings (claim + evidence); up to 3 risks with a level (low, medium, high); 2-3 next steps.",
  fields: { title: text(80), kicker: optionalText(28), date: optionalText(24), author: optionalText(40), bluf: text(200), findings: list(z.object({ claim: text(60), evidence: text(100) }).strip(), 3, 4), risks: optList(z.object({ risk: text(60), level }).strip(), 3), next: list(z.object({ step: text(70), owner: optionalText(20) }).strip(), 2, 3), accent },
  sample: {
    title: "Should we move checkout to the new payment provider?", kicker: "Executive brief", date: "", author: "Strategy & Operations", bluf: "Yes, but in two phases. Moving 100% of checkout in Q1 would cut fees by 0.4 points and lift approvals, provided the provider's uptime is proven on 10% of traffic first.",
    findings: [{ claim: "Fees fall by about $1.1M a year", evidence: "Blended rate drops from 2.9% to 2.5% on $275M of annual volume, per the provider's signed quote." }, { claim: "Card approvals rise 1.8 points", evidence: "Pilot on 40,000 orders in September: 93.1% approved versus 91.3% on the current provider." }, { claim: "Migration needs eight engineer-weeks", evidence: "Estimate from the platform team covers token migration, webhooks and refund flows." }, { claim: "Uptime history is short", evidence: "Only 14 months of public status data; two incidents above 30 minutes in that time." }],
    risks: [{ risk: "Outage during peak sales weeks", level: "high" }, { risk: "Saved-card tokens fail to migrate", level: "medium" }, { risk: "Contract lock-in of 36 months", level: "low" }],
    next: [{ step: "Approve a 10% traffic pilot from November 3", owner: "CFO" }, { step: "Negotiate a 99.95% uptime clause with credits", owner: "Legal" }, { step: "Report pilot results to the board on Dec 12", owner: "Strategy" }], accent: "blue",
  },
  render(b, { ko, T }) {
    const sec = (k: string) => `<h3 style="padding-bottom:1cqw;margin-bottom:1.2cqw;border-bottom:.2cqw solid var(--line)">${k}</h3>`;
    const words: Record<string, string> = { low: T("Low", "낮음"), medium: T("Medium", "중간"), high: T("High", "높음") };
    return `<div class="a-pg" ${hue(b.accent, "blue", "", ko)}><div style="${ROW}"><h3>${esc(b.kicker ?? T("Executive brief", "경영진 브리프"))}</h3><span class="a-el" style="${MUTED}">${esc(b.date ? day(b.date, ko) : "")}</span></div>`
      + `<h2 class="a-lc" style="--n:2;font-size:4.4cqw;margin-top:1.6cqw">${esc(b.title)}</h2>${b.author ? `<div class="a-el" style="${MUTED};margin-top:1cqw">${esc(b.author)}</div>` : ""}`
      + `<div style="margin:3cqw 0;padding:2.2cqw 2.8cqw;border-left:1cqw solid var(--ac);border-radius:0 1.4cqw 1.4cqw 0;background:var(--at)"><h3>${T("Bottom line", "결론")}</h3><p class="a-sf a-lc" style="--n:4;margin:.8cqw 0 0;font-size:2.4cqw;line-height:1.45;font-weight:600;color:var(--ink)">${esc(b.bluf)}</p></div>`
      + `${sec(T("Key findings", "핵심 발견"))}${b.findings.map((f, i) => `<div style="display:grid;grid-template-columns:3.6cqw minmax(0,1fr);gap:1.8cqw;margin-bottom:1.5cqw"><span style="display:flex;align-items:center;justify-content:center;width:3.4cqw;height:3.4cqw;border-radius:50%;background:var(--ac);color:#fff;font-size:1.7cqw;font-weight:800">${i + 1}</span><div style="min-width:0"><b class="a-el" style="display:block">${esc(f.claim)}</b><div class="a-lc" style="--n:2;${MUTED}">${esc(f.evidence)}</div></div></div>`).join("")}`
      + `<div style="display:grid;grid-template-columns:1fr 1fr;gap:4cqw;margin-top:1.5cqw"><div style="min-width:0">${sec(T("Risks", "위험"))}${(b.risks ?? []).map(r => { const [fg, bg] = LEVEL[r.level] ?? LEVEL.medium; return `<div style="margin-bottom:1.3cqw"><em style="background:${bg};color:${fg};font-size:1.5cqw;padding:.1cqw 1.2cqw">${words[r.level]}</em><div class="a-lc" style="--n:2;margin-top:.4cqw">${esc(r.risk)}</div></div>`; }).join("")}</div>`
      + `<div style="min-width:0">${sec(T("Next steps", "다음 단계"))}${b.next.map(n => `<div style="margin-bottom:1.3cqw"><div class="a-lc" style="--n:2">→ ${esc(n.step)}</div>${n.owner ? `<div class="a-el" style="${MUTED};padding-left:2.2cqw">${esc(n.owner)}</div>` : ""}</div>`).join("")}</div></div></div>`;
  },
  summary: b => `${plain(b.title)}. Bottom line: ${plain(b.bluf)} Findings: ${b.findings.map(f => plain(f.claim)).join("; ")}.${b.risks ? ` Risks: ${b.risks.map(r => `${plain(r.risk)} (${r.level})`).join("; ")}.` : ""} Next: ${b.next.map(n => plain(n.step)).join("; ")}.`,
  css: docCss("brief_page", ["pg", "fx", "h", "k", "e", "p", "el", "lc"], ""),
});

// ── fact_sheet ───────────────────────────────────────────────────────────────────────────────────────────────
export const factSheet = defineAsset({
  type: "fact_sheet", category: "document", width: "half", frame: "a4",
  use: "A fact sheet: a title and subtitle, six to twelve key facts as label and value in two columns, and a short note.",
  useKo: "팩트시트: 제목·부제, 라벨과 값으로 된 핵심 사실 6~12개(2단), 짧은 주석.",
  tags: ["fact sheet", "key facts", "at a glance", "profile", "specs", "팩트시트", "한눈에", "개요", "스펙", "프로필"],
  notes: "6-12 facts, label at most 24 characters and value at most 44; they fill the left column first.",
  fields: { title: text(60), subtitle: optionalText(100), kicker: optionalText(24), facts: list(z.object({ label: text(24), value: text(44) }).strip(), 6, 12), note: optionalText(180), accent },
  sample: {
    title: "Northwind Logistics at a glance", subtitle: "Regional carrier, Pacific Northwest", kicker: "Fact sheet",
    facts: [{ label: "Founded", value: "2009, Portland, Oregon" }, { label: "Employees", value: "3,100" }, { label: "Parcels per month", value: "2.4 million" }, { label: "Fleet", value: "400 electric vans" }, { label: "Depots", value: "17 across 3 states" }, { label: "Delivery window", value: "Same day within 60 miles" }, { label: "On-time rate", value: "98.2% (12 months)" }, { label: "Emissions cut", value: "31% since 2023" }, { label: "Certifications", value: "ISO 14001, B Corp" }, { label: "Chief executive", value: "Marcus Tran" }, { label: "Headquarters", value: "212 Water Street, Portland" }, { label: "Customer support", value: "24/7 by chat and phone" }],
    note: "Figures are for the twelve months to September 2026 and are unaudited. Fleet count includes vans in commissioning.", accent: "green",
  },
  render(b, { ko, T }) {
    return `<div class="a-pg" ${hue(b.accent, "green", "", ko)}><div style="width:12cqw;height:1cqw;background:var(--ac);margin-bottom:3cqw"></div><h3>${esc(b.kicker ?? T("Fact sheet", "팩트시트"))}</h3><h2 class="a-lc" style="--n:2;font-size:5.4cqw;margin-top:1.2cqw">${esc(b.title)}</h2>${b.subtitle ? `<p class="a-lc" style="--n:2;margin:1.4cqw 0 0;font-size:2.6cqw;color:var(--muted)">${esc(b.subtitle)}</p>` : ""}<div style="height:.4cqw;background:var(--ink);margin:3.4cqw 0 1cqw"></div>`
      + `<div class="a-fl" style="columns:2;column-gap:6cqw;column-rule:.2cqw solid var(--line)">${b.facts.map(f => `<div style="break-inside:avoid;padding:1.6cqw 0;border-bottom:.2cqw solid var(--line)"><div class="a-el" style="${LABEL}">${esc(f.label)}</div><b class="a-lc" style="--n:2;display:-webkit-box;margin-top:.5cqw;font-size:2.5cqw;line-height:1.3">${esc(f.value)}</b></div>`).join("")}</div>`
      + `${b.note ? `<div style="margin-top:3cqw;padding:2cqw 2.6cqw;border-radius:1.4cqw;background:var(--at)"><h3>${T("Note", "참고")}</h3><p class="a-lc" style="--n:3;margin:.6cqw 0 0;font-size:1.9cqw;color:var(--ink2)">${esc(b.note)}</p></div>` : ""}</div>`;
  },
  summary: b => `${plain(b.title)}${b.subtitle ? ` — ${plain(b.subtitle)}` : ""}: ${b.facts.map(f => `${plain(f.label)} ${plain(f.value)}`).join("; ")}.`,
  css: docCss("fact_sheet", ["pg", "fx", "h", "k", "p", "el", "lc"], ""),
});

// ── proposal_summary ─────────────────────────────────────────────────────────────────────────────────────────
export const proposalSummary = defineAsset({
  type: "proposal_summary", category: "document", width: "half", frame: "a4",
  use: "A proposal in one page: the problem, the proposed solution, a three-to-five phase timeline bar, a cost summary and the ask.",
  useKo: "제안서 요약 한 장: 문제, 해결안, 3~5단계 일정 막대, 비용 요약, 요청 사항.",
  tags: ["proposal", "pitch", "project plan", "timeline", "cost", "statement of work", "제안서", "기획서", "일정", "견적", "예산"],
  notes: "3-5 phases with a length in weeks (the bar is drawn to scale), 1-4 cost lines (the total is computed), and one ask.",
  fields: { title: text(70), client: optionalText(40), date: optionalText(24), problem: text(240), solution: text(240), phases: list(z.object({ name: text(22), weeks: num }).strip(), 3, 5), costs: list(z.object({ item: text(34), amount: num }).strip(), 1, 4), currency: unit.default("usd"), ask: text(150), accent },
  sample: {
    title: "Rebuilding the customer help centre", client: "Prepared for Calder & Finch", date: "", problem: "Customers cannot find answers on their own: 63% of support tickets ask about topics the help centre already covers, and the search returns the right article first only one time in four.",
    solution: "A new help centre with task-based navigation, rewritten top-100 articles and a search tuned on real queries, plus an in-product widget that suggests articles before a ticket is opened.",
    phases: [{ name: "Discovery", weeks: 2 }, { name: "Content", weeks: 5 }, { name: "Build", weeks: 4 }, { name: "Pilot", weeks: 2 }, { name: "Launch", weeks: 1 }], costs: [{ item: "Research and information design", amount: 12000 }, { item: "Content rewrite, 100 articles", amount: 26000 }, { item: "Build and search tuning", amount: 18500 }, { item: "Pilot and launch support", amount: 7500 }], currency: "usd",
    ask: "Approve the $64,000 budget and name a product owner by October 30 so discovery can start on November 3.", accent: "teal",
  },
  render(b, { ko, T }) {
    const total = b.phases.reduce((s, p) => s + Math.max(0, p.weeks), 0), n = b.phases.length, cost = cents(b.costs.reduce((s, c) => s + c.amount, 0)), m = (v: number) => money(v, b.currency, ko);
    const tone = (i: number) => (0.32 + (0.68 * i) / Math.max(1, n - 1)).toFixed(2);
    const col = (k: string, body: string) => `<div style="min-width:0"><h3 style="margin-bottom:.8cqw">${k}</h3><p class="a-sf a-lc" style="--n:8;margin:0;font-size:2cqw;line-height:1.5">${esc(body)}</p></div>`;
    return `<div class="a-pg" ${hue(b.accent, "blue", "", ko)}><div style="${ROW}"><h3>${T("Proposal", "제안서")}</h3><span class="a-el" style="${MUTED}">${esc([b.client, b.date ? day(b.date, ko) : ""].filter(Boolean).join(" · "))}</span></div><h2 class="a-lc" style="--n:2;font-size:4.6cqw;margin:1.6cqw 0 3.4cqw">${esc(b.title)}</h2>`
      + `<div style="display:grid;grid-template-columns:1fr 1fr;gap:4cqw;padding-top:2.4cqw;border-top:.35cqw solid var(--ink)">${col(T("The problem", "문제"), b.problem)}${col(T("Our solution", "해결안"), b.solution)}</div>`
      + `<div style="${ROW};margin:3.6cqw 0 1.4cqw"><h3>${T("Timeline", "일정")}</h3><b style="font-size:1.8cqw">${esc(count(total))} ${T("weeks", "주")}</b></div>`
      + `<div style="display:flex;gap:.5cqw;height:3.2cqw">${b.phases.map((p, i) => `<i style="flex:${Math.max(0.5, p.weeks)} 1 0;min-width:1cqw;border-radius:.8cqw;background:var(--ac);opacity:${tone(i)}"></i>`).join("")}</div>`
      + `<div style="display:flex;gap:.5cqw;margin-top:1.4cqw;font-size:1.7cqw;line-height:1.35">${b.phases.map(p => `<div style="flex:${Math.max(0.5, p.weeks)} 1 0;min-width:1cqw;overflow:hidden"><div class="a-el" style="font-weight:750;color:var(--ink)">${esc(p.name)}</div><div class="a-el" style="color:var(--muted)">${esc(count(p.weeks))} ${T("wk", "주")}</div></div>`).join("")}</div>`
      + `<h3 style="margin:3.6cqw 0 1cqw">${T("Cost summary", "비용 요약")}</h3>${b.costs.map(c => `<div style="${ROW};padding:.9cqw 0;border-bottom:.2cqw solid var(--line)"><span class="a-el">${esc(c.item)}</span><span style="flex:none">${esc(m(c.amount))}</span></div>`).join("")}<div style="${ROW};padding-top:1.4cqw;font-size:2.7cqw;font-weight:800;color:var(--ink)"><span>${T("Total", "합계")}</span><span style="color:var(--ac)">${esc(m(cost))}</span></div>`
      + `<div style="margin-top:auto;padding:2.4cqw 3cqw;border-radius:1.6cqw;background:var(--ac);color:#fff"><div style="font-size:1.5cqw;font-weight:800;letter-spacing:.14em;text-transform:uppercase;opacity:.8">${T("The ask", "요청 사항")}</div><b class="a-lc" style="--n:3;color:#fff;font-size:2.3cqw;line-height:1.4;font-weight:650">${esc(b.ask)}</b></div></div>`;
  },
  summary: b => `${plain(b.title)}${b.client ? ` (${plain(b.client)})` : ""}. Problem: ${plain(b.problem)} Timeline: ${b.phases.map(p => `${plain(p.name)} ${count(p.weeks)} wk`).join(", ")}. Cost ${money(cents(b.costs.reduce((s, c) => s + c.amount, 0)), b.currency, false)}. Ask: ${plain(b.ask)}`,
  css: docCss("proposal_summary", ["pg", "fx", "h", "k", "el", "lc"], ""),
});

export const ASSETS: readonly AnyAsset[] = [invoice, receipt, onePager, briefPage, factSheet, proposalSummary];
