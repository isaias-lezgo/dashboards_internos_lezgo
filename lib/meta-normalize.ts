// lib/meta-normalize.ts
// Lo puro de la integración con Meta Ads: de la respuesta cruda de Graph a las
// tablas de MetaAdsData, la ventana de historia y su partición por mes. Sin
// fetch, sin Next: lo prueba pnpm verify:meta y lo importa lib/meta-client.ts.
import type {
  MetaAccount,
  MetaAd,
  MetaAdset,
  MetaAdsData,
  MetaCampaign,
  MetaDailyRow,
} from "./types";

/** action_type de un lead por formulario ("Pauta Formulario"). */
export const LEAD_FORM_ACTION = "lead";
/** action_type de una conversación iniciada desde un anuncio de WhatsApp ("Pauta WhatsApp"). */
export const LEAD_MSG_ACTION = "onsite_conversion.messaging_conversation_started_7d";
/** Hasta dónde atrás se pide gasto, aunque haya oportunidades más viejas. */
export const MAX_HISTORY_MONTHS = 24;

export interface RawInsightRow {
  ad_id: string;
  date_start: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  inline_link_clicks?: string;
  actions?: { action_type: string; value: string }[];
}

export interface RawAd {
  id: string;
  name: string;
  effective_status?: string;
  adset?: { id: string; name: string };
  campaign?: { id: string; name: string; objective?: string };
}

function num(v: string | number | undefined): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function action(r: RawInsightRow, type: string): number {
  return num(r.actions?.find((a) => a.action_type === type)?.value);
}

export function normalizeInsightRow(r: RawInsightRow): MetaDailyRow {
  return {
    adId: String(r.ad_id),
    date: r.date_start,
    spend: num(r.spend),
    impressions: num(r.impressions),
    reach: num(r.reach),
    clicks: num(r.clicks),
    linkClicks: num(r.inline_link_clicks),
    leadsForm: action(r, LEAD_FORM_ACTION),
    leadsMsg: action(r, LEAD_MSG_ACTION),
  };
}

// Tablas planas con ids de padre. Un ad cuyo adset o campaña ya no existe (Meta
// los devuelve sin esos objetos) se conserva con padre vacío: su gasto histórico
// sigue siendo real.
export function normalizeAds(
  accountId: string,
  raw: RawAd[]
): { campaigns: MetaCampaign[]; adsets: MetaAdset[]; ads: MetaAd[] } {
  const campaigns = new Map<string, MetaCampaign>();
  const adsets = new Map<string, MetaAdset>();
  const ads: MetaAd[] = [];
  for (const a of raw) {
    if (a.campaign && !campaigns.has(a.campaign.id)) {
      campaigns.set(a.campaign.id, {
        id: a.campaign.id,
        name: a.campaign.name,
        objective: a.campaign.objective,
        accountId,
      });
    }
    if (a.adset && !adsets.has(a.adset.id)) {
      adsets.set(a.adset.id, { id: a.adset.id, name: a.adset.name, campaignId: a.campaign?.id ?? "" });
    }
    ads.push({ id: String(a.id), name: a.name, adsetId: a.adset?.id ?? "", status: a.effective_status });
  }
  return { campaigns: [...campaigns.values()], adsets: [...adsets.values()], ads };
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function ymd(y: number, m: number, d: number): string {
  return `${y}-${pad(m)}-${pad(d)}`;
}

function lastDayOfMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// Meta se ahoga con rangos largos a nivel ad; un mes calendario por petición es
// el tamaño que cabe sin volverse un job asíncrono.
export function monthChunks(since: string, until: string): { since: string; until: string }[] {
  if (since > until) return [];
  const out: { since: string; until: string }[] = [];
  let [y, m] = since.split("-").map(Number);
  let cursor = since;
  while (cursor <= until) {
    const end = ymd(y, m, lastDayOfMonth(y, m));
    out.push({ since: cursor, until: end < until ? end : until });
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
    cursor = ymd(y, m, 1);
  }
  return out;
}

// Desde el primer día del mes de la oportunidad más antigua con adId, con tope de
// MAX_HISTORY_MONTHS. Sin oportunidades con adId: solo el mes en curso. `today`
// es YYYY-MM-DD ya en la zona horaria del panel; este módulo no sabe de zonas.
export function historyWindow(
  opps: { createdAt: string; adId?: string }[],
  today: string
): { since: string; until: string } {
  const [ty, tm] = today.split("-").map(Number);
  let earliest: string | null = null;
  for (const o of opps) {
    if (!o.adId) continue;
    const d = o.createdAt.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (earliest === null || d < earliest) earliest = d;
  }
  let since = ymd(ty, tm, 1);
  if (earliest) {
    const [ey, em] = earliest.split("-").map(Number);
    since = ymd(ey, em, 1);
  }
  // Tope: MAX_HISTORY_MONTHS meses atrás, primer día de ese mes.
  let fy = ty;
  let fm = tm - MAX_HISTORY_MONTHS;
  while (fm <= 0) {
    fm += 12;
    fy -= 1;
  }
  const floor = ymd(fy, fm, 1);
  if (since < floor) since = floor;
  return { since, until: today };
}

export function mergeMetaAds(
  parts: {
    account: MetaAccount;
    hierarchy: { campaigns: MetaCampaign[]; adsets: MetaAdset[]; ads: MetaAd[] };
    daily: MetaDailyRow[];
  }[],
  failed: { id: string; reason: string }[],
  window: { since: string; until: string }
): MetaAdsData {
  return {
    accounts: parts.map((p) => p.account),
    campaigns: parts.flatMap((p) => p.hierarchy.campaigns),
    adsets: parts.flatMap((p) => p.hierarchy.adsets),
    ads: parts.flatMap((p) => p.hierarchy.ads),
    daily: parts.flatMap((p) => p.daily),
    window,
    failedAccounts: failed,
  };
}
