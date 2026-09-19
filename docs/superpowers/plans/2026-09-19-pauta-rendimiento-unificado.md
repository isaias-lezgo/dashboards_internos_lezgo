# Inversión y rendimiento de pauta — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Una sola tarjeta en Marketing —tabla expandible campaña → anuncios sobre la
pauta del CRM, con las columnas de Meta encima cuando hay conexión— que jubila la tabla
de "Inversión en pauta" y las gráficas de etapa, ID de anuncio, URL y citas por pauta.

**Architecture:** Un motor puro nuevo (`lib/paid-performance.ts`) agrupa oportunidades,
contactos y citas por anuncio (ad id resuelto con la cadena de `lib/meta-attribution.ts`)
y por campaña (jerarquía de Meta si cruza; headline del CRM si no), y le suma el gasto por
anuncio de `buildMetaReport({ groupBy: "ad" })`. Un componente nuevo
(`components/dashboard/paid-performance-table.tsx`) lo dibuja y construye la sección del
PDF; `marketing-dashboard.tsx` pierde cuatro tarjetas y sus memos.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, Tailwind v3, shadcn/ui
(`Table`, `Popover`, `Checkbox`, `Tooltip`), lucide-react, pdfmake (vía `lib/pdf/*`),
`tsx` + `node:assert/strict` para verificación. pnpm.

**Spec:** `docs/superpowers/specs/2026-09-19-pauta-rendimiento-unificado-design.md`

## Global Constraints

- **Sin framework de pruebas.** La verificación es `scripts/verify-paid-performance.ts`
  (`node:assert/strict`, corre con `tsx`), más manejar la app real. El paquete es CJS:
  **nada de `await` de nivel superior** — `main().catch(...)`.
- **`npx tsc --noEmit` antes de cada commit de código.** `next build` ignora los errores
  de tipos (`next.config.mjs`), así que un build verde no prueba nada.
- **pnpm, nunca npm.** No se agregan dependencias en este plan.
- **El átomo es el ad id resuelto por la cadena** (`resolveOppAdId` / `contactAdId` de
  `lib/meta-attribution.ts`). Nunca leer `opp.adId` crudo para agrupar.
- **El gasto de una campaña de Meta debe ser idéntico** al de
  `buildMetaReport({ groupBy: "campaign" })` con la misma entrada (aserción 1).
- **Toda fecha en hora local** (`localDay`, `America/Mexico_City`). Aquí no se formatean
  fechas nuevas; los datasets llegan ya recortados por `dashboard-app.tsx`.
- **Los drill-downs resuelven joins contra el historial completo** (`allOpportunities`,
  `allContacts`), como todo drawer del panel.
- **Ámbar (`#F59B1B` / `text-primary`) solo para atención**: la barra de etapas usa el
  primario con opacidad creciente; las perdidas van en rojo apagado.
- **Ninguna gráfica nueva necesita leyenda**: el hover de la barra decodifica.
- **Sin `ScrollArea` de Radix** dentro de tarjetas; `overflow-x-auto` plano.
- **El asistente (`lib/ai-tools.ts`) no se toca.**
- Comentarios en el idioma del archivo vecino (español en `lib/meta-attribution.ts` y
  `meta-investment-section.tsx`; inglés donde el archivo ya está en inglés).
- Commits terminan con `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`.

---

## Mapa de archivos

| Archivo | Responsabilidad |
|---|---|
| `lib/paid-performance.ts` (nuevo) | Motor puro: `buildPaidPerformance(input) → PaidGroup[]`, `urlPlatform`, `PAID_COLUMNS`. Sin React. |
| `scripts/verify-paid-performance.ts` (nuevo) | Las siete aserciones del spec. |
| `components/dashboard/paid-performance-table.tsx` (nuevo) | `usePaidPerformance`, `PaidPerformanceTable` (tarjeta, controles, editor de columnas, filas expandibles, barra de etapas, drills), `buildPaidReportSection` (PDF). |
| `components/dashboard/dashboard-ui.tsx` | Gana `CopyButton` y `LinkButton` (hoy privados de marketing-dashboard). |
| `components/dashboard/meta-investment-section.tsx` | `useMetaInvestment` recibe `ctx`; `MetaInvestmentSection` se vuelve `MetaInvestmentTiles` (sin tarjeta, sin tabla); `buildMetaReportSection` se va. |
| `components/dashboard/marketing-dashboard.tsx` | Construye el contexto de atribución una vez; monta la tarjeta nueva; pierde cuatro tarjetas, sus memos, estado y secciones de PDF. |
| `app/api/analyze-report/route.ts` | Solo el comentario del presupuesto (13 → 9 secciones). |
| `package.json` | `verify:paid-performance`. |
| `CLAUDE.md` | La sección de Meta Ads y el índice de comandos. |

---

### Task 1: Motor — universo del CRM (sin Meta)

**Files:**
- Create: `lib/paid-performance.ts`
- Create: `scripts/verify-paid-performance.ts`
- Modify: `package.json:27` (agregar el script)

**Interfaces:**
- Consumes (de `lib/meta-attribution.ts`): `AttributionContext`, `buildMetaIndex(meta)`,
  `buildAttributionContext({ index, contacts, opportunities, pautas })`,
  `resolveOppAdId(opp, ctx)`, `contactAdId(c, ctx)`, `classifyLead(opp, ctx)`,
  `classifyContact(c, ctx)`, `buildMetaReport`, `defaultCurrency`, `DayRange`.
  De `lib/pauta.ts`: `resolveCampaignName(opp, pautaNameByContact)`,
  `campaignHeadline(name)`. De `lib/source-platform.ts`: `platformLabel(opp)`. De
  `lib/opportunity-status.ts`: `isWonOpp(opp)`.
- Produces: todo lo de abajo; Tasks 3–7 dependen de estos nombres exactos.

```ts
export type PaidGroupBy = "campaign" | "platform"
export const EMPTY_META: MetaAdsData
export const NO_AD_KEY = "__sin_id"
export const NO_AD_LABEL = "Sin ID de anuncio"
export const SIN_NOMBRE = "Sin nombre"
export interface PaidPerformanceInput { ... }   // ver Step 3
export interface StageCount { stage: string; order: number; lost: boolean; count: number }
export interface PaidRow { ... }                 // ver Step 3
export interface PaidGroup extends PaidRow { children: PaidRow[] }
export function buildPaidPerformance(p: PaidPerformanceInput): PaidGroup[]
export function urlPlatform(url: string): "facebook" | "instagram" | "other"
export function sumRows(rows: PaidRow[], key: string, label: string): PaidRow  // agrega "Otras (n)"
```

- [ ] **Step 1: Escribir el script de verificación con las aserciones 3–6 (fallan porque el módulo no existe)**

Crear `scripts/verify-paid-performance.ts`:

```ts
// Verificación de lib/paid-performance.ts. Correr: pnpm verify:paid-performance
//
// Un error aquí es un número equivocado en la tabla de "Inversión y rendimiento
// de pauta": un gasto de campaña que no cuadra con el Administrador de anuncios,
// una oportunidad de TikTok que desaparece por no tener ad id, o una cita contada
// dos veces. Por eso las aserciones fijan: (1) el gasto por campaña es IDÉNTICO
// al de buildMetaReport; (2) un anuncio con gasto y sin leads existe; (3) lo que
// no cruza con Meta sobrevive sin costos; (4) la barra de etapas suma Opps;
// (5) sin Meta salen las mismas filas; (6) Citas cuenta contactos; (7) la cadena
// manda sobre el campo crudo.
//
// Envuelto en main() en vez de usar await de nivel superior: este paquete es CJS.
import assert from "node:assert/strict";
import type { Appointment, Contact, MetaAdsData, Opportunity, Pauta, Pipeline } from "../lib/types";
import { buildMetaIndex, buildAttributionContext, buildMetaReport } from "../lib/meta-attribution";
import { buildPaidPerformance, EMPTY_META, NO_AD_KEY, type PaidGroup } from "../lib/paid-performance";

// ── Fixtures ────────────────────────────────────────────────────────────────

function opp(over: Partial<Opportunity> & { id: string }): Opportunity {
  return {
    name: over.id,
    pipelineId: "p",
    pipelineStageId: "s",
    status: "open",
    createdAt: "2026-08-10T15:00:00.000Z",
    contactId: `c-${over.id}`,
    value: 0,
    stage: "Nuevo",
    pipelineName: "Ventas",
    source: "facebook",
    attributionMedium: "paid_social",
    ...over,
  } as Opportunity;
}

function contact(over: Partial<Contact> & { id: string }): Contact {
  return { name: over.id, createdAt: "2026-08-10T15:00:00.000Z", tags: [], ...over } as Contact;
}

function appt(id: string, contactId: string, status: string): Appointment {
  return { id, contactId, startTime: "2026-08-12T16:00:00.000Z", endTime: "2026-08-12T17:00:00.000Z", status };
}

const pipelines: Pipeline[] = [{ id: "p", name: "Ventas", stages: ["Nuevo", "Cita", "Ganado", "Perdido"] }];

// Dos campañas de Meta, tres anuncios. El anuncio 300 gasta y no trae leads.
const meta: MetaAdsData = {
  accounts: [{ id: "act_1", name: "Lezgo", currency: "MXN", timezone: "America/Mexico_City" }],
  campaigns: [
    { id: "camp-A", name: "CAMPAÑA A", accountId: "act_1" },
    { id: "camp-B", name: "CAMPAÑA B", accountId: "act_1" },
  ],
  adsets: [
    { id: "set-A", name: "Set A", campaignId: "camp-A" },
    { id: "set-B", name: "Set B", campaignId: "camp-B" },
  ],
  ads: [
    { id: "100", name: "Ad 100", adsetId: "set-A" },
    { id: "200", name: "Ad 200", adsetId: "set-A" },
    { id: "300", name: "Ad 300", adsetId: "set-B" },
  ],
  daily: [
    { adId: "100", date: "2026-08-10", spend: 100, impressions: 1000, reach: 900, clicks: 50, linkClicks: 40, leadsForm: 3, leadsMsg: 0 },
    { adId: "200", date: "2026-08-11", spend: 50.5, impressions: 500, reach: 450, clicks: 20, linkClicks: 15, leadsForm: 0, leadsMsg: 2 },
    { adId: "300", date: "2026-08-11", spend: 75.25, impressions: 700, reach: 600, clicks: 30, linkClicks: 22, leadsForm: 1, leadsMsg: 0 },
  ],
  window: { since: "2026-08-01", until: "2026-08-31" },
  failedAccounts: [],
};

const opportunities: Opportunity[] = [
  opp({ id: "o1", adId: "100", stage: "Cita", attributionUrl: "https://ig.me/m/abc" }),
  opp({ id: "o2", adId: "100", stage: "Nuevo", attributionUrl: "https://ig.me/m/abc" }),
  opp({ id: "o3", adId: "100", stage: "Perdido", status: "lost", attributionUrl: "https://fb.me/xyz" }),
  opp({ id: "o4", adId: "200", stage: "Ganado", status: "won" }),
  // TikTok sin ad id: nombre de pauta en custom field, tráfico pagado por source.
  opp({ id: "o5", source: "tiktok", stage: "Nuevo", customFieldsResolved: { "Nombre pauta": "TIKTOK VERANO" } }),
  // Ad id propio que Meta no conoce, pero el contacto trae uno que sí (o7 abajo).
  opp({ id: "o6", adId: "999", contactId: "c-o7", stage: "Cita" }),
  opp({ id: "o7", adId: "200", contactId: "c-o7", stage: "Cita" }),
];
const contacts: Contact[] = opportunities.map((o) => contact({ id: o.contactId }));
const pautas: Pauta[] = [];
const appointments: Appointment[] = [
  appt("a1", "c-o1", "showed"),
  appt("a2", "c-o1", "confirmed"), // segunda cita del mismo contacto
  appt("a3", "c-o2", "confirmed"),
  appt("a4", "c-o5", "showed"),
];

function build(withMeta: boolean, over: Partial<Parameters<typeof buildPaidPerformance>[0]> = {}): PaidGroup[] {
  const data = withMeta ? meta : EMPTY_META;
  const index = buildMetaIndex(data);
  const ctx = buildAttributionContext({ index, contacts, opportunities, pautas });
  return buildPaidPerformance({
    opportunities,
    contacts,
    appointments,
    pipelines,
    pautaNameByContact: new Map(),
    ctx,
    groupBy: "campaign",
    includeLost: true,
    meta: withMeta ? { data, range: { since: "2026-08-01", until: "2026-08-31" } } : null,
    ...over,
  });
}

const byLabel = (groups: PaidGroup[], label: string) => {
  const g = groups.find((x) => x.label === label);
  assert.ok(g, `falta el grupo "${label}" en ${groups.map((x) => x.label).join(" | ")}`);
  return g;
};

async function main() {
  // ── 3. Lo que no cruza con Meta sobrevive, sin costos ────────────────────
  {
    const groups = build(true);
    const tiktok = byLabel(groups, "TIKTOK VERANO");
    assert.equal(tiktok.crmOnly, true);
    assert.equal(tiktok.spend, null);
    assert.equal(tiktok.cpl, null);
    assert.equal(tiktok.opportunities, 1);
    assert.equal(tiktok.children.length, 1);
    assert.equal(tiktok.children[0].key, NO_AD_KEY);
    assert.deepEqual(tiktok.children[0].oppIds, ["o5"]);
  }

  // ── 4. La barra de etapas suma Opps, con y sin perdidas ──────────────────
  {
    const withLost = byLabel(build(true), "CAMPAÑA A");
    assert.equal(withLost.opportunities, 5); // o1 o2 o3 o4 o7 (o6 va por su contacto → ad 200)
    assert.equal(withLost.stages.reduce((a, s) => a + s.count, 0), withLost.opportunities);
    assert.ok(withLost.stages.some((s) => s.lost && s.stage === "Perdido" && s.count === 1));
    assert.deepEqual(withLost.stages.map((s) => s.stage), ["Nuevo", "Cita", "Ganado", "Perdido"], "orden del pipeline");

    const noLost = byLabel(build(true, { includeLost: false }), "CAMPAÑA A");
    assert.equal(noLost.opportunities, 4);
    assert.equal(noLost.stages.reduce((a, s) => a + s.count, 0), 4);
    assert.ok(!noLost.stages.some((s) => s.lost));
    assert.ok(!noLost.oppIds.includes("o3"), "la perdida sale también de oppIds");
  }

  // ── 6. Citas cuenta CONTACTOS; Efectivas solo showed ─────────────────────
  {
    const a = byLabel(build(true), "CAMPAÑA A");
    // c-o1 (2 citas → 1), c-o2 (1) = 2 contactos con cita; showed solo c-o1.
    assert.equal(a.appointments, 2);
    assert.equal(a.showed, 1);
    assert.deepEqual([...a.apptContactIds].sort(), ["c-o1", "c-o2"]);
    const t = byLabel(build(true), "TIKTOK VERANO");
    assert.equal(t.appointments, 1);
    assert.equal(t.showed, 1);
  }

  // ── 5. Sin Meta salen las mismas filas del CRM, sin inversión ────────────
  {
    const groups = build(false);
    for (const g of groups) {
      assert.equal(g.crmOnly, true);
      assert.equal(g.spend, null);
      assert.equal(g.impressions, null);
      assert.equal(g.leadsMeta, null);
      for (const c of g.children) assert.equal(c.spend, null);
    }
    // Sin Meta no hay jerarquía: la campaña es el headline del CRM. Las opps de
    // los ads 100/200 no traen nombre de pauta → "Sin nombre", con un hijo por ad id.
    const sinNombre = byLabel(groups, "Sin nombre");
    assert.deepEqual([...sinNombre.children.map((c) => c.key)].sort(), ["100", "200", "999"].sort());
    assert.equal(groups.reduce((a, g) => a + g.opportunities, 0), 7);
  }

  console.log("verify:paid-performance ✓ (3, 4, 5, 6)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

Nota sobre la aserción 5: sin Meta, `resolveOppAdId(o6)` devuelve `"999"` (su propio id
crudo, porque `resolveChain` prefiere el primero cuando ninguno está en Meta), así que
o6 es un hijo `999`, no `200`. Con Meta (aserción 7, Task 2) la cadena lo manda a `200`.

Agregar a `package.json`, después de `"verify:pmi-ledger"`:

```json
    "verify:paid-performance": "tsx scripts/verify-paid-performance.ts",
```

- [ ] **Step 2: Correr y ver que falla**

Run: `pnpm verify:paid-performance`
Expected: falla con `Cannot find module '../lib/paid-performance'`.

- [ ] **Step 3: Escribir el motor (universo del CRM; Meta se conecta en Task 2)**

Crear `lib/paid-performance.ts`:

```ts
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
  // Inversión (Task 2)
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

function ratio(n: number | null, d: number | null): number | null {
  return n === null || d === null || d <= 0 ? null : n / d;
}

// ── Motor ───────────────────────────────────────────────────────────────────

export function buildPaidPerformance(p: PaidPerformanceInput): PaidGroup[] {
  const { ctx } = p;
  const groups = new Map<string, GroupBucket>();

  const groupFor = (key: string, label: string, crmOnly: boolean): GroupBucket => {
    let g = groups.get(key);
    if (!g) {
      g = { ...newBucket(key, label, null, crmOnly), children: new Map() };
      groups.set(key, g);
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

  // El grupo de una oportunidad: la campaña de Meta si su anuncio cruza; el
  // headline de la pauta del CRM si no; o su origen en modo "platform".
  const groupKeyOf = (opp: Opportunity, adId: string | null): { key: string; label: string; crmOnly: boolean } => {
    if (p.groupBy === "platform") {
      const label = platformLabel(opp);
      return { key: `platform:${label}`, label, crmOnly: !(adId && ctx.index.byAd.has(adId)) };
    }
    const hit = adId ? ctx.index.byAd.get(adId) : undefined;
    if (hit?.campaign) return { key: `meta:${hit.campaign.id}`, label: hit.campaign.name, crmOnly: false };
    if (hit) return { key: ORPHAN_KEY, label: ORPHAN_LABEL, crmOnly: false };
    const name = resolveCampaignName(opp, p.pautaNameByContact);
    const headline = name ? campaignHeadline(name) : SIN_NOMBRE;
    return { key: `crm:${headline}`, label: headline, crmOnly: true };
  };

  // Paso 1 — oportunidades. Cada una decide el grupo y el hijo de su contacto.
  const placementByContact = new Map<string, { group: GroupBucket; child: Bucket }>();
  for (const opp of p.opportunities) {
    if (classifyLead(opp, ctx) === "notPauta") continue;
    const lost = opp.status === "lost";
    if (lost && !p.includeLost) continue;
    const adId = resolveOppAdId(opp, ctx);
    const gk = groupKeyOf(opp, adId);
    const g = groupFor(gk.key, gk.label, gk.crmOnly);
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
      const hit = adId ? ctx.index.byAd.get(adId) : undefined;
      let gk: { key: string; label: string; crmOnly: boolean };
      if (p.groupBy === "platform") {
        const anyOpp = (ctx.oppsByContact.get(c.id) ?? [])[0];
        const label = anyOpp ? platformLabel(anyOpp) : "Otro";
        gk = { key: `platform:${label}`, label, crmOnly: !hit };
      } else if (hit?.campaign) {
        gk = { key: `meta:${hit.campaign.id}`, label: hit.campaign.name, crmOnly: false };
      } else if (hit) {
        gk = { key: ORPHAN_KEY, label: ORPHAN_LABEL, crmOnly: false };
      } else {
        const name = p.pautaNameByContact.get(c.id);
        const headline = name ? campaignHeadline(name) : SIN_NOMBRE;
        gk = { key: `crm:${headline}`, label: headline, crmOnly: true };
      }
      const g = groupFor(gk.key, gk.label, gk.crmOnly);
      placed = { group: g, child: childFor(g, adId) };
    }
    for (const b of [placed.group, placed.child]) {
      b.contactIds.add(c.id);
      b.rowContacts.add(c.id);
    }
  }

  // Paso 3 — inversión de Meta (Task 2 la llena; en "platform" no aplica).
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
      cpm: mixed ? null : (b.impressions ? ratio(b.spend, b.impressions)! * 1000 : null),
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

// Task 2 la implementa. Firma fija aquí para que el paso 3 compile.
function attachMeta(
  _groups: Map<string, GroupBucket>,
  _groupFor: (key: string, label: string, crmOnly: boolean) => GroupBucket,
  _childFor: (g: GroupBucket, adId: string | null) => Bucket,
  _meta: { data: MetaAdsData; range: DayRange },
  _ctx: AttributionContext
): void {}

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
```

`defaultCurrency` y `buildMetaReport` quedan importados sin uso hasta Task 2; ESLint lo
marca como warning, no como error. Si `pnpm lint` lo trata como error, quitar la
importación en este paso y volver a ponerla en Task 2.

- [ ] **Step 4: Correr y ver que pasa**

Run: `pnpm verify:paid-performance`
Expected: `verify:paid-performance ✓ (3, 4, 5, 6)`.

Si la aserción 4 falla en `opportunities === 5`: o6 tiene `adId: "999"` (no está en
Meta) y `contactId: "c-o7"`; `resolveOppAdId` debe devolver `"200"` vía el contacto, cuya
cadena mira `ctx.oppsByContact.get("c-o7")` → `[o6, o7]` → `oppAdId(o7) = "200"` está en
Meta. Si devuelve `"999"`, revisa que `buildAttributionContext` recibió `opportunities`.

- [ ] **Step 5: Tipos y commit**

Run: `npx tsc --noEmit`
Expected: sin errores.

```bash
git add lib/paid-performance.ts scripts/verify-paid-performance.ts package.json
git commit -m "feat(pauta): motor de rendimiento de pauta — universo del CRM, etapas y citas

buildPaidPerformance agrupa oportunidades y contactos por anuncio (ad id de la
cadena de atribución) y por campaña o origen; suma etapas y contactos con cita.
Sin Meta corre con un índice vacío. verify:paid-performance fija 3, 4, 5 y 6.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 2: Motor — la inversión de Meta encima

**Files:**
- Modify: `lib/paid-performance.ts` (la función `attachMeta`)
- Modify: `scripts/verify-paid-performance.ts` (aserciones 1, 2, 7)

**Interfaces:**
- Consumes: `buildMetaReport({ contacts: [], opportunities: [], meta, index, range, ctx, groupBy: "ad" })`
  → `MetaReportRow[]` con `key` = ad id, `spend`, `impressions`, `clicks`, `leadsMeta`,
  `currency` (`"?"` si mezclada).
- Produces: `PaidRow.spend/impressions/clicks/leadsMeta/currency/cpm/ctr/cpl/cpa` no nulos
  en filas de Meta; hijos "solo Meta" (gasto sin leads) presentes.

- [ ] **Step 1: Agregar las aserciones 1, 2 y 7 al script**

En `scripts/verify-paid-performance.ts`, antes de `console.log(...)`:

```ts
  // ── 1. El gasto por campaña es IDÉNTICO al de buildMetaReport ────────────
  {
    const index = buildMetaIndex(meta);
    const ctx = buildAttributionContext({ index, contacts, opportunities, pautas });
    const range = { since: "2026-08-01", until: "2026-08-31" };
    const reference = buildMetaReport({ contacts, opportunities, meta, index, range, ctx, groupBy: "campaign" });
    const groups = build(true);
    for (const ref of reference) {
      const g = byLabel(groups, ref.label);
      assert.equal(g.spend, ref.spend, `gasto de ${ref.label}`);
      assert.equal(g.impressions, ref.impressions, `impresiones de ${ref.label}`);
      assert.equal(g.clicks, ref.clicks, `clics de ${ref.label}`);
      assert.equal(g.leadsMeta, ref.leadsMeta, `leads Meta de ${ref.label}`);
      assert.equal(g.currency, "MXN");
      assert.equal(g.crmOnly, false);
    }
    const a = byLabel(groups, "CAMPAÑA A");
    assert.equal(a.spend, 150.5);
    assert.equal(a.cpm, (150.5 / 1500) * 1000);
    assert.equal(a.ctr, 70 / 1500);
    // CPL = gasto ÷ contactos de la fila (o1 o2 o3 o4 o7 → 5 leads; c-o7 una vez).
    assert.equal(a.leadsCrm, 5);
    assert.equal(a.cpl, 150.5 / 5);
    assert.equal(a.cpa, 150.5 / 1);
    // El hijo suma al grupo: 100 + 50.5.
    assert.equal(a.children.reduce((s, c) => s + (c.spend ?? 0), 0), a.spend);
  }

  // ── 2. Un anuncio con gasto y sin leads existe como hijo ─────────────────
  {
    const b = byLabel(build(true), "CAMPAÑA B");
    assert.equal(b.spend, 75.25);
    assert.equal(b.opportunities, 0);
    assert.equal(b.leadsCrm, 0);
    assert.equal(b.cpl, null, "sin denominador no hay CPL");
    assert.equal(b.children.length, 1);
    assert.equal(b.children[0].adId, "300");
    assert.equal(b.children[0].crmOnly, false);
    assert.deepEqual(b.children[0].stages, []);
  }

  // ── 7. La cadena manda sobre el campo crudo ──────────────────────────────
  {
    const a = byLabel(build(true), "CAMPAÑA A");
    const ad200 = a.children.find((c) => c.adId === "200");
    assert.ok(ad200);
    assert.ok(ad200.oppIds.includes("o6"), "o6 (adId 999, contacto con 200) cae bajo el ad 200");
    assert.ok(!a.children.some((c) => c.adId === "999"));
  }

  // ── 12. En modo Origen no hay inversión ──────────────────────────────────
  {
    const groups = build(true, { groupBy: "platform" });
    assert.ok(groups.length > 0);
    for (const g of groups) assert.equal(g.spend, null);
    assert.equal(groups.reduce((s, g) => s + g.opportunities, 0), 7);
  }
```

Y cambiar el `console.log` final a `"verify:paid-performance ✓"`.

- [ ] **Step 2: Correr y ver que falla**

Run: `pnpm verify:paid-performance`
Expected: falla en la aserción 1 con `gasto de CAMPAÑA A` (`null !== 150.5`).

- [ ] **Step 3: Implementar `attachMeta`**

Reemplazar el stub en `lib/paid-performance.ts`:

```ts
// El gasto por anuncio sale de buildMetaReport({ groupBy: "ad" }) — el MISMO motor
// de la herramienta del asistente — con contactos y opps vacíos: aquí solo
// queremos lo que Meta sabe (gasto, impresiones, clics, leads que reporta); los
// leads del CRM ya los contó el paso 2 con la misma cadena. Los hijos de una
// campaña son la UNIÓN de sus anuncios en Meta y los ad ids del CRM: un anuncio
// que gasta y no trae leads aparece con opps en 0, o la suma de los hijos no
// daría el gasto de la campaña.
function attachMeta(
  groups: Map<string, GroupBucket>,
  groupFor: (key: string, label: string, crmOnly: boolean) => GroupBucket,
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
      ? groupFor(`meta:${hit.campaign.id}`, hit.campaign.name, false)
      : groupFor(ORPHAN_KEY, ORPHAN_LABEL, false);
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
```

Nota: un grupo `crm:` (headline del CRM) nunca tiene hijos con inversión, porque un ad id
que está en Meta siempre cae en un grupo `meta:`; `g.crmOnly = false` ahí solo confirma lo
que `groupFor` ya puso.

- [ ] **Step 4: Correr y ver que pasa**

Run: `pnpm verify:paid-performance`
Expected: `verify:paid-performance ✓`.

Si falla la igualdad de `cpm`/`ctr` por flotantes: la aserción compara la misma
expresión (`spend / impressions * 1000`), así que debe ser exacta; si no, `finish` está
calculando `ratio(...) * 1000` en otro orden — igualar el orden de operaciones.

- [ ] **Step 5: Tipos, lint y commit**

Run: `npx tsc --noEmit && pnpm lint`
Expected: sin errores (warnings de `any` preexistentes aparte).

```bash
git add lib/paid-performance.ts scripts/verify-paid-performance.ts
git commit -m "feat(pauta): inversión de Meta por anuncio encima del universo del CRM

Los hijos de una campaña de Meta son la unión de sus anuncios y los ad ids del
CRM; el gasto por grupo es idéntico al de buildMetaReport por campaña (aserción 1).
En modo Origen no hay inversión: un anuncio produce opps de varios orígenes.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 3: `CopyButton` y `LinkButton` a `dashboard-ui.tsx`

**Files:**
- Modify: `components/dashboard/dashboard-ui.tsx` (agregar al final)
- Modify: `components/dashboard/marketing-dashboard.tsx:300-332` (quitar las dos funciones), `:23` (imports), `:53` (import de dashboard-ui)

**Interfaces:**
- Produces: `export function CopyButton({ value }: { value: string })`,
  `export function LinkButton({ value }: { value: string })` en `dashboard-ui.tsx`.

- [ ] **Step 1: Mover las funciones**

Al final de `components/dashboard/dashboard-ui.tsx`:

```tsx
// ── Acciones en línea para ids y ligas ──────────────────────────────────────
// Copiar y abrir, con stopPropagation para no disparar el drill de la fila.

export function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      className="ml-1.5 inline-flex shrink-0 items-center rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
      onClick={(e) => {
        e.stopPropagation()
        navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
      title={`Copiar: ${value}`}
    >
      {copied ? <Check className="h-3 w-3 text-green-500" /> : <Copy className="h-3 w-3" />}
    </button>
  )
}

export function LinkButton({ value }: { value: string }) {
  return (
    <a
      href={value}
      target="_blank"
      rel="noopener noreferrer"
      className="ml-1.5 inline-flex shrink-0 items-center rounded p-0.5 text-muted-foreground hover:text-foreground hover:bg-accent/30 transition-colors"
      title={value}
      onClick={(e) => e.stopPropagation()}
    >
      <ExternalLink className="h-3 w-3" />
    </a>
  )
}
```

En la cabecera de `dashboard-ui.tsx` asegurar `import { useState } from "react"` (si el
archivo ya importa de `react`, agregar `useState` a esa línea) y `Check`, `Copy`,
`ExternalLink` en la importación de `lucide-react`.

En `marketing-dashboard.tsx`: borrar las funciones `CopyButton` (líneas 300–317) y
`LinkButton` (319–332); agregar `CopyButton, LinkButton` a la importación de
`./dashboard-ui` (línea ~53); quitar `Copy, Check, ExternalLink` de la importación de
`lucide-react` si ya nadie los usa (`grep -n "Copy\b\|Check\b\|ExternalLink" components/dashboard/marketing-dashboard.tsx`).

- [ ] **Step 2: Verificar y commitear**

Run: `npx tsc --noEmit && pnpm lint`
Expected: sin errores.

```bash
git add components/dashboard/dashboard-ui.tsx components/dashboard/marketing-dashboard.tsx
git commit -m "refactor(ui): CopyButton y LinkButton a dashboard-ui

La tabla de rendimiento de pauta los necesita fuera de marketing-dashboard.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 4: `useMetaInvestment` recibe el contexto; la sección se vuelve tiles

**Files:**
- Modify: `components/dashboard/meta-investment-section.tsx:130-190` (hook), `:194-363` (UI)
- Modify: `components/dashboard/marketing-dashboard.tsx:608-618` (llamada), `:1470` (render), `:41` (import), `:1194` y `:1434` (PDF)

**Interfaces:**
- Consumes: `buildMetaIndex`, `buildAttributionContext`, `EMPTY_META` (Task 1).
- Produces:
  - `useMetaInvestment(p: { metaAds; contacts; opportunities; ctx: AttributionContext; dateRange; attributeFiltersActive }): MetaInvestment | null`
    — ya no recibe `allContacts/allOpportunities/allPautas`.
  - `MetaInvestmentTiles({ inv, onDrill }: { inv: MetaInvestment; onDrill: (d: DrillState) => void })`
    — los seis tiles + la línea de impresiones/clics/CPM/CTR, **sin** `DashboardCard` ni tabla.
  - `metaScopeNote(inv, status): ReactNode` — el texto del tooltip que hoy vive en
    `scopeTooltip`, exportado para que la tarjeta nueva lo use.
  - `money`, `pct`, `metaCoverKpis` siguen igual. `buildMetaReportSection` se borra.
  - En `marketing-dashboard.tsx`: `const attribution = useMemo(() => ({ index, ctx }), …)`.

- [ ] **Step 1: Cambiar el hook**

En `meta-investment-section.tsx`, reemplazar la firma y las dos primeras `useMemo` de
`useMetaInvestment`:

```ts
export function useMetaInvestment(p: {
  metaAds: MetaAdsData | null | undefined
  /** Ya filtrados por fecha Y atributos: el rango se vuelve a aplicar adentro. */
  contacts: Contact[]
  opportunities: Opportunity[]
  /** Del historial completo, construido UNA vez en marketing-dashboard y compartido
   *  con buildPaidPerformance: dos contextos podrían resolver un ad id distinto. */
  ctx: AttributionContext
  dateRange: ResolvedDateRange | null | undefined
  attributeFiltersActive: boolean
}): MetaInvestment | null {
  const { metaAds, contacts, opportunities, ctx, dateRange, attributeFiltersActive } = p
  const index = ctx.index
```

Borrar las `useMemo` de `index` y `ctx`; el resto del hook queda igual (sus deps ya
nombran `index` y `ctx`). Importar `type AttributionContext` de `@/lib/meta-attribution`
y quitar `buildAttributionContext`, `buildMetaIndex` y `type Pauta` si quedan sin uso.

- [ ] **Step 2: Convertir la sección en tiles**

Reemplazar todo desde `// ── UI ───` hasta el final del archivo por:

```tsx
// ── UI ──────────────────────────────────────────────────────────────────────
// Solo los tiles: la tabla vive en paid-performance-table.tsx, que compone
// estos tiles arriba cuando hay Meta.

export function metaScopeNote(inv: MetaInvestment, status?: MetaAdsStatus): ReactNode {
  const s = inv.summary
  return (
    <>
      Cohorte por fecha de creación: el gasto de la ventana contra los contactos creados en ella cuyo anuncio está en Meta (oportunidad → objeto Pauta → primera atribución → última). Oportunidades y ganadas son el embudo debajo.
      El gasto sigue solo al filtro de fecha; los filtros de atributo recortan leads y ganadas.
      {inv.costsSuppressed && " — Con filtros de atributo activos CPL y CPA no se calculan."}
      {s.mixedCurrency && " Las cuentas mezclan monedas: los costos no se consolidan."}
      {s.unknownAdLeads > 0 && ` ${int(s.unknownAdLeads)} leads traen un anuncio fuera de las cuentas asignadas.`}
      {status?.state === "partial" && ` Sin respuesta en el último sync: ${status.failedAccounts.map((f) => f.id).join(", ")}.`}
      {status?.state === "error" && " Meta no respondió en el último sync: gasto del último sync bueno."}
    </>
  )
}

export function MetaInvestmentTiles({ inv, onDrill }: { inv: MetaInvestment; onDrill: (d: DrillState) => void }) {
  const { summary: s, rows, costsSuppressed } = inv
  const currency = s.currency ?? "?"
  const cplShown = costsSuppressed || s.mixedCurrency ? null : s.cpl
  const cpaShown = costsSuppressed || s.mixedCurrency ? null : s.cpa
  const spendLabel = s.mixedCurrency
    ? Object.entries(s.spendByCurrency).map(([c, v]) => money(v, c)).join(" · ")
    : money(s.spend, currency)

  const drillOpps = (title: string, opps: Opportunity[], subtitle?: string) =>
    onDrill({ open: true, title, subtitle, opportunities: opps })
  const drillContacts = (title: string, items: Contact[], subtitle?: string) =>
    onDrill({ open: true, title, subtitle, opportunities: [], contactItems: items })

  return (
    <>
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {/* … los seis <SummaryTile> EXACTAMENTE como están hoy (Gasto, Leads CRM, CPL,
            Oportunidades, Ganadas, CPA), incluido el onClick del tile Gasto que hace
            scrollIntoView a "meta-campaign-table" — la tarjeta nueva conserva ese id. */}
      </div>
      <p className="mt-3 text-[11px] tabular-nums text-muted-foreground">
        Impresiones {int(rows.reduce((a, r) => a + r.impressions, 0))} · Clics {int(rows.reduce((a, r) => a + r.clicks, 0))} · CPM{" "}
        {s.mixedCurrency ? "—" : money(cpmOf(rows), currency)} · CTR {pct(ctrOf(rows))}
      </p>
    </>
  )
}

function cpmOf(rows: MetaReportRow[]): number | null {
  const imp = rows.reduce((a, r) => a + r.impressions, 0)
  const spend = rows.reduce((a, r) => a + r.spend, 0)
  return imp > 0 ? (spend / imp) * 1000 : null
}

function ctrOf(rows: MetaReportRow[]): number | null {
  const imp = rows.reduce((a, r) => a + r.impressions, 0)
  return imp > 0 ? rows.reduce((a, r) => a + r.clicks, 0) / imp : null
}
```

Copiar los seis `SummaryTile` tal cual del código actual (líneas 236–281 del archivo de
hoy) dentro del `div` del grid. Borrar `TABLE_COLS`, `buildMetaReportSection` y las
importaciones que queden sin uso (`Table*`, `TopNSlider`, `DashboardCard`,
`ChartCardHeader`, `ScopePill`, `useState`, `type ReportSection`). Agregar
`import type { ReactNode } from "react"`. El comentario de cabecera del archivo debe
decir que la tabla vive en `paid-performance-table.tsx`.

- [ ] **Step 3: Construir el contexto una vez en `marketing-dashboard.tsx`**

Sustituir la llamada a `useMetaInvestment` (líneas 608–618) por:

```tsx
  // El contexto de atribución se construye UNA vez por payload y lo comparten los
  // tiles de Meta y la tabla de rendimiento: dos contextos podrían resolver un ad
  // id distinto. Sin Meta el índice está vacío y la cadena devuelve el id crudo.
  const attributionCtx = useMemo(
    () =>
      buildAttributionContext({
        index: buildMetaIndex(metaAds ?? EMPTY_META),
        contacts: lookupContacts,
        opportunities: lookupOpportunities,
        pautas: rankingPautas,
      }),
    [metaAds, lookupContacts, lookupOpportunities, rankingPautas]
  )

  // Inversión en pauta (Meta): tiles y KPIs de portada del PDF.
  const metaInv = useMetaInvestment({
    metaAds,
    contacts,
    opportunities,
    ctx: attributionCtx,
    dateRange,
    attributeFiltersActive: filtersLabel !== undefined,
  })
```

Imports nuevos: `import { buildAttributionContext, buildMetaIndex } from "@/lib/meta-attribution"`
y `import { EMPTY_META } from "@/lib/paid-performance"`. En la línea 41 cambiar
`MetaInvestmentSection, useMetaInvestment, buildMetaReportSection, metaCoverKpis` por
`MetaInvestmentTiles, useMetaInvestment, metaCoverKpis, metaScopeNote`.

Para que compile en este paso (la tarjeta nueva llega en Task 5), dejar temporalmente en
la línea 1470:

```tsx
      {metaInv && (
        <DashboardCard>
          <ChartCardHeader title="Inversión en pauta" icon={Coins} actions={<ScopePill label="cohorte por fecha" tooltip={metaScopeNote(metaInv, metaAdsStatus)} />} />
          <MetaInvestmentTiles inv={metaInv} onDrill={setDrill} />
        </DashboardCard>
      )}
```

(`Coins` de `lucide-react`.) Y en `buildReport` (línea 1194) borrar
`if (metaInv) sections.push(buildMetaReportSection(metaInv))` — la sección vuelve en
Task 7 desde el motor nuevo.

- [ ] **Step 4: Verificar y commitear**

Run: `npx tsc --noEmit && pnpm lint && pnpm verify:meta-attribution`
Expected: sin errores.

Run: `pnpm dev`, abrir Lezgo Suite → Marketing: los seis tiles siguen, sin tabla debajo.
Abrir Condesa: no aparece la tarjeta (todavía).

```bash
git add components/dashboard/meta-investment-section.tsx components/dashboard/marketing-dashboard.tsx
git commit -m "refactor(meta): contexto de atribución compartido; la sección de inversión queda en tiles

La tabla por campaña se va: la reemplaza la tabla de rendimiento de pauta.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 5: La tabla — filas expandibles, orden, Top N, buscador, toggles, drills

**Files:**
- Create: `components/dashboard/paid-performance-table.tsx`
- Modify: `components/dashboard/marketing-dashboard.tsx:1470` (render), estado nuevo junto a la línea 630

**Interfaces:**
- Consumes: `buildPaidPerformance`, `sumRows`, `PaidGroup`, `PaidRow`, `PaidGroupBy`,
  `NO_AD_KEY` (Task 1); `MetaInvestment`, `MetaInvestmentTiles`, `metaScopeNote`, `money`,
  `pct` (Task 4); `CopyButton`, `LinkButton`, `DashboardCard`, `ChartCardHeader`,
  `ScopePill`, `TopNSlider`, `ChartEmpty`, `ChartHint` (`dashboard-ui.tsx`); `DrillState`.
- Produces:

```ts
export type PaidColumnId =
  | "spend" | "impressions" | "clicks" | "cpm" | "ctr"
  | "leadsMeta" | "leadsCrm" | "opportunities" | "won" | "cpl" | "cpa"
  | "appointments" | "showed" | "stages"
export const PAID_COLUMNS: { id: PaidColumnId; label: string; group: "inversion" | "leads" | "citas" | "etapas"; meta: boolean; defaultOn: boolean }[]
export function usePaidPerformance(p: PaidPerformanceInput): PaidGroup[]
export interface PaidPerformanceTableProps {
  groups: PaidGroup[]
  groupBy: PaidGroupBy
  onGroupByChange: (v: PaidGroupBy) => void
  includeLost: boolean
  onIncludeLostChange: (v: boolean) => void
  hasMeta: boolean
  costsSuppressed: boolean
  metaInv: MetaInvestment | null
  status?: MetaAdsStatus
  /** Ventana (para resolver oppIds/contactIds) e historial (para los joins del drawer). */
  opportunities: Opportunity[]
  contacts: Contact[]
  allOpportunities: Opportunity[]
  onDrill: (d: DrillState) => void
}
export function PaidPerformanceTable(props: PaidPerformanceTableProps): JSX.Element
```

- [ ] **Step 1: Escribir el componente (sin editor de columnas ni barra de etapas — Tasks 6 y 7)**

Crear `components/dashboard/paid-performance-table.tsx`:

```tsx
// components/dashboard/paid-performance-table.tsx
// "Inversión y rendimiento de pauta": UNA tarjeta que reemplaza a la tabla de
// inversión de Meta y a las gráficas de etapa, ID de anuncio, URL y citas por
// pauta. Filas expandibles campaña → anuncios (ID con copiar, URL con abrir);
// toggle Campaña | Origen; buscador; Top N; toggle Perdidas; editor de columnas;
// barra de etapas por fila; cada número abre sus registros.
//
// Todo el cálculo está en lib/paid-performance.ts (puro). Aquí solo hay estado
// de vista: orden, expansión, columnas visibles, búsqueda. La sección del PDF
// (buildPaidReportSection) se construye en este archivo para que pantalla y
// papel no puedan divergir en qué es "rendimiento de pauta".
//
// Spec: docs/superpowers/specs/2026-09-19-pauta-rendimiento-unificado-design.md
"use client"

import { useMemo, useState, type ReactNode } from "react"
import { ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Coins, Search, Facebook, Instagram, Link2 } from "lucide-react"
import {
  ChartCardHeader,
  ChartEmpty,
  ChartHint,
  CopyButton,
  DashboardCard,
  LinkButton,
  ScopePill,
  TopNSlider,
} from "@/components/dashboard/dashboard-ui"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { DrillState } from "@/components/dashboard/chart-drill-drawer"
import type { Contact, MetaAdsStatus, Opportunity } from "@/lib/types"
import {
  buildPaidPerformance,
  sumRows,
  NO_AD_KEY,
  type PaidGroup,
  type PaidGroupBy,
  type PaidPerformanceInput,
  type PaidRow,
} from "@/lib/paid-performance"
import { MetaInvestmentTiles, metaScopeNote, money, pct, type MetaInvestment } from "./meta-investment-section"
import { isWonOpp } from "@/lib/opportunity-status"

// ── Columnas ────────────────────────────────────────────────────────────────

export type PaidColumnId =
  | "spend" | "impressions" | "clicks" | "cpm" | "ctr"
  | "leadsMeta" | "leadsCrm" | "opportunities" | "won" | "cpl" | "cpa"
  | "appointments" | "showed" | "stages"

export const PAID_COLUMNS: { id: PaidColumnId; label: string; group: "inversion" | "leads" | "citas" | "etapas"; meta: boolean; defaultOn: boolean }[] = [
  { id: "spend", label: "Gasto", group: "inversion", meta: true, defaultOn: true },
  { id: "impressions", label: "Impr.", group: "inversion", meta: true, defaultOn: false },
  { id: "clicks", label: "Clics", group: "inversion", meta: true, defaultOn: false },
  { id: "cpm", label: "CPM", group: "inversion", meta: true, defaultOn: false },
  { id: "ctr", label: "CTR", group: "inversion", meta: true, defaultOn: true },
  { id: "leadsMeta", label: "Leads Meta", group: "leads", meta: true, defaultOn: true },
  { id: "leadsCrm", label: "Leads CRM", group: "leads", meta: false, defaultOn: true },
  { id: "opportunities", label: "Opps", group: "leads", meta: false, defaultOn: true },
  { id: "won", label: "Ganadas", group: "leads", meta: false, defaultOn: true },
  { id: "cpl", label: "CPL", group: "leads", meta: true, defaultOn: true },
  { id: "cpa", label: "CPA", group: "leads", meta: true, defaultOn: true },
  { id: "appointments", label: "Citas", group: "citas", meta: false, defaultOn: true },
  { id: "showed", label: "Efectivas", group: "citas", meta: false, defaultOn: true },
  { id: "stages", label: "Etapas", group: "etapas", meta: false, defaultOn: true },
]

const MONEY_COLS = new Set<PaidColumnId>(["spend", "cpm", "cpl", "cpa"])
const OTRAS_KEY = "__otras"

// ── Hook ────────────────────────────────────────────────────────────────────

export function usePaidPerformance(p: PaidPerformanceInput): PaidGroup[] {
  const { opportunities, contacts, appointments, pipelines, pautaNameByContact, ctx, groupBy, includeLost, meta } = p
  return useMemo(
    () => buildPaidPerformance({ opportunities, contacts, appointments, pipelines, pautaNameByContact, ctx, groupBy, includeLost, meta }),
    [opportunities, contacts, appointments, pipelines, pautaNameByContact, ctx, groupBy, includeLost, meta]
  )
}

// ── Formato ─────────────────────────────────────────────────────────────────

function int(n: number | null): string {
  return n === null ? "—" : n.toLocaleString("es-MX")
}

function shortUrl(href: string): string {
  try {
    const u = new URL(href)
    const slug = u.pathname.replace(/\/$/, "").split("/").pop() || ""
    const host = u.hostname.replace(/^www\./, "")
    const s = `${host}/${slug}`
    return s.length > 26 ? s.slice(0, 26) + "…" : s
  } catch {
    return href.length > 26 ? href.slice(0, 26) + "…" : href
  }
}

function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
}

// ── Controles ───────────────────────────────────────────────────────────────

function SegmentedToggle<T extends string>({ value, options, onChange }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="inline-flex shrink-0 rounded-md border border-border/60 p-0.5" role="group">
      {options.map((o) => (
        <button
          key={o.v}
          type="button"
          onClick={() => onChange(o.v)}
          className={`rounded px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide transition-colors ${value === o.v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function SwitchButton({ label, on, onChange }: { label: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      className="inline-flex shrink-0 items-center gap-1.5 text-[11px] font-medium tracking-wide text-muted-foreground hover:text-foreground transition-colors"
    >
      {label}
      <span className={`relative inline-flex h-3.5 w-6 shrink-0 rounded-full transition-colors duration-200 ${on ? "bg-amber-500" : "bg-muted-foreground/30"}`}>
        <span className={`absolute top-0.5 h-2.5 w-2.5 rounded-full bg-white shadow transition-transform duration-200 ${on ? "translate-x-2.5" : "translate-x-0.5"}`} />
      </span>
    </button>
  )
}

// ── Tabla ───────────────────────────────────────────────────────────────────

export interface PaidPerformanceTableProps {
  groups: PaidGroup[]
  groupBy: PaidGroupBy
  onGroupByChange: (v: PaidGroupBy) => void
  includeLost: boolean
  onIncludeLostChange: (v: boolean) => void
  hasMeta: boolean
  costsSuppressed: boolean
  metaInv: MetaInvestment | null
  status?: MetaAdsStatus
  /** Ventana (resuelve oppIds/contactIds) e historial (joins del drawer). */
  opportunities: Opportunity[]
  contacts: Contact[]
  allOpportunities: Opportunity[]
  onDrill: (d: DrillState) => void
}

type SortKey = Exclude<PaidColumnId, "stages">

export function PaidPerformanceTable(props: PaidPerformanceTableProps) {
  const { groups, groupBy, onGroupByChange, includeLost, onIncludeLostChange, hasMeta, costsSuppressed, metaInv, status, opportunities, contacts, allOpportunities, onDrill } = props
  const showMeta = hasMeta && groupBy === "campaign"

  const [query, setQuery] = useState("")
  const [topN, setTopN] = useState(15)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" } | null>(null)
  // Task 6 conecta el editor; hasta entonces, las columnas por defecto.
  const visibleCols = useMemo(
    () => new Set(PAID_COLUMNS.filter((c) => c.defaultOn && (showMeta || !c.meta)).map((c) => c.id)),
    [showMeta]
  )

  const effectiveSort: { key: SortKey; dir: "asc" | "desc" } = sort ?? { key: showMeta ? "spend" : "opportunities", dir: "desc" }

  // Moneda única de la tabla → al encabezado; mezclada → cada celda la suya.
  const tableCurrency = useMemo(() => {
    const set = new Set(groups.map((g) => g.currency).filter((c): c is string => !!c && c !== "?"))
    return set.size === 1 ? Array.from(set)[0] : null
  }, [groups])

  const oppById = useMemo(() => new Map(opportunities.map((o) => [o.id, o])), [opportunities])
  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts])

  // Orden → búsqueda → Top N. La búsqueda desactiva el Top N: quien busca quiere
  // ver lo que buscó, no el top de lo que buscó.
  const { visible, otras, total } = useMemo(() => {
    const dir = effectiveSort.dir === "asc" ? 1 : -1
    const val = (r: PaidRow) => (r[effectiveSort.key] as number | null) ?? -Infinity
    const byKey = (a: PaidRow, b: PaidRow) => (val(a) - val(b)) * dir || a.label.localeCompare(b.label)
    const sorted = [...groups].sort(byKey).map((g) => ({ ...g, children: [...g.children].sort(byKey) }))
    const q = fold(query.trim())
    const filtered = q ? sorted.filter((g) => fold(g.label).includes(q)) : sorted
    const cut = q || topN >= filtered.length ? filtered : filtered.slice(0, topN)
    const rest = filtered.slice(cut.length)
    return {
      visible: cut,
      otras: rest.length > 0 ? sumRows(rest, OTRAS_KEY, `Otras (${rest.length})`) : null,
      total: filtered.length,
    }
  }, [groups, effectiveSort, query, topN])

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s?.key === key ? { key, dir: s.dir === "desc" ? "asc" : "desc" } : { key, dir: "desc" }))

  const toggleExpanded = (key: string) =>
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })
  const allExpanded = visible.length > 0 && visible.every((g) => g.children.length <= 1 || expanded.has(g.key))
  const toggleAll = () => setExpanded(allExpanded ? new Set() : new Set(visible.filter((g) => g.children.length > 1).map((g) => g.key)))

  // ── Drills: cada número abre sus registros ────────────────────────────────
  const oppsOf = (ids: string[]) => ids.map((id) => oppById.get(id)).filter((o): o is Opportunity => !!o)
  const contactsOf = (ids: string[]) => ids.map((id) => contactById.get(id)).filter((c): c is Contact => !!c)
  const drillOpps = (row: PaidRow, title: string, ids: string[], subtitle?: string) =>
    onDrill({ open: true, title, subtitle: subtitle ?? row.label, opportunities: oppsOf(ids) })
  const drillContacts = (row: PaidRow, title: string) =>
    onDrill({ open: true, title, subtitle: row.label, opportunities: [], contactItems: contactsOf(row.contactIds) })
  const drillAppointments = (row: PaidRow, title: string) => {
    const set = new Set(row.apptContactIds)
    // Las opps de la fila cuyos contactos tienen cita; un contacto con cita y sin
    // opp en la ventana se resuelve contra el historial, como todo drawer.
    const inRow = oppsOf(row.oppIds).filter((o) => set.has(o.contactId))
    const seen = new Set(inRow.map((o) => o.contactId))
    const fromHistory = allOpportunities.filter((o) => set.has(o.contactId) && !seen.has(o.contactId))
    onDrill({ open: true, title, subtitle: row.label, opportunities: [...inRow, ...fromHistory] })
  }

  // ── Celdas ────────────────────────────────────────────────────────────────
  const cellMoney = (n: number | null, currency: string | null) =>
    n === null ? "—" : money(n, tableCurrency ? "?" : (currency ?? "?"))
  const colLabel = (c: (typeof PAID_COLUMNS)[number]) =>
    tableCurrency && MONEY_COLS.has(c.id) ? `${c.label} (${tableCurrency})` : c.label

  const numericCols = PAID_COLUMNS.filter((c) => visibleCols.has(c.id) && c.id !== "stages")
  const showStages = visibleCols.has("stages")

  const renderCell = (row: PaidRow, col: PaidColumnId, isOtras: boolean): ReactNode => {
    const suppressed = costsSuppressed && (col === "cpl" || col === "cpa")
    switch (col) {
      case "spend": return cellMoney(row.spend, row.currency)
      case "cpm": return isOtras ? "—" : cellMoney(row.cpm, row.currency)
      case "cpl": return isOtras || suppressed ? "—" : cellMoney(row.cpl, row.currency)
      case "cpa": return isOtras || suppressed ? "—" : cellMoney(row.cpa, row.currency)
      case "ctr": return isOtras ? "—" : pct(row.ctr)
      case "impressions": return int(row.impressions)
      case "clicks": return int(row.clicks)
      case "leadsMeta": return int(row.leadsMeta)
      case "leadsCrm":
        return <button type="button" className="tabular-nums hover:text-primary" onClick={(e) => { e.stopPropagation(); drillContacts(row, "Leads del CRM") }}>{int(row.leadsCrm)}</button>
      case "opportunities":
        return <button type="button" className="tabular-nums hover:text-primary" onClick={(e) => { e.stopPropagation(); drillOpps(row, "Oportunidades", row.oppIds) }}>{int(row.opportunities)}</button>
      case "won":
        return <button type="button" className="tabular-nums hover:text-primary" onClick={(e) => { e.stopPropagation(); drillOpps(row, "Ganadas", oppsOf(row.oppIds).filter(isWonOpp).map((o) => o.id)) }}>{int(row.won)}</button>
      case "appointments":
        return <button type="button" className="tabular-nums hover:text-primary" onClick={(e) => { e.stopPropagation(); drillAppointments(row, "Contactos con cita") }}>{int(row.appointments)}</button>
      case "showed":
        return <button type="button" className="tabular-nums hover:text-primary" onClick={(e) => { e.stopPropagation(); drillAppointments(row, "Citas efectivas") }}>{int(row.showed)}</button>
      case "stages":
        return null // Task 7
    }
  }

  const NameCell = ({ row, isChild, isOtras, expandable, isOpen }: { row: PaidRow; isChild: boolean; isOtras: boolean; expandable: boolean; isOpen: boolean }) => (
    <TableCell className={`max-w-[24rem] ${isChild ? "pl-9" : "font-medium"} ${isOtras ? "text-muted-foreground" : ""}`}>
      <div className="flex items-center gap-1.5">
        {!isChild && !isOtras && (
          expandable
            ? <button type="button" className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); toggleExpanded(row.key) }} aria-label={isOpen ? "Colapsar" : "Expandir"}>
                {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            : <span className="inline-block w-[18px] shrink-0" />
        )}
        {row.adId ? (
          <span className="inline-flex items-center font-mono text-xs">{row.adId}<CopyButton value={row.adId} /></span>
        ) : (
          <span className={`truncate ${row.key === NO_AD_KEY ? "italic text-muted-foreground" : ""}`} title={row.label}>{row.label}</span>
        )}
        {row.url && (
          <span className="ml-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            {row.url.platform === "facebook" ? <Facebook className="h-3 w-3 text-[#1877F2]" /> : row.url.platform === "instagram" ? <Instagram className="h-3 w-3 text-[#E1306C]" /> : <Link2 className="h-3 w-3" />}
            <span className="font-mono">{shortUrl(row.url.href)}</span>
            {row.url.others > 0 && <span>+{row.url.others}</span>}
            <LinkButton value={row.url.href} />
          </span>
        )}
        {!isChild && !isOtras && row.crmOnly && hasMeta && groupBy === "campaign" && (
          <span className="ml-1 shrink-0 rounded-full border border-border/60 px-1.5 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">sin Meta</span>
        )}
      </div>
    </TableCell>
  )

  const renderRow = (row: PaidRow, opts: { isChild: boolean; isOtras: boolean; expandable: boolean; isOpen: boolean }) => (
    <TableRow
      key={(opts.isChild ? "c:" : "g:") + row.key}
      className={`cursor-pointer ${opts.isChild ? "bg-muted/20 text-[13px]" : ""} ${opts.isOtras ? "text-muted-foreground" : ""}`}
      onClick={() => drillOpps(row, "Oportunidades", row.oppIds)}
    >
      <NameCell row={row} {...opts} />
      {numericCols.map((c) => (
        <TableCell key={c.id} className="whitespace-nowrap text-right tabular-nums">{renderCell(row, c.id, opts.isOtras)}</TableCell>
      ))}
      {showStages && <TableCell className="min-w-[10rem]">{renderCell(row, "stages", opts.isOtras)}</TableCell>}
    </TableRow>
  )

  const scopeLabel = costsSuppressed ? "sin costos con filtros" : groupBy === "platform" && hasMeta ? "sin gasto por origen" : hasMeta ? "cohorte por fecha" : "sin Meta"
  const scopeTooltip = (
    <>
      {metaInv ? metaScopeNote(metaInv, status) : "Pautas del CRM en la ventana (Meta, TikTok, Google), agrupadas por su anuncio. Conecta Meta desde el header para ver gasto, CPL y CPA."}
      {groupBy === "platform" && hasMeta && " En modo Origen no hay gasto: un anuncio produce oportunidades de varios orígenes y repartirlo sería inventar."}
      {" Citas cuenta contactos con al menos una cita en la ventana; Efectivas, con una cita 'showed'."}
    </>
  )

  return (
    <DashboardCard>
      <ChartCardHeader
        title="Inversión y rendimiento de pauta"
        icon={Coins}
        total={groups.reduce((a, g) => a + g.opportunities, 0)}
        actions={<ScopePill label={scopeLabel} tooltip={scopeTooltip} />}
      />

      {metaInv && groupBy === "campaign" && <MetaInvestmentTiles inv={metaInv} onDrill={onDrill} />}

      <div id="meta-campaign-table" className="mt-5 flex flex-wrap items-center gap-3">
        <SegmentedToggle value={groupBy} options={[{ v: "campaign", label: "Campaña" }, { v: "platform", label: "Origen" }]} onChange={onGroupByChange} />
        <label className="relative inline-flex items-center">
          <Search className="pointer-events-none absolute left-2 h-3 w-3 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={groupBy === "campaign" ? "Buscar campaña…" : "Buscar origen…"}
            className="h-7 w-44 rounded-md border border-border/60 bg-transparent pl-7 pr-2 text-xs outline-none focus:border-primary/60"
          />
        </label>
        <TopNSlider value={topN} max={groups.length} onChange={setTopN} disabled={query.trim().length > 0} />
        <SwitchButton label="Perdidas" on={includeLost} onChange={onIncludeLostChange} />
        <button type="button" onClick={toggleAll} className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground hover:text-foreground" title={allExpanded ? "Colapsar todo" : "Expandir todo"}>
          {allExpanded ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
          {allExpanded ? "Colapsar" : "Expandir"}
        </button>
        {/* Task 6: <ColumnEditor … /> */}
      </div>

      {groups.length === 0 ? (
        <ChartEmpty message="Sin oportunidades de pauta en la ventana." height={160} />
      ) : (
        <>
          <div className="mt-2 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[16rem]">{groupBy === "campaign" ? "Campaña / anuncio" : "Origen / anuncio"}</TableHead>
                  {numericCols.map((c) => (
                    <TableHead key={c.id} className="whitespace-nowrap text-right">
                      <button type="button" onClick={() => toggleSort(c.id as SortKey)} className={`inline-flex items-center gap-1 hover:text-foreground ${effectiveSort.key === c.id ? "text-foreground" : ""}`}>
                        {colLabel(c)}
                        {effectiveSort.key === c.id && <span aria-hidden>{effectiveSort.dir === "desc" ? "↓" : "↑"}</span>}
                      </button>
                    </TableHead>
                  ))}
                  {showStages && <TableHead>Etapas</TableHead>}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((g) => {
                  const expandable = g.children.length > 1
                  const isOpen = expandable && expanded.has(g.key)
                  // Un grupo con un solo hijo muestra el ID y la URL de ese hijo en su fila.
                  const shown: PaidRow = !expandable && g.children[0] ? { ...g, adId: g.children[0].adId, url: g.children[0].url } : g
                  return [
                    renderRow(shown, { isChild: false, isOtras: false, expandable, isOpen }),
                    ...(isOpen ? g.children.map((c) => renderRow(c, { isChild: true, isOtras: false, expandable: false, isOpen: false })) : []),
                  ]
                })}
                {otras && renderRow(otras, { isChild: false, isOtras: true, expandable: false, isOpen: false })}
              </TableBody>
            </Table>
          </div>
          <ChartHint>
            {`${total} ${groupBy === "campaign" ? "campañas" : "orígenes"}${query ? ` que contienen "${query.trim()}"` : topN < total ? ` · top ${topN}` : ""} · clic en una fila para ver sus oportunidades · expande una campaña para ver sus anuncios`}
          </ChartHint>
        </>
      )}
    </DashboardCard>
  )
}
```

La celda "Ganadas" usa `isWonOpp` (importar de `@/lib/opportunity-status`): es la misma
regla que `won` en el motor y que el KPI de Ventas — nunca el `status` crudo.

- [ ] **Step 2: Montar la tarjeta en `marketing-dashboard.tsx`**

Junto al resto del estado (línea ~630) agregar:

```tsx
  const [paidGroupBy, setPaidGroupBy] = useState<PaidGroupBy>("campaign")
  const [paidIncludeLost, setPaidIncludeLost] = useState(true)
```

Después de `metaInv` (Task 4, Step 3):

```tsx
  // Rendimiento de pauta: la tabla y su sección del PDF salen del mismo cálculo.
  const paidMetaInput = useMemo(
    () => (metaAds && metaInv ? { data: metaAds, range: metaInv.range } : null),
    [metaAds, metaInv]
  )
  const paidGroups = usePaidPerformance({
    opportunities,
    contacts,
    appointments,
    pipelines,
    pautaNameByContact,
    ctx: attributionCtx,
    groupBy: paidGroupBy,
    includeLost: paidIncludeLost,
    meta: paidMetaInput,
  })
```

`pautaNameByContact` se declara más abajo (línea ~677): mover el bloque de
`pautaContactIds` / `pautaNameByContact` / `isDePauta` (líneas ~668–686) ARRIBA de este
punto, justo después de `const [drill, setDrill]`. Son memos sin dependencias de lo que
está en medio.

Reemplazar el bloque temporal de Task 4 (línea 1470) por:

```tsx
      <PaidPerformanceTable
        groups={paidGroups}
        groupBy={paidGroupBy}
        onGroupByChange={setPaidGroupBy}
        includeLost={paidIncludeLost}
        onIncludeLostChange={setPaidIncludeLost}
        hasMeta={!!metaInv}
        costsSuppressed={filtersLabel !== undefined}
        metaInv={metaInv}
        status={metaAdsStatus}
        opportunities={opportunities}
        contacts={contacts}
        allOpportunities={lookupOpportunities}
        onDrill={setDrill}
      />
```

Imports: `import { PaidPerformanceTable, usePaidPerformance } from "./paid-performance-table"`
y `type PaidGroupBy` desde `@/lib/paid-performance` (junto a `EMPTY_META`). Quitar
`MetaInvestmentTiles`, `metaScopeNote`, `Coins` si quedan sin uso.

- [ ] **Step 3: Verificar en la app**

Run: `npx tsc --noEmit && pnpm lint`
Expected: sin errores.

Run: `pnpm dev` → Lezgo Suite → Marketing:
- La tarjeta muestra tiles + tabla. El **Gasto de "CAMPAÑA 26 OCT | NUEVO WHA" debe ser
  $22,023.12** (el de la tabla vieja en la captura del 2026-09-19) con el mismo rango.
- Expandir esa campaña: hijos con ID + copiar y URL + abrir.
- Clic en un número → drawer con los registros; Top N y buscador funcionan; ordenar por
  Opps invierte al segundo clic.
- Toggle Origen: sin columnas de gasto, píldora "sin gasto por origen".
Condesa → Marketing: la tarjeta existe, sin tiles ni columnas de Meta, píldora "sin Meta".

- [ ] **Step 4: Commit**

```bash
git add components/dashboard/paid-performance-table.tsx components/dashboard/marketing-dashboard.tsx
git commit -m "feat(pauta): tabla de inversión y rendimiento — campaña → anuncios, orden, Top N, buscador

Una tarjeta sobre buildPaidPerformance: filas expandibles con ID y URL por anuncio,
toggle Campaña | Origen, Perdidas, y cada número abre sus registros. Los tiles de
Meta van arriba cuando hay conexión.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 6: Editor de columnas con memoria en el navegador

**Files:**
- Modify: `components/dashboard/paid-performance-table.tsx`

**Interfaces:**
- Produces: `ColumnEditor({ available, value, onChange })` interno;
  `useVisibleColumns(showMeta): [Set<PaidColumnId>, (next: Set<PaidColumnId>) => void]`.

- [ ] **Step 1: Escribir el hook de persistencia y el editor**

Agregar en `paid-performance-table.tsx`, antes de `// ── Tabla ───`:

```tsx
// ── Columnas visibles ───────────────────────────────────────────────────────
// Conveniencia por navegador (localStorage), no estado del negocio: si la
// lectura falla —modo privado, datos borrados— se usan los defaults y ya.

const COLS_STORAGE_KEY = "paid-performance-cols"
const LOCKED_COLS = new Set<PaidColumnId>([])

function defaultColumns(): Set<PaidColumnId> {
  return new Set(PAID_COLUMNS.filter((c) => c.defaultOn).map((c) => c.id))
}

function readStoredColumns(): Set<PaidColumnId> | null {
  try {
    const raw = window.localStorage.getItem(COLS_STORAGE_KEY)
    if (!raw) return null
    const ids = new Set(PAID_COLUMNS.map((c) => c.id))
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return null
    return new Set(parsed.filter((x): x is PaidColumnId => typeof x === "string" && ids.has(x as PaidColumnId)))
  } catch {
    return null
  }
}

function useVisibleColumns(showMeta: boolean): [Set<PaidColumnId>, (next: Set<PaidColumnId>) => void] {
  const [chosen, setChosen] = useState<Set<PaidColumnId>>(defaultColumns)
  // Hidratar desde localStorage después del primer render: el servidor no lo tiene.
  useEffect(() => {
    const stored = readStoredColumns()
    if (stored) setChosen(stored)
  }, [])
  const set = (next: Set<PaidColumnId>) => {
    setChosen(next)
    try {
      window.localStorage.setItem(COLS_STORAGE_KEY, JSON.stringify(Array.from(next)))
    } catch {
      /* sin memoria en este navegador: la sesión sigue */
    }
  }
  // Sin Meta las columnas de Meta no existen aunque estén elegidas.
  const visible = useMemo(() => new Set(Array.from(chosen).filter((id) => showMeta || !PAID_COLUMNS.find((c) => c.id === id)?.meta)), [chosen, showMeta])
  return [visible, set]
}

const GROUP_LABELS: Record<(typeof PAID_COLUMNS)[number]["group"], string> = {
  inversion: "Inversión",
  leads: "Leads y costo",
  citas: "Citas",
  etapas: "Etapas",
}

function ColumnEditor({ showMeta, value, onChange }: { showMeta: boolean; value: Set<PaidColumnId>; onChange: (next: Set<PaidColumnId>) => void }) {
  const groupsInOrder = ["inversion", "leads", "citas", "etapas"] as const
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex items-center gap-1 rounded-md border border-border/60 px-2 py-0.5 text-[11px] font-medium text-muted-foreground hover:text-foreground">
          <Columns3 className="h-3.5 w-3.5" /> Columnas
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-56 p-3">
        {groupsInOrder.map((g) => {
          const cols = PAID_COLUMNS.filter((c) => c.group === g && (showMeta || !c.meta))
          if (cols.length === 0) return null
          return (
            <div key={g} className="mb-3 last:mb-0">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{GROUP_LABELS[g]}</p>
              {cols.map((c) => (
                <label key={c.id} className="flex cursor-pointer items-center gap-2 py-0.5 text-xs">
                  <Checkbox
                    checked={value.has(c.id)}
                    disabled={LOCKED_COLS.has(c.id)}
                    onCheckedChange={(on) => {
                      const next = new Set(value)
                      if (on) next.add(c.id)
                      else next.delete(c.id)
                      onChange(next)
                    }}
                  />
                  {c.label}
                </label>
              ))}
            </div>
          )
        })}
        <button type="button" className="mt-1 text-[11px] text-muted-foreground underline-offset-2 hover:underline" onClick={() => onChange(defaultColumns())}>
          Restablecer
        </button>
      </PopoverContent>
    </Popover>
  )
}
```

Imports: `useEffect` de `react`; `Columns3` de `lucide-react`; `Popover, PopoverTrigger,
PopoverContent` de `@/components/ui/popover`; `Checkbox` de `@/components/ui/checkbox`.

En `PaidPerformanceTable`, reemplazar el `visibleCols` provisional por
`const [visibleCols, setVisibleCols] = useVisibleColumns(showMeta)`, y el comentario
`{/* Task 6 */}` por `<ColumnEditor showMeta={showMeta} value={visibleCols} onChange={setVisibleCols} />`.

- [ ] **Step 2: Verificar en la app**

Run: `npx tsc --noEmit && pnpm lint`; `pnpm dev` → Lezgo Suite:
- Abrir "Columnas": cuatro grupos; apagar "Leads Meta" → la columna desaparece; recargar
  la página → sigue apagada. "Restablecer" vuelve a los defaults.
- Toggle Origen: el grupo Inversión desaparece del popover y de la tabla; volver a
  Campaña lo trae de regreso con la misma selección.
- Condesa: el popover no ofrece Inversión ni CPL/CPA.

- [ ] **Step 3: Commit**

```bash
git add components/dashboard/paid-performance-table.tsx
git commit -m "feat(pauta): editor de columnas con memoria por navegador

Cuatro grupos (Inversión, Leads y costo, Citas, Etapas); la selección vive en
localStorage y se ignora para las columnas de Meta cuando no hay Meta.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 7: La barra de etapas

**Files:**
- Modify: `components/dashboard/paid-performance-table.tsx`

**Interfaces:**
- Produces: `StageBar({ stages, onSegmentClick })` interno.

- [ ] **Step 1: Escribir el componente**

Antes de `// ── Tabla ───` en `paid-performance-table.tsx`:

```tsx
// ── Barra de etapas ─────────────────────────────────────────────────────────
// Segmentos proporcionales en orden del pipeline: el primario con opacidad
// creciente conforme la etapa avanza (no requiere leyenda: el hover dice la
// etapa y la cuenta), y las perdidas en rojo apagado al final. El ancho es
// relativo a la fila — los números absolutos van en las columnas de al lado.

function stageStyle(index: number, live: number, lost: boolean): React.CSSProperties {
  if (lost) return { backgroundColor: "rgb(239 68 68 / 0.45)" }
  const t = live <= 1 ? 1 : index / (live - 1)
  return { backgroundColor: `hsl(var(--primary) / ${(0.3 + 0.7 * t).toFixed(2)})` }
}

function StageBar({ stages, onSegmentClick }: { stages: StageCount[]; onSegmentClick: (s: StageCount) => void }) {
  const total = stages.reduce((a, s) => a + s.count, 0)
  if (total === 0) return null
  const live = stages.filter((s) => !s.lost).length
  return (
    <TooltipProvider delayDuration={80}>
      <div className="flex h-3 w-full overflow-hidden rounded-sm bg-muted/30" role="img" aria-label={stages.map((s) => `${s.stage} ${s.count}`).join(" · ")}>
        {stages.map((s, i) => (
          <Tooltip key={s.stage}>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="h-full min-w-[3px] transition-opacity hover:opacity-80"
                style={{ width: `${(s.count / total) * 100}%`, ...stageStyle(i, live, s.lost) }}
                onClick={(e) => { e.stopPropagation(); onSegmentClick(s) }}
                aria-label={`${s.stage}: ${s.count}`}
              />
            </TooltipTrigger>
            <TooltipContent side="top" className="text-xs">
              {s.stage} · {s.count.toLocaleString("es-MX")}
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  )
}
```

Imports: `type StageCount` de `@/lib/paid-performance`; `Tooltip, TooltipContent,
TooltipProvider, TooltipTrigger` de `@/components/ui/tooltip`.

En `renderCell`, el caso `"stages"`:

```tsx
      case "stages":
        return (
          <StageBar
            stages={row.stages}
            onSegmentClick={(s) => drillOpps(row, s.stage, oppsOf(row.oppIds).filter((o) => o.stage === s.stage).map((o) => o.id), `${row.label} · ${s.count} en ${s.stage}`)}
          />
        )
```

- [ ] **Step 2: Verificar en la app**

Run: `npx tsc --noEmit && pnpm lint`; `pnpm dev` → Lezgo Suite:
- Cada fila con opps tiene barra; "Prospecto Perdido" en rojo apagado al final.
- Hover muestra "Primera Cita · 12"; clic abre las oportunidades de esa etapa.
- Apagar "Perdidas": el segmento rojo desaparece y "Opps" baja en la misma cantidad.
- Tema claro y oscuro: la barra se lee en ambos (el primario cambia con el tema).

- [ ] **Step 3: Commit**

```bash
git add components/dashboard/paid-performance-table.tsx
git commit -m "feat(pauta): barra de etapas por fila con drill por segmento

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 8: Jubilar las cuatro tarjetas y sus memos

**Files:**
- Modify: `components/dashboard/marketing-dashboard.tsx`

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `marketing-dashboard.tsx` sin `stageGroupBy/stageKeys/stageTopN/stageIncludeLost`,
  `pautaByStage*`, `leadsByAdId`, `leadsByPlatformUrl`, `apptStatuses`, `apptStatusFilter`,
  `apptGroupBy/apptKeys/apptTopN`, `paidTrafficWithAppt`, `urlPlatform`, `shortUrlLabel`.

- [ ] **Step 1: Quitar el JSX**

Borrar, en este orden (los números son los de HOY; verificar con `grep -n` antes de cada
corte porque los pasos anteriores movieron líneas):

1. La tarjeta "Oportunidades de Pauta por Etapa del Pipeline": desde
   `<DashboardCard>` en la línea ~1808 hasta su `</DashboardCard>` (~1903).
2. El `<div className="grid grid-cols-1 gap-4 lg:grid-cols-2">` que envuelve
   "Oportunidades por ID de Anuncio" y "Oportunidades por URL" (~2005–2174), con su
   comentario `{/* Panel 2 … */}`.
3. El `<div className="grid grid-cols-1 gap-4 lg:grid-cols-1">` de "Citas por pauta"
   (~2176–2295), con su comentario `{/* Panel 4a … */}`.

- [ ] **Step 2: Quitar el estado y los memos**

Buscar y borrar cada símbolo con `grep -n "<símbolo>" components/dashboard/marketing-dashboard.tsx`
hasta que no queden usos:

- Estado: la línea `useGroupKeyFilter("campaign")` de `stage…` y la de `appt…`;
  `stageIncludeLost`, `stageTopN`, `apptTopN`, `apptStatusFilter`.
- Memos: `stageOrder` (solo lo usaba la apilada — confirmar con grep), el bloque
  `{ pautaByStageRows, … }`, `stageCampaignCut`, `pautaByStageConfig`,
  `pautaByStageTotal`, `leadsByAdId`, `leadsByPlatformUrl`, `apptStatuses`, el bloque
  `{ paidTrafficWithAppt, apptKeyCount, apptOptions }`, `apptContactIds` si era suyo.
- Helpers de módulo: `urlPlatform`, `shortUrlLabel`, y `paidGroupByNoun` si ya nadie lo
  llama. **Conservar** `GroupByToggle`, `GroupKeyFilter`, `useGroupKeyFilter`,
  `paidGroupByKey`, `paidGroupByLabel`, `campaignPrefixCut`, `visibleGroupKeys`,
  `groupScopeNote`, `keyNote`, `groupSelectionEmpty`, `CAMPAIGN_ORIGIN_OPTIONS`: los usan
  "Perdidas por razón" y "Ganadas por pauta".
- Del `buildReport` `useCallback`: las secciones `pauta-etapa`, `anuncios`, `urls`,
  `citas-pauta` y sus `stageKeyNote` / `apptKeyNote`; limpiar la lista de deps
  (~línea 1440–1448).
- Imports sin uso: `Tag`, `Layers`, `BarChart3`, `Facebook`, `Instagram`, `Calendar` —
  dejar que `pnpm lint` los señale.

- [ ] **Step 3: Verificar**

Run: `npx tsc --noEmit && pnpm lint`
Expected: sin errores ni warnings nuevos de "unused".

Run: `pnpm dev` → Lezgo Suite y Condesa → Marketing: el orden de tarjetas es
Inversión y rendimiento de pauta → Oportunidades por fuente / Pautas por canal →
Pautas por mes → Perdidas por razón → Ganadas por pauta / Ganadas por fuente →
Rendimiento por origen. Sin huecos. "Perdidas por razón" y "Ganadas por pauta" siguen
con sus toggles.

- [ ] **Step 4: Commit**

```bash
git add components/dashboard/marketing-dashboard.tsx
git commit -m "refactor(marketing): jubilar etapa apilada, ID de anuncio, URL y citas por pauta

Las cuatro viven ahora en la tabla de inversión y rendimiento de pauta.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 9: La sección del PDF

**Files:**
- Modify: `components/dashboard/paid-performance-table.tsx` (agregar `buildPaidReportSection`)
- Modify: `components/dashboard/marketing-dashboard.tsx` (`buildReport`)
- Modify: `app/api/analyze-report/route.ts:94` (comentario)

**Interfaces:**
- Produces:

```ts
export function buildPaidReportSection(p: {
  groups: PaidGroup[]
  groupBy: PaidGroupBy
  hasMeta: boolean
  costsSuppressed: boolean
  includeLost: boolean
}): ReportSection
```

- [ ] **Step 1: Escribir el constructor**

Al final de `paid-performance-table.tsx`:

```tsx
// ── PDF ─────────────────────────────────────────────────────────────────────
// La misma tabla, en bloques de pdfmake: top 15 grupos con las columnas de
// pantalla (sin Impr./Clics/CPM, que en papel solo ensanchan), y una tabla
// anexa etapa × campaña — una tabla se lee en papel; una apilada de 30
// colores no.

export function buildPaidReportSection(p: { groups: PaidGroup[]; groupBy: PaidGroupBy; hasMeta: boolean; costsSuppressed: boolean; includeLost: boolean }): ReportSection {
  const showMeta = p.hasMeta && p.groupBy === "campaign"
  const dir = showMeta ? (a: PaidGroup, b: PaidGroup) => (b.spend ?? 0) - (a.spend ?? 0) : (a: PaidGroup, b: PaidGroup) => b.opportunities - a.opportunities
  const sorted = [...p.groups].sort(dir)
  const top = sorted.slice(0, 15)
  const rest = sorted.slice(15)
  const currencies = new Set(top.map((g) => g.currency).filter((c): c is string => !!c && c !== "?"))
  const tc = currencies.size === 1 ? Array.from(currencies)[0] : null
  const cell = (n: number | null, c: string | null) => (n === null ? "—" : money(n, tc ? "?" : (c ?? "?")))
  const suppressed = p.costsSuppressed
  const noun = p.groupBy === "campaign" ? "Campaña" : "Origen"

  const headers = [
    noun,
    ...(showMeta ? [`Gasto${tc ? ` (${tc})` : ""}`, "CTR", "Leads Meta"] : []),
    "Leads CRM", "Opps", "Ganadas",
    ...(showMeta ? [`CPL${tc ? ` (${tc})` : ""}`, `CPA${tc ? ` (${tc})` : ""}`] : []),
    "Citas", "Efectivas",
  ]
  const rowOf = (g: PaidRow): string[] => [
    g.label,
    ...(showMeta ? [cell(g.spend, g.currency), pct(g.ctr), int(g.leadsMeta)] : []),
    int(g.leadsCrm), int(g.opportunities), int(g.won),
    ...(showMeta ? [suppressed ? "—" : cell(g.cpl, g.currency), suppressed ? "—" : cell(g.cpa, g.currency)] : []),
    int(g.appointments), int(g.showed),
  ]
  const rows = top.map(rowOf)
  if (rest.length > 0) rows.push(rowOf(sumRows(rest, OTRAS_KEY, `Otras (${rest.length})`)))

  // Etapa × campaña: top 6 por opps + Otras.
  const byOpps = [...p.groups].sort((a, b) => b.opportunities - a.opportunities)
  const stageCols = byOpps.slice(0, 6)
  const stageRest = byOpps.slice(6)
  const stageColRows: PaidRow[] = stageRest.length > 0 ? [...stageCols, sumRows(stageRest, OTRAS_KEY, `Otras (${stageRest.length})`)] : stageCols
  const stageNames = Array.from(new Map(p.groups.flatMap((g) => g.stages).map((s) => [s.stage, s])).values())
    .sort((x, y) => Number(x.lost) - Number(y.lost) || x.order - y.order)
    .map((s) => s.stage)
  const stageTable = {
    t: "table" as const,
    headers: ["Etapa", ...stageColRows.map((g) => g.label)],
    rows: stageNames.map((name) => [name, ...stageColRows.map((g) => int(g.stages.find((s) => s.stage === name)?.count ?? 0))]),
  }

  return {
    id: "pauta-rendimiento",
    title: "Inversión y rendimiento de pauta",
    explanation:
      (showMeta
        ? "Gasto de Meta Ads en el periodo, cruzado por id de anuncio con los contactos y oportunidades de pauta del CRM creados en él (oportunidad → objeto Pauta → primera atribución → última). Leads CRM son contactos; CPL usa esos leads, no los que Meta reporta; CPA usa las oportunidades ganadas. "
        : "Pautas del CRM en el periodo (Meta, TikTok, Google), agrupadas por su anuncio; sin conexión a Meta no hay gasto. ") +
      "Citas cuenta contactos con al menos una cita en el periodo; Efectivas, con una cita realizada. La tabla de etapas muestra en qué punto del pipeline están las oportunidades de cada " +
      (p.groupBy === "campaign" ? "campaña" : "origen") +
      (p.includeLost ? ", perdidas incluidas." : "; las perdidas no se cuentan.") +
      (suppressed ? " Con filtros de atributo activos el gasto no se recorta, por eso CPL y CPA no se calculan." : ""),
    blocks: [
      { t: "table", headers, rows },
      { t: "subheading", text: `Oportunidades de pauta por etapa${p.includeLost ? "" : " (sin perdidas)"}` },
      stageTable,
    ],
  }
}
```

Import: `type ReportSection` de `@/lib/report`.

- [ ] **Step 2: Conectarlo en `buildReport`**

En `marketing-dashboard.tsx`, donde estaba `buildMetaReportSection` (primera sección):

```tsx
    // Inversión y rendimiento de pauta va primero: es la pregunta de dinero.
    if (paidGroups.length > 0) {
      sections.push(
        buildPaidReportSection({
          groups: paidGroups,
          groupBy: paidGroupBy,
          hasMeta: !!metaInv,
          costsSuppressed: filtersLabel !== undefined,
          includeLost: paidIncludeLost,
        })
      )
    }
```

Agregar `paidGroups, paidGroupBy, paidIncludeLost, metaInv` a las deps del `useCallback`.
Importar `buildPaidReportSection` de `./paid-performance-table`.

En `app/api/analyze-report/route.ts:94` cambiar el comentario `~13 for marketing` por
`~9 for marketing`.

- [ ] **Step 3: Verificar el PDF en la app**

Run: `npx tsc --noEmit && pnpm lint`; `pnpm dev`:
- Lezgo Suite → Marketing → Exportar reporte: la primera sección es "Inversión y
  rendimiento de pauta" con Gasto/CTR/Leads Meta/Leads CRM/Opps/Ganadas/CPL/CPA/Citas/
  Efectivas y, debajo, la tabla etapa × campaña. El análisis de IA no lee las etapas
  futuras como caída ni menciona secciones que ya no existen.
- Condesa → Exportar: la misma sección sin columnas de gasto. Las secciones "por etapa",
  "por ID de anuncio", "por URL" y "Citas por pauta" ya no aparecen.
- Contar secciones de Marketing en el PDF: 9.

- [ ] **Step 4: Commit**

```bash
git add components/dashboard/paid-performance-table.tsx components/dashboard/marketing-dashboard.tsx app/api/analyze-report/route.ts
git commit -m "feat(pauta): sección del PDF desde el mismo motor — tabla y etapa × campaña

Reemplaza a meta-investment, pauta-etapa, anuncios, urls y citas-pauta.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

### Task 10: Documentación y verificación final

**Files:**
- Modify: `CLAUDE.md` (comandos; sección "Meta Ads"; nueva subsección)
- Modify: `docs/superpowers/specs/2026-09-19-pauta-rendimiento-unificado-design.md:4` (estado)

- [ ] **Step 1: CLAUDE.md**

En el bloque de comandos, después de `pnpm verify:meta-attribution`:

```
pnpm verify:paid-performance # lib/paid-performance.ts — el gasto por campaña es idéntico al de
                         #   buildMetaReport; lo que no cruza con Meta sobrevive; etapas suman opps
```

En "Meta Ads", reemplazar el bullet «**Un solo motor para los tres consumidores**…» por:

```
- **Dos motores, una llave.** `buildMetaReport(groupBy)` en `lib/meta-attribution.ts`
  alimenta la herramienta `meta_ads_report` del asistente y los tiles de "Inversión"
  (`useMetaInvestment`). `buildPaidPerformance` en `lib/paid-performance.ts` alimenta la
  tabla "Inversión y rendimiento de pauta" y su sección del PDF, y toma el gasto por
  anuncio de `buildMetaReport({ groupBy: "ad" })`, así que el gasto de una campaña es
  idéntico en los tres (`verify:paid-performance`, aserción 1). Si un número difiere,
  el bug está en el consumidor.
```

Agregar una subsección nueva después de "Meta Ads":

```
### Inversión y rendimiento de pauta (la tabla)

Spec: `docs/superpowers/specs/2026-09-19-pauta-rendimiento-unificado-design.md`. Una
tarjeta que reemplazó (2026-09-19) a la tabla de inversión y a cuatro gráficas: etapa
apilada, ID de anuncio, URL y citas por pauta.

- **Universo del CRM, Meta encima.** Filas = pautas del CRM (`classifyLead !== "notPauta"`:
  Meta, TikTok, Google, con o sin cruce). Las columnas de inversión existen solo con
  `metaAds` y cruce por ad id; lo demás sale en `—`. Existe en los seis proyectos.
- **El átomo es el anuncio**, resuelto con la MISMA cadena que el CPL
  (`resolveOppAdId` / `contactAdId`). Sin Meta la cadena corre con `EMPTY_META` y devuelve
  el id crudo. No hay un segundo camino.
- **Filas expandibles campaña → anuncios.** Con Meta la campaña es la de Meta; sin cruce,
  el `campaignHeadline` de la pauta del CRM (marca "sin Meta"). Los hijos de una campaña
  de Meta son la UNIÓN de sus anuncios y los ad ids del CRM: un anuncio que gasta sin
  traer leads aparece con opps en 0, o la suma no daría el gasto de la campaña. Una opp
  sin ad id cae en "Sin ID de anuncio", no desaparece.
- **En modo Origen no hay inversión**: un anuncio produce opps de Instagram, Facebook y
  WhatsApp a la vez; repartir su gasto sería inventar.
- **Citas = contactos con cita en la ventana** (dos citas del mismo contacto cuentan 1);
  **Efectivas** = `showed`. Es el vocabulario del PMI.
- **La barra de etapas** va en orden del pipeline con perdidas al final; el toggle
  "Perdidas" las quita de la barra Y de Opps. No lleva leyenda: el hover decodifica.
- El editor de columnas guarda en `localStorage` (`paid-performance-cols`): conveniencia
  por navegador, no estado del negocio.
- El contexto de atribución se construye UNA vez en `marketing-dashboard.tsx`
  (`attributionCtx`) y lo comparten tiles y tabla: dos contextos podrían resolver un ad
  id distinto.
```

En la sección "PDF report export", donde dice `~13 marketing / ~8 ventas`, poner
`~9 marketing / ~8 ventas`.

En el spec, línea 4: `Estado: implementado 2026-09-19`.

- [ ] **Step 2: Verificación final completa**

```bash
npx tsc --noEmit && pnpm lint && pnpm verify:paid-performance && pnpm verify:meta-attribution && pnpm verify:pauta && pnpm verify:filters
```
Expected: todo verde.

`pnpm build` → sin errores (recordando que no prueba tipos).

Manejar la app una última vez, Lezgo Suite y Condesa: tabla, expandir, ordenar, buscar,
Top N, Perdidas, Columnas (y que persista al recargar), barra de etapas con hover y clic,
cada número abre su drawer, toggle Origen, PDF de ambos proyectos.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-19-pauta-rendimiento-unificado-design.md
git commit -m "docs(pauta): CLAUDE.md — la tabla de inversión y rendimiento, dos motores una llave

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Auto-revisión contra el spec

- Decisión 1 (universo CRM, Meta encima) → Tasks 1, 2. Decisión 2 (átomo ad id, cadena)
  → Task 1 Paso 3 (`resolveOppAdId`, `contactAdId`), aserción 7 en Task 2. Decisión 3
  (expandibles) → Task 5. Decisión 4 (Campaña u Origen, headline, "sin Meta") → Task 1
  `groupKeyOf`, Task 5 píldora. Decisión 5 (unión de hijos, gasto idéntico) → Task 2,
  aserciones 1 y 2. Decisión 6 (Sin ID) → Task 1 `NO_AD_KEY`, aserción 3. Decisión 7
  (barra) → Task 7. Decisión 8 (Citas / Efectivas) → Task 1 paso 4, aserción 6. Decisión 9
  (reglas de Meta) → `costsSuppressed` en Task 5 celdas, moneda `"?"` en `finish`.
  Decisión 10 (motor puro) → Task 1. Decisión 11 (asistente intacto) → ningún task toca
  `lib/ai-tools.ts`. Decisión 12 (Origen sin inversión) → Task 1 paso 3, aserción 12,
  Task 5 píldora.
- UI del spec: tiles solo con Meta (Task 5, `metaInv && groupBy === "campaign"`);
  controles en orden (Task 5); editor con cuatro grupos y defaults (Task 6); orden por
  encabezado con default por Meta (Task 5); un solo hijo no expande (Task 5 `shown`);
  drills "cada número abre sus registros" (Task 5); vacío (Task 5 `ChartEmpty`).
- PDF: cuatro secciones fuera (Task 8), sección nueva con Citas/Efectivas y etapa ×
  campaña (Task 9), `metaCoverKpis` intacto (Task 4).
- Verificación: siete aserciones + la 12 (Tasks 1–2), app real en dos proyectos (Tasks
  5–9), `tsc` en cada commit.
- Tipos: `PaidRow.stages: StageCount[]` con `{ stage, order, lost, count }` en Task 1 y
  Task 7; `sumRows(rows, key, label)` en Tasks 1, 5, 9; `usePaidPerformance` toma
  `PaidPerformanceInput` completo (Task 5 firma corregida respecto al resumen de
  Interfaces: es `PaidPerformanceInput`, no un `Omit`); `metaScopeNote(inv, status)` en
  Tasks 4 y 5.
