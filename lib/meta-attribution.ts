// lib/meta-attribution.ts
// El cruce entre el gasto de Meta y los leads del CRM. Puro: sin React, sin
// Next, sin base. Lo usan el sync (oppAdId, PANEL_TIME_ZONE), la entrega ② en el
// panel y el asistente (índice, cohorte, `buildMetaReport` por
// campaña/conjunto/anuncio/mes).
//
// La llave es el AD ID, y EL LEAD ES EL CONTACTO. En este despliegue la mayoría
// de los leads nunca llega a oportunidad (Lezgo Suite: 5,477 contactos contra
// 404 oportunidades), así que una cohorte de oportunidades daba 248 leads contra
// 2,354 que Meta reportaba. El ad id de un contacto se resuelve con una cadena
// de fallbacks, en este orden:
//
//   1. el ad id de alguna oportunidad del contacto (opp.adId / custom field)
//   2. el objeto Pauta ligado al contacto — su nombre termina en el ad id
//      ("<titular> - <liga> - <adId>", el formato que campaignHeadline parsea)
//   3. la primera atribución (attributions[isFirst] / attributionSource)
//   4. la última atribución (attributions[última] / lastAttributionSource)
//
// Cada eslabón "existe" solo si su id está en el dataset de Meta; si ninguno
// está, se conserva el primer id crudo para clasificarlo como `unknownAd`.
// Medido en Lezgo Suite (2026-09-14): 246 por oportunidad, 1,021 por Pauta,
// 408 por primera atribución, 2 por última = 1,677 contactos, 71 % de lo que
// Meta reporta y 75-85 % mes a mes desde que existe el objeto Pauta.
//
// Lo que NO hace: no reparte gasto entre proyectos, no convierte moneda, no
// toca lib/pauta.ts. isDePauta sigue siendo "es de pauta"; esto es "cuánto costó".
import type {
  Contact,
  MetaAccount,
  MetaAd,
  MetaAdsData,
  MetaAdset,
  MetaCampaign,
  MetaDailyRow,
  Opportunity,
  Pauta,
} from "./types";
import { isDePauta, isPaidTraffic, type HasKey } from "./pauta";
import { isWonOpp } from "./opportunity-status";

/** Toda fecha que el usuario ve va en esta zona (ver CLAUDE.md, "hora LOCAL"). */
export const PANEL_TIME_ZONE = "America/Mexico_City";

// ── Llave ───────────────────────────────────────────────────────────────────

// "ID Pauta" e "ID de Pauta": los dos nombres con los que Make escribe el ad id
// como custom field. Nunca "URL Pauta" ni "Nombre Pauta".
const AD_ID_FIELD = /^id\s*(de\s*)?pauta$/i;

function normalizeAdId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const digits = v.trim().replace(/\D/g, "");
  return digits.length >= 6 ? digits : null;
}

function customFieldAdId(cf?: Record<string, string | string[]>): string | null {
  if (!cf) return null;
  for (const [name, val] of Object.entries(cf)) {
    if (!AD_ID_FIELD.test(name.trim())) continue;
    const id = normalizeAdId(Array.isArray(val) ? val[0] : val);
    if (id) return id;
  }
  return null;
}

// El ad id PROPIO de la oportunidad. La attribution nativa manda: es lo que GHL
// recibió del click; el custom field es una copia que escribe Make y a veces
// difiere. No mira al contacto — para eso está resolveOppAdId.
export function oppAdId(opp: Opportunity): string | null {
  return normalizeAdId(opp.adId) ?? customFieldAdId(opp.customFieldsResolved);
}

// El id va después del ÚLTIMO " - ": un "Formulario Balvanera 210726" (fecha
// pegada al nombre, sin separador) no cuenta.
const PAUTA_NAME_ID_RE = /\s-\s(\d{6,})\s*$/;

/** El ad id embebido al final de nombrePauta ("<titular> - <liga> - <adId>"). */
export function pautaAdId(p: Pauta): string | null {
  const m = PAUTA_NAME_ID_RE.exec(p.nombrePauta ?? "");
  return m ? m[1] : null;
}

type AttributionEntry = { [key: string]: unknown };

function firstAttribution(c: Contact): AttributionEntry | undefined {
  const list = c.attributions ?? [];
  return list.find((a) => a.isFirst === true) ?? list[0] ?? c.attributionSource ?? undefined;
}

function lastAttribution(c: Contact): AttributionEntry | undefined {
  const list = c.attributions ?? [];
  const last = [...list].reverse().find((a) => a.isFirst !== true) ?? list[list.length - 1];
  return last ?? c.lastAttributionSource ?? undefined;
}

function attributionAdId(a?: AttributionEntry): string | null {
  return a ? normalizeAdId(a.utmAdId) ?? normalizeAdId(a.adId) : null;
}

// ── Índice ──────────────────────────────────────────────────────────────────

export interface MetaIndex {
  byAd: Map<string, { ad: MetaAd; adset?: MetaAdset; campaign?: MetaCampaign; account?: MetaAccount }>;
  dailyByAd: Map<string, MetaDailyRow[]>;
}

// Una vez por payload; el panel lo memoiza por referencia de metaAds.
export function buildMetaIndex(meta: MetaAdsData): MetaIndex {
  const accounts = new Map(meta.accounts.map((a) => [a.id, a]));
  const campaigns = new Map(meta.campaigns.map((c) => [c.id, c]));
  const adsets = new Map(meta.adsets.map((s) => [s.id, s]));
  const byAd: MetaIndex["byAd"] = new Map();
  for (const ad of meta.ads) {
    const adset = adsets.get(ad.adsetId);
    const campaign = adset ? campaigns.get(adset.campaignId) : undefined;
    const account = campaign ? accounts.get(campaign.accountId) : undefined;
    byAd.set(ad.id, { ad, adset, campaign, account });
  }
  const dailyByAd = new Map<string, MetaDailyRow[]>();
  for (const row of meta.daily) {
    const list = dailyByAd.get(row.adId);
    if (list) list.push(row);
    else dailyByAd.set(row.adId, [row]);
  }
  return { byAd, dailyByAd };
}

// ── Contexto de atribución ──────────────────────────────────────────────────

export interface AttributionContext {
  index: MetaIndex;
  /** Contactos con al menos un registro Pauta: la señal "es de pauta" de isDePauta. */
  pautaContacts: HasKey;
  contactById: Map<string, Contact>;
  oppsByContact: Map<string, Opportunity[]>;
  pautasByContact: Map<string, Pauta[]>;
}

function groupBy<T>(items: T[], key: (t: T) => string | undefined): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!k) continue;
    const list = m.get(k);
    if (list) list.push(it);
    else m.set(k, [it]);
  }
  return m;
}

// Se construye una vez por payload (el panel lo memoiza; el asistente lo guarda
// en ChatIndex). Recibe el HISTORIAL COMPLETO: la cadena de un contacto mira
// sus oportunidades y pautas de siempre, no solo las de la ventana.
export function buildAttributionContext(p: {
  index: MetaIndex;
  contacts: Contact[];
  opportunities: Opportunity[];
  pautas: Pauta[];
}): AttributionContext {
  const pautasByContact = groupBy(p.pautas, (x) => x.contactId);
  return {
    index: p.index,
    pautaContacts: pautasByContact,
    contactById: new Map(p.contacts.map((c) => [c.id, c])),
    oppsByContact: groupBy(p.opportunities, (o) => o.contactId),
    pautasByContact,
  };
}

// ── La cadena ───────────────────────────────────────────────────────────────

// Recorre los eslabones en orden y devuelve el primer id que ESTÁ en Meta. Si
// ninguno está, devuelve el primer id crudo que apareció (→ unknownAd), y null
// si no hubo ninguno (→ noAdId / notPauta).
function resolveChain(ctx: AttributionContext, candidates: () => (string | null)[]): string | null {
  let firstRaw: string | null = null;
  for (const id of candidates()) {
    if (!id) continue;
    if (ctx.index.byAd.has(id)) return id;
    if (!firstRaw) firstRaw = id;
  }
  return firstRaw;
}

/** El ad id de un contacto: oportunidad → Pauta → primera atribución → última. */
export function contactAdId(c: Contact, ctx: AttributionContext): string | null {
  return resolveChain(ctx, () => [
    ...(ctx.oppsByContact.get(c.id) ?? []).map(oppAdId),
    ...(ctx.pautasByContact.get(c.id) ?? []).map(pautaAdId),
    attributionAdId(firstAttribution(c)),
    normalizeAdId(c.adId),
    attributionAdId(lastAttribution(c)),
    customFieldAdId(c.customFieldsResolved),
  ]);
}

/** El ad id de una oportunidad: el propio, y si no está en Meta, la cadena de su contacto. */
export function resolveOppAdId(opp: Opportunity, ctx: AttributionContext): string | null {
  const own = oppAdId(opp);
  if (own && ctx.index.byAd.has(own)) return own;
  const contact = ctx.contactById.get(opp.contactId);
  const viaContact = contact ? contactAdId(contact, ctx) : null;
  if (viaContact && ctx.index.byAd.has(viaContact)) return viaContact;
  return own ?? viaContact;
}

// ── Clasificación ───────────────────────────────────────────────────────────

/**
 * exact     — la cadena dio un ad que está en el dataset de Meta. Entra al costo.
 * unknownAd — hay ad id pero Meta no lo trajo: cuenta no asignada, de otra
 *             empresa, o ad borrado. La señal para "Asignar cuenta".
 * noAdId    — es de pauta pero ningún eslabón trae id. Hueco de captura.
 * notPauta  — orgánico, referido, o importado por CSV (gana incluso con ad id).
 */
export type LeadAttribution = "exact" | "unknownAd" | "noAdId" | "notPauta";

function isCsvImport(attributions?: Array<{ [key: string]: unknown }>): boolean {
  return (attributions ?? []).some((a) => a.medium === "csv_import");
}

function classifyId(id: string | null, dePauta: boolean, ctx: AttributionContext): LeadAttribution {
  if (id && ctx.index.byAd.has(id)) return "exact";
  if (!dePauta) return "notPauta";
  return id ? "unknownAd" : "noAdId";
}

export function classifyContact(c: Contact, ctx: AttributionContext): LeadAttribution {
  if (isCsvImport(c.attributions)) return "notPauta";
  const id = contactAdId(c, ctx);
  // Un contacto es "de pauta" por su registro Pauta o por su propio tráfico
  // pagado — los mismos dos criterios de isDePauta, a nivel contacto.
  const dePauta = ctx.pautaContacts.has(c.id) || isPaidTraffic(c as unknown as Opportunity) || !!id;
  return classifyId(id, dePauta, ctx);
}

export function classifyLead(opp: Opportunity, ctx: AttributionContext): LeadAttribution {
  if (isCsvImport(opp.attributions)) return "notPauta";
  const id = resolveOppAdId(opp, ctx);
  return classifyId(id, isDePauta(opp, ctx.pautaContacts) || !!id, ctx);
}

// ── Fechas ──────────────────────────────────────────────────────────────────

/** YYYY-MM-DD del instante en la zona dada. Compara contra MetaDailyRow.date. */
export function localDay(iso: string, timeZone: string = PANEL_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** Ventana en días locales, ambos inclusive; null = sin recorte. */
export type DayRange = { since: string; until: string } | null;

function inRange(day: string, range: DayRange): boolean {
  return !range || (day >= range.since && day <= range.until);
}

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

// ── Cohorte y costo ─────────────────────────────────────────────────────────

export interface CostInput {
  /** Contactos (ya recortados por atributos o no): el rango se aplica aquí. */
  contacts: Contact[];
  /** Oportunidades, ídem. */
  opportunities: Opportunity[];
  meta: MetaAdsData;
  index: MetaIndex;
  range: DayRange;
  /** Del historial completo (buildAttributionContext). */
  ctx: AttributionContext;
}

export interface CostSummary {
  /** Total consolidado; null si las cuentas mezclan monedas. */
  spend: number | null;
  currency: string | null;
  spendByCurrency: Record<string, number>;
  mixedCurrency: boolean;
  /** Σ leadsForm + leadsMsg de los días en la ventana. */
  leadsMeta: number;
  /** CONTACTOS creados en la ventana (día local) con ad en el dataset. */
  leadsCrm: number;
  /** Oportunidades creadas en la ventana con ad en el dataset (propio o de su contacto). */
  opportunities: number;
  /** De esas, las ganadas por isWonOpp (status o etapa). */
  won: number;
  /** gasto ÷ leadsCrm (contactos). */
  cpl: number | null;
  /** gasto ÷ won. */
  cpa: number | null;
  unknownAdLeads: number;
  noAdIdLeads: number;
}

/** La única moneda de las cuentas del dataset, o null si hay varias o ninguna. */
export function defaultCurrency(meta: MetaAdsData): string | null {
  const set = new Set(meta.accounts.map((a) => a.currency));
  return set.size === 1 ? Array.from(set)[0] : null;
}

// Un ad que ya no está en /ads (borrado, archivado) sigue teniendo insights; sin
// jerarquía no sabemos su cuenta. Si el dataset tiene una sola moneda, es esa.
function currencyOf(index: MetaIndex, adId: string, fallback: string | null): string {
  return index.byAd.get(adId)?.account?.currency ?? fallback ?? "?";
}

// Cohorte de creación: el gasto de la ventana contra los contactos que ESA
// ventana creó, y debajo sus oportunidades y ventas. Sin denominador → null;
// nunca $0 ni ∞.
export function buildCostSummary(p: CostInput): CostSummary {
  const fallback = defaultCurrency(p.meta);
  const spendByCurrency: Record<string, number> = {};
  let leadsMeta = 0;
  for (const row of p.meta.daily) {
    if (!inRange(row.date, p.range)) continue;
    const cur = currencyOf(p.index, row.adId, fallback);
    spendByCurrency[cur] = (spendByCurrency[cur] ?? 0) + row.spend;
    leadsMeta += row.leadsForm + row.leadsMsg;
  }
  const currencies = Object.keys(spendByCurrency);
  const mixedCurrency = currencies.length > 1;
  const currency = currencies.length === 1 ? currencies[0] : null;
  const spend = mixedCurrency ? null : (spendByCurrency[currency ?? ""] ?? 0);

  let leadsCrm = 0;
  let unknownAdLeads = 0;
  let noAdIdLeads = 0;
  for (const c of p.contacts) {
    if (!inRange(localDay(c.createdAt), p.range)) continue;
    const kind = classifyContact(c, p.ctx);
    if (kind === "exact") leadsCrm += 1;
    else if (kind === "unknownAd") unknownAdLeads += 1;
    else if (kind === "noAdId") noAdIdLeads += 1;
  }

  let opportunities = 0;
  let won = 0;
  for (const opp of p.opportunities) {
    if (!inRange(localDay(opp.createdAt), p.range)) continue;
    if (classifyLead(opp, p.ctx) !== "exact") continue;
    opportunities += 1;
    if (isWonOpp(opp)) won += 1;
  }

  return {
    spend,
    currency,
    spendByCurrency,
    mixedCurrency,
    leadsMeta,
    leadsCrm,
    opportunities,
    won,
    cpl: spend === null ? null : ratio(spend, leadsCrm),
    cpa: spend === null ? null : ratio(spend, won),
    unknownAdLeads,
    noAdIdLeads,
  };
}

// ── Reporte por groupBy ─────────────────────────────────────────────────────
// UN solo motor para la tabla del panel (campaign), la sección del PDF y la
// herramienta meta_ads_report del asistente. Cada fila va en la moneda de su
// cuenta; una fila que mezcla cuentas de monedas distintas (none/month) lleva
// currency "?" y sin costos — el gasto se suma igual y el consumidor decide.

export type MetaGroupBy = "none" | "campaign" | "adset" | "ad" | "month";

export interface MetaReportInput extends CostInput {
  groupBy: MetaGroupBy;
  /** Acota a las campañas cuyo nombre contiene esto (sin acentos ni mayúsculas). */
  campaign?: string;
  /** Adjunta oppIds/contactIds (distintos, tope 50) para drill-down y gráficas. */
  includeIds?: boolean;
}

export interface MetaReportRow {
  /** id de campaña/adset/ad, "YYYY-MM", o "total". */
  key: string;
  label: string;
  accountId: string | null;
  /** "?" cuando la fila mezcla monedas. */
  currency: string;
  spend: number;
  impressions: number;
  clicks: number;
  /** Gasto por mil impresiones; null sin impresiones o con moneda mixta. */
  cpm: number | null;
  /** clicks / impressions; null sin impresiones. */
  ctr: number | null;
  leadsMeta: number;
  /** Contactos de la ventana atribuidos a esta fila. */
  leadsCrm: number;
  /** Oportunidades de la ventana atribuidas a esta fila. */
  opportunities: number;
  won: number;
  cpl: number | null;
  cpa: number | null;
  oppIds?: string[];
  contactIds?: string[];
}

/** Compatibilidad con la entrega ①: la fila por campaña con `campaignId`. */
export interface CampaignPerformanceRow extends MetaReportRow {
  campaignId: string;
}

const ID_CAP = 50;

function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

type Hit = ReturnType<MetaIndex["byAd"]["get"]>;

interface Bucket extends MetaReportRow {
  _currencies: Set<string>;
  _oppIds: string[];
  _contactIds: string[];
}

export function buildMetaReport(p: MetaReportInput): MetaReportRow[] {
  const needle = p.campaign ? fold(p.campaign) : null;
  const fallback = defaultCurrency(p.meta);
  const buckets = new Map<string, Bucket>();

  const matches = (hit: Hit): boolean =>
    !needle || (!!hit?.campaign && fold(hit.campaign.name).includes(needle));

  const keyFor = (hit: Hit, day: string): { key: string; label: string; accountId: string | null } | null => {
    switch (p.groupBy) {
      case "none":
        return { key: "total", label: "Total", accountId: null };
      case "month":
        return { key: day.slice(0, 7), label: day.slice(0, 7), accountId: null };
      case "campaign":
        return hit?.campaign ? { key: hit.campaign.id, label: hit.campaign.name, accountId: hit.campaign.accountId } : null;
      case "adset":
        return hit?.adset ? { key: hit.adset.id, label: hit.adset.name, accountId: hit.campaign?.accountId ?? null } : null;
      case "ad":
        return hit ? { key: hit.ad.id, label: hit.ad.name, accountId: hit.campaign?.accountId ?? null } : null;
    }
  };

  const bucketFor = (k: { key: string; label: string; accountId: string | null }): Bucket => {
    let b = buckets.get(k.key);
    if (!b) {
      b = {
        key: k.key, label: k.label, accountId: k.accountId, currency: "?",
        spend: 0, impressions: 0, clicks: 0, cpm: null, ctr: null,
        leadsMeta: 0, leadsCrm: 0, opportunities: 0, won: 0, cpl: null, cpa: null,
        _currencies: new Set(), _oppIds: [], _contactIds: [],
      };
      buckets.set(k.key, b);
    }
    return b;
  };

  for (const row of p.meta.daily) {
    if (!inRange(row.date, p.range)) continue;
    const hit = p.index.byAd.get(row.adId);
    if (!matches(hit)) continue;
    const k = keyFor(hit, row.date);
    if (!k) continue;
    const b = bucketFor(k);
    b.spend += row.spend;
    b.impressions += row.impressions;
    b.clicks += row.clicks;
    b.leadsMeta += row.leadsForm + row.leadsMsg;
    b._currencies.add(currencyOf(p.index, row.adId, fallback));
  }

  for (const c of p.contacts) {
    const day = localDay(c.createdAt);
    if (!inRange(day, p.range)) continue;
    if (classifyContact(c, p.ctx) !== "exact") continue;
    const adId = contactAdId(c, p.ctx)!;
    const hit = p.index.byAd.get(adId);
    if (!matches(hit)) continue;
    const k = keyFor(hit, day);
    if (!k) continue;
    const b = bucketFor(k);
    b.leadsCrm += 1;
    b._currencies.add(currencyOf(p.index, adId, fallback));
    if (p.includeIds && b._contactIds.length < ID_CAP) b._contactIds.push(c.id);
  }

  for (const opp of p.opportunities) {
    const day = localDay(opp.createdAt);
    if (!inRange(day, p.range)) continue;
    if (classifyLead(opp, p.ctx) !== "exact") continue;
    const adId = resolveOppAdId(opp, p.ctx)!;
    const hit = p.index.byAd.get(adId);
    if (!matches(hit)) continue;
    const k = keyFor(hit, day);
    if (!k) continue;
    const b = bucketFor(k);
    b.opportunities += 1;
    if (isWonOpp(opp)) b.won += 1;
    b._currencies.add(currencyOf(p.index, adId, fallback));
    if (p.includeIds && b._oppIds.length < ID_CAP) b._oppIds.push(opp.id);
  }

  const out: MetaReportRow[] = [];
  for (const b of buckets.values()) {
    const { _currencies, _oppIds, _contactIds, ...row } = b;
    const mixed = _currencies.size > 1;
    row.currency = mixed || _currencies.size === 0 ? "?" : Array.from(_currencies)[0];
    row.cpm = !mixed && row.impressions > 0 ? (row.spend / row.impressions) * 1000 : null;
    row.ctr = ratio(row.clicks, row.impressions);
    row.cpl = mixed ? null : ratio(row.spend, row.leadsCrm);
    row.cpa = mixed ? null : ratio(row.spend, row.won);
    if (p.includeIds) {
      row.oppIds = _oppIds;
      row.contactIds = _contactIds;
    }
    out.push(row);
  }
  if (p.groupBy === "month") out.sort((a, b) => a.key.localeCompare(b.key));
  else out.sort((a, b) => b.spend - a.spend || a.label.localeCompare(b.label));
  return out;
}

/** Alias de ①: filas por campaña con `campaignId`. */
export function buildCampaignPerformance(p: CostInput): CampaignPerformanceRow[] {
  return buildMetaReport({ ...p, groupBy: "campaign" }).map((r) => ({ ...r, campaignId: r.key }));
}
