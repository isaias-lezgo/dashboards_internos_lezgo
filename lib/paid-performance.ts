// lib/paid-performance.ts
// El motor de "Inversión y rendimiento de pauta": UNA tabla campaña → anuncios
// sobre la pauta del CRM, con las columnas de Meta encima cuando hay conexión.
//
// El átomo es el anuncio (ad id). Es la llave de Meta y es lo que trae la
// oportunidad; la URL, la etapa y la cita cuelgan de la oportunidad / contacto,
// que cuelgan del ad id. El ad id sale de la MISMA cadena que usa el CPL
// (resolveOppAdId / contactAdId), para que "Opps" aquí y "Opps" bajo el CPL
// cuenten lo mismo. Sin Meta la cadena corre con un índice vacío y devuelve el
// primer id crudo: no hay un segundo camino.
//
// Puro: sin React, sin fetch. Lo consumen la tabla, la sección del PDF y (algún
// día) el asistente. Spec: docs/superpowers/specs/2026-09-19-pauta-rendimiento-unificado-design.md
import type { Appointment, Contact, MetaAdsData, Opportunity, Pipeline } from "./types";
import {
  type AttributionContext,
  type DayRange,
  buildMetaReport,
  classifyContact,
  classifyLead,
  contactAdId,
  defaultCurrency,
  resolveOppAdId,
} from "./meta-attribution";
import { campaignHeadline, resolveCampaignName } from "./pauta";
import { platformLabel } from "./source-platform";
import { isWonOpp } from "./opportunity-status";

export type PaidGroupBy = "campaign" | "platform";

/** Un MetaAdsData sin nada: con él la cadena de atribución corre igual sin Meta. */
export const EMPTY_META: MetaAdsData = {
  accounts: [],
  campaigns: [],
  adsets: [],
  ads: [],
  daily: [],
  window: { since: "", until: "" },
  failedAccounts: [],
};

export const NO_AD_KEY = "__sin_id";
export const NO_AD_LABEL = "Sin ID de anuncio";
export const SIN_NOMBRE = "Sin nombre";
/** Anuncios que Meta trae sin campaña (archivados): gastan, pero no están en ninguna. */
const ORPHAN_KEY = "meta:__sin_campana";
const ORPHAN_LABEL = "Anuncios sin campaña en Meta";

export interface PaidPerformanceInput {
  /** Recortados por fecha Y atributos, como llegan al dashboard. */
  opportunities: Opportunity[];
  contacts: Contact[];
  appointments: Appointment[];
  pipelines: Pipeline[];
  pautaNameByContact: Map<string, string>;
  /** Del historial completo (buildAttributionContext); trae el índice de Meta, vacío o no. */
  ctx: AttributionContext;
  groupBy: PaidGroupBy;
  includeLost: boolean;
  /** null = sin Meta. En groupBy "platform" se ignora (decisión 12 del spec). */
  meta: { data: MetaAdsData; range: DayRange } | null;
}

export interface StageCount {
  stage: string;
  /** Posición en el pipeline; las etapas fuera del pipeline van al final. */
  order: number;
  lost: boolean;
  count: number;
}

export interface PaidRow {
  key: string;
  label: string;
  /** Solo en hijos con anuncio. */
  adId: string | null;
  /** La liga más frecuente entre sus oportunidades y cuántas OTRAS distintas hay. */
  url: { href: string; platform: "facebook" | "instagram" | "other"; others: number } | null;
  /** true = fila del CRM sin cruce con Meta (o sin Meta). */
  crmOnly: boolean;
  // Inversión — null sin Meta / sin cruce / en modo Origen. currency "?" = mezclada.
  currency: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  cpm: number | null;
  ctr: number | null;
  leadsMeta: number | null;
  cpl: number | null;
  cpa: number | null;
  // CRM
  leadsCrm: number;
  opportunities: number;
  won: number;
  /** Contactos con al menos una cita en la ventana. */
  appointments: number;
  /** Contactos con al menos una cita `showed`. */
  showed: number;
  /** Suma = opportunities. */
  stages: StageCount[];
  // Para el drill: sin tope.
  oppIds: string[];
  contactIds: string[];
  apptContactIds: string[];
}

export interface PaidGroup extends PaidRow {
  children: PaidRow[];
}

export function urlPlatform(url: string): "facebook" | "instagram" | "other" {
  const u = url.toLowerCase();
  if (u.includes("instagram.com") || u.includes("ig.me")) return "instagram";
  if (u.includes("fb.me") || u.includes("facebook.com") || u.includes("fb.com")) return "facebook";
  return "other";
}

// ── Cubos ───────────────────────────────────────────────────────────────────

interface Bucket {
  key: string;
  label: string;
  adId: string | null;
  crmOnly: boolean;
  urls: Map<string, number>;
  stageCounts: Map<string, { lost: boolean; count: number }>;
  won: number;
  oppIds: string[];
  contactIds: Set<string>;
  /** Todos los contactos de la fila (leads + dueños de sus opps): la base de Citas. */
  rowContacts: Set<string>;
  // Inversión (attachMeta)
  currency: string | null;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  leadsMeta: number | null;
}

function newBucket(key: string, label: string, adId: string | null, crmOnly: boolean): Bucket {
  return {
    key, label, adId, crmOnly,
    urls: new Map(), stageCounts: new Map(), won: 0,
    oppIds: [], contactIds: new Set(), rowContacts: new Set(),
    currency: null, spend: null, impressions: null, clicks: null, leadsMeta: null,
  };
}

interface GroupBucket extends Bucket {
  children: Map<string, Bucket>;
}

type GroupKey = { key: string; label: string; crmOnly: boolean };

function ratio(n: number | null, d: number | null): number | null {
  return n === null || d === null || d <= 0 ? null : n / d;
}

// ── Motor ───────────────────────────────────────────────────────────────────

export function buildPaidPerformance(p: PaidPerformanceInput): PaidGroup[] {
  const { ctx } = p;
  const groups = new Map<string, GroupBucket>();

  const groupFor = (gk: GroupKey): GroupBucket => {
    let g = groups.get(gk.key);
    if (!g) {
      g = { ...newBucket(gk.key, gk.label, null, gk.crmOnly), children: new Map() };
      groups.set(gk.key, g);
    }
    return g;
  };
  const childFor = (g: GroupBucket, adId: string | null): Bucket => {
    const key = adId ?? NO_AD_KEY;
    let c = g.children.get(key);
    if (!c) {
      const inMeta = !!adId && ctx.index.byAd.has(adId);
      c = newBucket(key, adId ?? NO_AD_LABEL, adId, !inMeta);
      g.children.set(key, c);
    }
    return c;
  };

  // El grupo por jerarquía de Meta (si el anuncio cruza) o por headline del CRM.
  const metaOrCrmGroup = (adId: string | null, crmName: string | undefined): GroupKey => {
    const hit = adId ? ctx.index.byAd.get(adId) : undefined;
    if (hit?.campaign) return { key: `meta:${hit.campaign.id}`, label: hit.campaign.name, crmOnly: false };
    if (hit) return { key: ORPHAN_KEY, label: ORPHAN_LABEL, crmOnly: false };
    const headline = crmName ? campaignHeadline(crmName) : SIN_NOMBRE;
    return { key: `crm:${headline}`, label: headline, crmOnly: true };
  };
  const platformGroup = (label: string, adId: string | null): GroupKey => ({
    key: `platform:${label}`,
    label,
    crmOnly: !(adId && ctx.index.byAd.has(adId)),
  });

  // Paso 1 — oportunidades. Cada una decide el grupo y el hijo de su contacto.
  const placementByContact = new Map<string, { group: GroupBucket; child: Bucket }>();
  for (const opp of p.opportunities) {
    if (classifyLead(opp, ctx) === "notPauta") continue;
    const lost = opp.status === "lost";
    if (lost && !p.includeLost) continue;
    const adId = resolveOppAdId(opp, ctx);
    const gk =
      p.groupBy === "platform"
        ? platformGroup(platformLabel(opp), adId)
        : metaOrCrmGroup(adId, resolveCampaignName(opp, p.pautaNameByContact));
    const g = groupFor(gk);
    const c = childFor(g, adId);
    for (const b of [g, c]) {
      b.oppIds.push(opp.id);
      if (opp.contactId) b.rowContacts.add(opp.contactId);
      if (isWonOpp(opp)) b.won += 1;
      const sc = b.stageCounts.get(opp.stage) ?? { lost, count: 0 };
      sc.count += 1;
      b.stageCounts.set(opp.stage, sc);
      if (opp.attributionUrl) b.urls.set(opp.attributionUrl, (b.urls.get(opp.attributionUrl) ?? 0) + 1);
    }
    if (opp.contactId && !placementByContact.has(opp.contactId)) placementByContact.set(opp.contactId, { group: g, child: c });
  }

  // Paso 2 — contactos (Leads CRM). Un contacto con oportunidad en la ventana cae
  // donde cayó ella; sin ella, por su propio ad id (Meta) o su primera pauta (CRM).
  for (const c of p.contacts) {
    if (classifyContact(c, ctx) === "notPauta") continue;
    let placed = placementByContact.get(c.id);
    if (!placed) {
      const adId = contactAdId(c, ctx);
      let gk: GroupKey;
      if (p.groupBy === "platform") {
        const anyOpp = (ctx.oppsByContact.get(c.id) ?? [])[0];
        gk = platformGroup(anyOpp ? platformLabel(anyOpp) : "Otro", adId);
      } else {
        gk = metaOrCrmGroup(adId, p.pautaNameByContact.get(c.id));
      }
      const g = groupFor(gk);
      placed = { group: g, child: childFor(g, adId) };
    }
    for (const b of [placed.group, placed.child]) {
      b.contactIds.add(c.id);
      b.rowContacts.add(c.id);
    }
  }

  // Paso 3 — inversión de Meta (en "platform" no aplica: decisión 12).
  if (p.meta && p.groupBy === "campaign") attachMeta(groups, groupFor, childFor, p.meta, ctx);

  // Paso 4 — citas: contactos de la fila con al menos una cita; showed aparte.
  const apptContacts = new Set<string>();
  const showedContacts = new Set<string>();
  for (const a of p.appointments) {
    if (!a.contactId) continue;
    apptContacts.add(a.contactId);
    if (a.status === "showed") showedContacts.add(a.contactId);
  }

  const stageOrder = new Map<string, number>();
  for (const pl of p.pipelines) for (const s of pl.stages) if (!stageOrder.has(s)) stageOrder.set(s, stageOrder.size);

  const finish = (b: Bucket): PaidRow => {
    const apptIds = Array.from(b.rowContacts).filter((id) => apptContacts.has(id));
    const stages: StageCount[] = Array.from(b.stageCounts.entries())
      .map(([stage, v]) => ({ stage, order: stageOrder.get(stage) ?? Number.MAX_SAFE_INTEGER, lost: v.lost, count: v.count }))
      // Perdidas al final; el resto en orden del pipeline.
      .sort((x, y) => Number(x.lost) - Number(y.lost) || x.order - y.order || x.stage.localeCompare(y.stage));
    let url: PaidRow["url"] = null;
    if (b.urls.size > 0) {
      const [href] = Array.from(b.urls.entries()).sort((x, y) => y[1] - x[1])[0];
      url = { href, platform: urlPlatform(href), others: b.urls.size - 1 };
    }
    const mixed = b.currency === "?";
    return {
      key: b.key,
      label: b.label,
      adId: b.adId,
      url,
      crmOnly: b.crmOnly,
      currency: b.currency,
      spend: b.spend,
      impressions: b.impressions,
      clicks: b.clicks,
      cpm: mixed || !b.impressions ? null : (b.spend! / b.impressions) * 1000,
      ctr: ratio(b.clicks, b.impressions),
      leadsMeta: b.leadsMeta,
      cpl: mixed ? null : ratio(b.spend, b.contactIds.size),
      cpa: mixed ? null : ratio(b.spend, b.won),
      leadsCrm: b.contactIds.size,
      opportunities: b.oppIds.length,
      won: b.won,
      appointments: apptIds.length,
      showed: apptIds.filter((id) => showedContacts.has(id)).length,
      stages,
      oppIds: b.oppIds,
      contactIds: Array.from(b.contactIds),
      apptContactIds: apptIds,
    };
  };

  return Array.from(groups.values()).map((g) => ({
    ...finish(g),
    children: Array.from(g.children.values()).map(finish),
  }));
}

// El gasto por anuncio sale de buildMetaReport({ groupBy: "ad" }) — el MISMO motor
// de la herramienta del asistente — con contactos y opps vacíos: aquí solo
// queremos lo que Meta sabe (gasto, impresiones, clics, leads que reporta); los
// leads del CRM ya los contó el paso 2 con la misma cadena. Los hijos de una
// campaña son la UNIÓN de sus anuncios en Meta y los ad ids del CRM: un anuncio
// que gasta y no trae leads aparece con opps en 0, o la suma de los hijos no
// daría el gasto de la campaña.
function attachMeta(
  groups: Map<string, GroupBucket>,
  groupFor: (gk: GroupKey) => GroupBucket,
  childFor: (g: GroupBucket, adId: string | null) => Bucket,
  meta: { data: MetaAdsData; range: DayRange },
  ctx: AttributionContext
): void {
  const byAd = new Map(
    buildMetaReport({ contacts: [], opportunities: [], meta: meta.data, index: ctx.index, range: meta.range, ctx, groupBy: "ad" })
      .map((r) => [r.key, r] as const)
  );
  const fallback = defaultCurrency(meta.data) ?? "?";

  // Todo anuncio que Meta conoce tiene fila, gaste o no en la ventana.
  for (const [adId, hit] of ctx.index.byAd) {
    const g = hit.campaign
      ? groupFor({ key: `meta:${hit.campaign.id}`, label: hit.campaign.name, crmOnly: false })
      : groupFor({ key: ORPHAN_KEY, label: ORPHAN_LABEL, crmOnly: false });
    const c = childFor(g, adId);
    const r = byAd.get(adId);
    c.currency = r ? r.currency : (hit.account?.currency ?? fallback);
    c.spend = r?.spend ?? 0;
    c.impressions = r?.impressions ?? 0;
    c.clicks = r?.clicks ?? 0;
    c.leadsMeta = r?.leadsMeta ?? 0;
  }

  // El grupo suma a sus hijos con inversión; la moneda se hereda si es una sola.
  for (const g of groups.values()) {
    const invested = Array.from(g.children.values()).filter((c) => c.spend !== null);
    if (invested.length === 0) continue;
    const currencies = new Set(invested.map((c) => c.currency));
    g.currency = currencies.size === 1 ? Array.from(currencies)[0] : "?";
    g.spend = invested.reduce((a, c) => a + (c.spend ?? 0), 0);
    g.impressions = invested.reduce((a, c) => a + (c.impressions ?? 0), 0);
    g.clicks = invested.reduce((a, c) => a + (c.clicks ?? 0), 0);
    g.leadsMeta = invested.reduce((a, c) => a + (c.leadsMeta ?? 0), 0);
    g.crmOnly = false;
  }
}

// ── Agregado "Otras (n)" ────────────────────────────────────────────────────
// Sumas para conteos y gasto; las tasas quedan en null (una tasa de un agregado
// heterogéneo engaña), y la moneda solo si todas las filas la comparten.

export function sumRows(rows: PaidRow[], key: string, label: string): PaidRow {
  const sumOrNull = (pick: (r: PaidRow) => number | null): number | null => {
    const vals = rows.map(pick).filter((v): v is number => v !== null);
    return vals.length === 0 ? null : vals.reduce((a, v) => a + v, 0);
  };
  const currencies = new Set(rows.map((r) => r.currency).filter((c): c is string => !!c));
  const stageMap = new Map<string, StageCount>();
  for (const r of rows) for (const s of r.stages) {
    const cur = stageMap.get(s.stage);
    if (cur) cur.count += s.count;
    else stageMap.set(s.stage, { ...s });
  }
  const uniq = (pick: (r: PaidRow) => string[]) => Array.from(new Set(rows.flatMap(pick)));
  return {
    key, label, adId: null, url: null,
    crmOnly: rows.every((r) => r.crmOnly),
    currency: currencies.size === 1 ? Array.from(currencies)[0] : currencies.size > 1 ? "?" : null,
    spend: sumOrNull((r) => r.spend),
    impressions: sumOrNull((r) => r.impressions),
    clicks: sumOrNull((r) => r.clicks),
    cpm: null, ctr: null, cpl: null, cpa: null,
    leadsMeta: sumOrNull((r) => r.leadsMeta),
    leadsCrm: rows.reduce((a, r) => a + r.leadsCrm, 0),
    opportunities: rows.reduce((a, r) => a + r.opportunities, 0),
    won: rows.reduce((a, r) => a + r.won, 0),
    appointments: rows.reduce((a, r) => a + r.appointments, 0),
    showed: rows.reduce((a, r) => a + r.showed, 0),
    stages: Array.from(stageMap.values()).sort((x, y) => Number(x.lost) - Number(y.lost) || x.order - y.order),
    oppIds: uniq((r) => r.oppIds),
    contactIds: uniq((r) => r.contactIds),
    apptContactIds: uniq((r) => r.apptContactIds),
  };
}
