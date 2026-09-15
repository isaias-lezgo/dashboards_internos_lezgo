# Meta Ads ② — Inversión en pauta en Marketing, PDF y Asistente IA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mostrar el gasto de Meta que ① ya trae: una sección "Inversión en pauta" (cinco tiles + línea de rendimiento + tabla por campaña con drill-down) arriba de Marketing, la misma sección en el PDF, y un asistente que conoce Meta (bloque en el resumen + herramienta `meta_ads_report` + reglas).

**Architecture:** Un solo motor puro, `buildMetaReport(groupBy)` en `lib/meta-attribution.ts`, alimenta la tabla del panel, la sección del PDF y la herramienta del asistente. El componente `meta-investment-section.tsx` expone un hook `useMetaInvestment` (memoiza índice, resumen y filas) que Marketing usa tanto para dibujar como para `buildReport()`. El asistente recibe `metaAds` en `ChatDataset`, el índice Meta vive en `ChatIndex`, y el prompt gana reglas numeradas de regresión.

**Tech Stack:** Next.js 16 App Router, React 19, shadcn `table`, lucide, `tsx` + `node:assert/strict` para los verify.

**Spec:** `docs/superpowers/specs/2026-09-14-meta-ads-inversion-y-asistente-design.md` (y ① para el modelo de datos).

## Global Constraints

- Package manager **pnpm**; nunca `npm install`. No se agregan dependencias.
- `npx tsc --noEmit` en cero al final de **cada** tarea.
- Verify scripts en CJS: `async function main()` + `main().catch(...)`.
- **Sin `metaAds` la sección no se dibuja** y el asistente dice "no conectado"; nada de placeholders.
- **El gasto no se recorta por atributo**: con filtros de atributo activos CPL/CPA son `—`.
- `null` se pinta `—`, nunca `$0`. Números con `toLocaleString("es-MX")`.
- Nunca `ScrollArea` dentro de una card; la tabla va en un `div.overflow-x-auto`.
- Ámbar (`text-primary`) solo en el tile de atención (CPL), hover y focus.
- Las gráficas existentes no se tocan. `lib/pauta.ts` no se toca.
- Commits en español `feat(meta): …` con los trailers de la sesión.

---

## File Structure

| Archivo | Responsabilidad |
|---|---|
| `lib/meta-attribution.ts` | `buildMetaReport` (motor por `groupBy`), `defaultCurrency`, alias `buildCampaignPerformance` |
| `scripts/verify-meta-attribution.ts` | aserciones nuevas del motor |
| `components/dashboard/dashboard-ui.tsx` | exporta `SummaryTile` y recibe `TopNSlider` (movido desde Marketing) |
| `components/dashboard/meta-investment-section.tsx` | `useMetaInvestment`, `MetaInvestmentSection`, `buildMetaReportSection` (PDF), formateadores |
| `components/dashboard/marketing-dashboard.tsx` | props nuevas, montaje, sección en `buildReport`, KPIs de portada |
| `components/dashboard/dashboard-app.tsx` | pasa `metaAds`, `metaAdsStatus`, `dateRange` a Marketing y `metaAds` al chat |
| `lib/ai-tools.ts` | `ChatDataset.metaAds`, definición y ejecutor de `meta_ads_report` |
| `lib/ai-index.ts` | `ChatIndex.metaIndex` |
| `lib/ai-context.ts` | bloque `=== META ADS ===` y reglas 9-13 |
| `CLAUDE.md` | sección Meta Ads: entrega ② |

---

### Task 1: `buildMetaReport` — el motor por `groupBy` (puro, TDD)

**Files:**
- Modify: `lib/meta-attribution.ts`
- Modify: `scripts/verify-meta-attribution.ts`

**Interfaces:**
- Consumes: `CostInput`, `MetaIndex`, `classifyLead`, `localDay`, `oppAdId`, `isWonOpp` (ya existen).
- Produces:
  ```ts
  export type MetaGroupBy = "none" | "campaign" | "adset" | "ad" | "month"
  export interface MetaReportInput extends CostInput { groupBy: MetaGroupBy; campaign?: string; includeIds?: boolean }
  export interface MetaReportRow { key; label; accountId: string | null; currency: string; spend; impressions; clicks; cpm; ctr; leadsMeta; leadsCrm; won; cpl; cpa; oppIds?; contactIds? }
  export function buildMetaReport(p: MetaReportInput): MetaReportRow[]
  export function defaultCurrency(meta: MetaAdsData): string | null   // la única moneda de las cuentas, o null
  export function buildCampaignPerformance(p: CostInput): CampaignPerformanceRow[]  // alias: buildMetaReport({...p, groupBy:"campaign"})
  ```
  `CampaignPerformanceRow` pasa a ser un alias de `MetaReportRow` (mismos campos + `campaignId` ⇒ se conserva `campaignId` como copia de `key` para no romper el verify).

- [ ] **Step 1: Aserciones nuevas en `scripts/verify-meta-attribution.ts`**

Agregar al `import` de `../lib/meta-attribution`: `buildMetaReport, defaultCurrency`. Insertar antes de `console.log("✅ verify:meta-attribution OK")`:

```ts
  // ── buildMetaReport ────────────────────────────────────────────────────────
  const mxnIdx = buildMetaIndex(mxn);
  const base = { opportunities: opps, meta: mxn, index: mxnIdx, range, pautaContacts };

  // --- none: una fila total, igual que buildCostSummary
  const total = buildMetaReport({ ...base, groupBy: "none" });
  assert.equal(total.length, 1);
  assert.equal(total[0].key, "total");
  assert.equal(total[0].spend, 450);
  assert.equal(total[0].leadsCrm, 4);
  assert.equal(total[0].currency, "MXN");
  assert.equal(total[0].cpl, 112.5);

  // --- campaign: idéntico al alias
  const byCamp = buildMetaReport({ ...base, groupBy: "campaign" });
  assert.deepEqual(byCamp.map((r) => [r.key, r.spend, r.leadsCrm]), rows.map((r) => [r.campaignId, r.spend, r.leadsCrm]));

  // --- month: cronológico; la cohorte cruza el límite de mes por DÍA LOCAL
  const byMonth = buildMetaReport({ ...base, groupBy: "month", range: null });
  assert.deepEqual(byMonth.map((r) => r.key), ["2026-08", "2026-09"]);
  assert.equal(byMonth[0].spend, 450);
  assert.equal(byMonth[0].leadsCrm, 4, "a4 (31 ago 23:59 local) cae en agosto");
  assert.equal(byMonth[1].spend, 999);
  assert.equal(byMonth[1].leadsCrm, 1, "sep (1 sep 00:01 local) cae en septiembre");
  assert.equal(byMonth[1].label, "2026-09");

  // --- adset y ad
  const byAdset = buildMetaReport({ ...base, groupBy: "adset" });
  assert.deepEqual(byAdset.map((r) => [r.key, r.spend]), [["set-b", 300], ["set-a", 150]]);
  const byAd = buildMetaReport({ ...base, groupBy: "ad" });
  assert.deepEqual(byAd.map((r) => r.key), ["120003", "120001", "120002"]);
  assert.equal(byAd.find((r) => r.key === "120001")?.leadsCrm, 2);
  assert.equal(byAd.find((r) => r.key === "120001")?.accountId, "act_1");

  // --- filtro por campaña (substring, sin acentos ni mayúsculas)
  const onlyB = buildMetaReport({ ...base, groupBy: "ad", campaign: "buyer" });
  assert.deepEqual(onlyB.map((r) => r.key), ["120003"]);
  const onlyBMonth = buildMetaReport({ ...base, groupBy: "month", campaign: "DEMOGRAFIA" });
  assert.equal(onlyBMonth.length, 1);
  assert.equal(onlyBMonth[0].spend, 150, "el filtro de campaña acota también los totales por mes");

  // --- includeIds: solo con la bandera, distintos, con tope
  const noIds = buildMetaReport({ ...base, groupBy: "campaign" });
  assert.equal(noIds[0].oppIds, undefined);
  const withIds = buildMetaReport({ ...base, groupBy: "campaign", includeIds: true });
  const campA = withIds.find((r) => r.key === "camp-a")!;
  assert.deepEqual([...campA.oppIds!].sort(), ["a1", "a2", "a3"]);
  assert.deepEqual([...campA.contactIds!].sort(), ["c-a1", "c-a2", "c-a3"]);
  const many = Array.from({ length: 80 }, (_, i) =>
    opp({ id: `m${i}`, adId: "120001", contactId: "c-shared", createdAt: "2026-08-12T12:00:00.000Z" })
  );
  const cappedRow = buildMetaReport({ ...base, opportunities: many, groupBy: "ad", includeIds: true }).find((r) => r.key === "120001")!;
  assert.equal(cappedRow.leadsCrm, 80, "el conteo no se topa");
  assert.equal(cappedRow.oppIds!.length, 50, "los ids sí (cap 50)");
  assert.deepEqual(cappedRow.contactIds, ["c-shared"], "contactIds distintos");

  // --- moneda mixta: la fila total lleva "?" y sin costos; por campaña cada una con la suya
  const mixedIdx = buildMetaIndex(meta);
  const mixedTotal = buildMetaReport({ opportunities: opps, meta, index: mixedIdx, range, pautaContacts, groupBy: "none" });
  assert.equal(mixedTotal[0].currency, "?");
  assert.equal(mixedTotal[0].spend, 460, "el gasto se suma igual; la UI sabe por currency que no es comparable");
  assert.equal(mixedTotal[0].cpl, null);
  assert.equal(mixedTotal[0].cpm, null);
  const mixedCamp = buildMetaReport({ opportunities: opps, meta, index: mixedIdx, range, pautaContacts, groupBy: "campaign" });
  assert.equal(mixedCamp.find((r) => r.key === "camp-usd")?.currency, "USD");

  // --- defaultCurrency y un ad fuera de la jerarquía NO ensucia la moneda
  assert.equal(defaultCurrency(mxn), "MXN");
  assert.equal(defaultCurrency(meta), null);
  const orphanDaily: MetaAdsData = {
    ...mxn,
    daily: [...mxn.daily, { adId: "999999", date: "2026-08-15", spend: 5, impressions: 10, reach: 9, clicks: 1, linkClicks: 1, leadsForm: 0, leadsMsg: 0 }],
  };
  const orphanSummary = buildCostSummary({ opportunities: opps, meta: orphanDaily, index: buildMetaIndex(orphanDaily), range, pautaContacts });
  assert.equal(orphanSummary.mixedCurrency, false, "un ad borrado (sin jerarquía) hereda la única moneda de la cuenta");
  assert.equal(orphanSummary.spend, 455);
  const orphanTotal = buildMetaReport({ opportunities: opps, meta: orphanDaily, index: buildMetaIndex(orphanDaily), range, pautaContacts, groupBy: "none" });
  assert.equal(orphanTotal[0].currency, "MXN");
```

- [ ] **Step 2: Correr y ver fallar**

```bash
pnpm verify:meta-attribution
```
Esperado: error de TS/importación `buildMetaReport` no exportado.

- [ ] **Step 3: Implementar en `lib/meta-attribution.ts`**

Agregar después de `function currencyOf(...)` (y reemplazar `currencyOf` para que use la moneda por defecto):

```ts
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
```

En `buildCostSummary`, calcular `const fallback = defaultCurrency(p.meta);` al inicio y llamar `currencyOf(p.index, row.adId, fallback)`.

Reemplazar la sección `// ── Por campaña` completa (interfaz `CampaignPerformanceRow` y `buildCampaignPerformance`) por:

```ts
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
  leadsCrm: number;
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
  _contactIds: Set<string>;
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
        leadsMeta: 0, leadsCrm: 0, won: 0, cpl: null, cpa: null,
        _currencies: new Set(), _oppIds: [], _contactIds: new Set(),
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

  const ctx = { index: p.index, pautaContacts: p.pautaContacts };
  for (const opp of p.opportunities) {
    const day = localDay(opp.createdAt);
    if (!inRange(day, p.range)) continue;
    if (classifyLead(opp, ctx) !== "exact") continue;
    const adId = oppAdId(opp)!;
    const hit = p.index.byAd.get(adId);
    if (!matches(hit)) continue;
    const k = keyFor(hit, day);
    if (!k) continue;
    const b = bucketFor(k);
    b.leadsCrm += 1;
    if (isWonOpp(opp)) b.won += 1;
    b._currencies.add(currencyOf(p.index, adId, fallback));
    if (p.includeIds && b._oppIds.length < ID_CAP) {
      b._oppIds.push(opp.id);
      if (opp.contactId) b._contactIds.add(opp.contactId);
    }
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
      row.contactIds = Array.from(_contactIds);
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
```

Y actualizar el comentario de cabecera del archivo: sustituir "y la entrega ② en el panel (índice, cohorte, costo por campaña)" por "la entrega ② en el panel y el asistente (índice, cohorte, `buildMetaReport` por campaña/conjunto/anuncio/mes)".

- [ ] **Step 4: Verificar**

```bash
pnpm verify:meta-attribution   # ✅
npx tsc --noEmit
```

Si el `mixedTotal[0].spend` da `460` con `450` MXN + `10` USD: correcto, la suma cruda es lo esperado.

- [ ] **Step 5: Commit**

```bash
git add lib/meta-attribution.ts scripts/verify-meta-attribution.ts
git commit -m "feat(meta): buildMetaReport — un motor por campaña/conjunto/anuncio/mes para panel, PDF y asistente"
```

---

### Task 2: la sección "Inversión en pauta" en Marketing

**Files:**
- Modify: `components/dashboard/dashboard-ui.tsx` (exportar `SummaryTile`; recibir `TopNSlider`)
- Modify: `components/dashboard/marketing-dashboard.tsx` (quitar `TopNSlider` local; props; montaje)
- Create: `components/dashboard/meta-investment-section.tsx`
- Modify: `components/dashboard/dashboard-app.tsx` (props a Marketing)

**Interfaces:**
- Consumes: `buildMetaIndex`, `buildCostSummary`, `buildMetaReport`, `localDay`, `MetaReportRow`, `CostSummary` (Task 1); `SummaryTile`, `ScopePill`, `DashboardCard`, `ChartCardHeader`, `TopNSlider`; `DrillState`; `ResolvedDateRange`.
- Produces:
  ```ts
  export interface MetaInvestment { summary: CostSummary; rows: MetaReportRow[]; range: DayRange; costsSuppressed: boolean; oppById: Map<string, Opportunity> }
  export function useMetaInvestment(p: { metaAds: MetaAdsData | null | undefined; opportunities: Opportunity[]; pautas: Pauta[]; dateRange: ResolvedDateRange | null | undefined; attributeFiltersActive: boolean }): MetaInvestment | null
  export function MetaInvestmentSection(p: { inv: MetaInvestment; status?: MetaAdsStatus; onDrill: (d: DrillState) => void }): JSX.Element
  export function money(n: number | null, currency: string): string   // "—" si null; "$12,825.99 MXN"; con "?" solo el número
  export function pct(n: number | null): string
  ```

- [ ] **Step 1: `dashboard-ui.tsx` — exportar `SummaryTile` y mover `TopNSlider`**

Cambiar `function SummaryTile({` por `export function SummaryTile({`.

Cortar `function TopNSlider(…)` completo de `marketing-dashboard.tsx` (líneas ~585-608) y pegarlo al final de `dashboard-ui.tsx` como `export function TopNSlider(…)` sin otros cambios. En `marketing-dashboard.tsx`, agregar `TopNSlider` al import de `./dashboard-ui` (el bloque que ya trae `MarketingSummaryStrip`).

```bash
npx tsc --noEmit   # limpio: cuatro usos de TopNSlider en Marketing siguen resolviendo
```

- [ ] **Step 2: Escribir `components/dashboard/meta-investment-section.tsx`**

```tsx
// components/dashboard/meta-investment-section.tsx
// "Inversión en pauta": lo que ① dejó en data.metaAds, en pantalla. Cinco tiles,
// una línea de rendimiento y la tabla por campaña, todo sobre buildCostSummary /
// buildMetaReport — el mismo motor que usan el PDF y el asistente, para que los
// tres digan el mismo número.
//
// Regla de filtros: el gasto sigue SOLO al filtro de fecha. Los filtros de
// atributo (asesor, status, origen…) recortan leads y ganadas, pero `gasto ÷
// leads de un asesor` sería un CPL falso, así que con atributos activos CPL y
// CPA salen "—" y el ScopePill lo explica.
"use client"

import { useMemo, useState } from "react"
import { Coins, Users, Receipt, Trophy, HandCoins } from "lucide-react"
import {
  DashboardCard,
  ChartCardHeader,
  ScopePill,
  SummaryTile,
  TopNSlider,
} from "@/components/dashboard/dashboard-ui"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import type { DrillState } from "@/components/dashboard/chart-drill-drawer"
import type { ResolvedDateRange } from "@/lib/date-range"
import type { MetaAdsData, MetaAdsStatus, Opportunity, Pauta } from "@/lib/types"
import {
  buildCostSummary,
  buildMetaIndex,
  buildMetaReport,
  classifyLead,
  localDay,
  type CostSummary,
  type DayRange,
  type MetaReportRow,
} from "@/lib/meta-attribution"
import { isWonOpp } from "@/lib/opportunity-status"

// ── Formato ─────────────────────────────────────────────────────────────────

/** "$12,825.99 MXN"; "—" si null; con moneda "?" solo el número. */
export function money(n: number | null, currency: string): string {
  if (n === null) return "—"
  const num = n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return currency === "?" ? `$${num}` : `$${num} ${currency}`
}

export function pct(n: number | null): string {
  return n === null ? "—" : `${(n * 100).toLocaleString("es-MX", { maximumFractionDigits: 2 })}%`
}

function int(n: number): string {
  return n.toLocaleString("es-MX")
}

// ── Cálculo ─────────────────────────────────────────────────────────────────

export interface MetaInvestment {
  summary: CostSummary
  /** Por campaña, gasto desc, con oppIds para el drill. */
  rows: MetaReportRow[]
  range: DayRange
  /** Filtros de atributo activos: CPL/CPA no se calculan. */
  costsSuppressed: boolean
  oppById: Map<string, Opportunity>
  /** Las opps `exact` de la ventana, para los tiles. */
  exactOpps: Opportunity[]
}

export function useMetaInvestment(p: {
  metaAds: MetaAdsData | null | undefined
  /** Ya filtradas por fecha Y atributos: el rango se vuelve a aplicar adentro. */
  opportunities: Opportunity[]
  pautas: Pauta[]
  dateRange: ResolvedDateRange | null | undefined
  attributeFiltersActive: boolean
}): MetaInvestment | null {
  const { metaAds, opportunities, pautas, dateRange, attributeFiltersActive } = p
  const index = useMemo(() => (metaAds ? buildMetaIndex(metaAds) : null), [metaAds])
  const pautaContacts = useMemo(() => {
    const s = new Set<string>()
    for (const x of pautas) if (x.contactId) s.add(x.contactId)
    return s
  }, [pautas])
  // El mismo día LOCAL con el que el filtro recortó las oportunidades.
  const range = useMemo<DayRange>(
    () => (dateRange ? { since: localDay(dateRange.from.toISOString()), until: localDay(dateRange.to.toISOString()) } : null),
    [dateRange]
  )
  return useMemo(() => {
    if (!metaAds || !index) return null
    const base = { opportunities, meta: metaAds, index, range, pautaContacts }
    const summary = buildCostSummary(base)
    const rows = buildMetaReport({ ...base, groupBy: "campaign", includeIds: true })
    const oppById = new Map(opportunities.map((o) => [o.id, o]))
    const ctx = { index, pautaContacts }
    const exactOpps = opportunities.filter(
      (o) => (!range || (localDay(o.createdAt) >= range.since && localDay(o.createdAt) <= range.until)) && classifyLead(o, ctx) === "exact"
    )
    return { summary, rows, range, costsSuppressed: attributeFiltersActive, oppById, exactOpps }
  }, [metaAds, index, opportunities, range, pautaContacts, attributeFiltersActive])
}

// ── UI ──────────────────────────────────────────────────────────────────────

const TABLE_COLS = ["Campaña", "Gasto", "Impr.", "Clics", "CPM", "CTR", "Leads Meta", "Leads CRM", "Ganadas", "CPL", "CPA"]

export function MetaInvestmentSection({
  inv,
  status,
  onDrill,
}: {
  inv: MetaInvestment
  status?: MetaAdsStatus
  onDrill: (d: DrillState) => void
}) {
  const { summary: s, rows, costsSuppressed } = inv
  const [topN, setTopN] = useState(10)

  const currency = s.currency ?? "?"
  const cplShown = costsSuppressed || s.mixedCurrency ? null : s.cpl
  const cpaShown = costsSuppressed || s.mixedCurrency ? null : s.cpa
  const spendLabel = s.mixedCurrency
    ? Object.entries(s.spendByCurrency).map(([c, v]) => money(v, c)).join(" · ")
    : money(s.spend, currency)

  const visible = topN >= rows.length ? rows : rows.slice(0, topN)
  const rest = rows.slice(visible.length)
  const restSpend = rest.reduce((a, r) => a + r.spend, 0)
  const restLeads = rest.reduce((a, r) => a + r.leadsCrm, 0)

  const drillOpps = (title: string, opps: Opportunity[], subtitle?: string) =>
    onDrill({ open: true, title, subtitle, opportunities: opps })

  const scopeTooltip = (
    <>
      Cohorte por fecha de creación: el gasto de la ventana contra las oportunidades creadas en ella cuyo anuncio está en Meta.
      El gasto sigue solo al filtro de fecha; los filtros de atributo recortan leads y ganadas.
      {costsSuppressed && " — Con filtros de atributo activos CPL y CPA no se calculan."}
      {s.mixedCurrency && " Las cuentas mezclan monedas: los costos no se consolidan."}
      {s.unknownAdLeads > 0 && ` ${int(s.unknownAdLeads)} leads traen un anuncio fuera de las cuentas asignadas.`}
      {status?.state === "partial" && ` Sin respuesta en el último sync: ${status.failedAccounts.map((f) => f.id).join(", ")}.`}
      {status?.state === "error" && " Meta no respondió en el último sync: gasto del último sync bueno."}
    </>
  )

  return (
    <DashboardCard>
      <ChartCardHeader
        title="Inversión en pauta"
        icon={Coins}
        actions={<ScopePill label={costsSuppressed ? "sin costos con filtros" : "cohorte por fecha"} tooltip={scopeTooltip} />}
      />

      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-5">
        <SummaryTile label="Gasto" icon={Coins} onClick={() => document.getElementById("meta-campaign-table")?.scrollIntoView({ behavior: "smooth", block: "nearest" })}>
          <p className="mt-2 text-[22px] font-bold leading-none tabular-nums text-foreground">{spendLabel}</p>
          <p className="mt-2 text-[11px] text-muted-foreground">
            {inv.range ? `${inv.range.since} → ${inv.range.until}` : "todo el historial"}
          </p>
        </SummaryTile>

        <SummaryTile label="Leads CRM" icon={Users} onClick={() => drillOpps("Leads de Meta en el CRM", inv.exactOpps, "Oportunidades creadas en la ventana con anuncio en Meta")}>
          <p className="mt-2 text-[28px] font-bold leading-none tabular-nums text-foreground">{int(s.leadsCrm)}</p>
          <p className="mt-2 text-[11px] tabular-nums text-muted-foreground">Meta reportó {int(s.leadsMeta)}</p>
        </SummaryTile>

        <SummaryTile label="CPL" icon={Receipt} tone="accent" onClick={() => drillOpps("Leads de Meta en el CRM", inv.exactOpps)}>
          <p className="mt-2 text-[22px] font-bold leading-none tabular-nums text-primary">{money(cplShown, currency)}</p>
          <p className="mt-2 text-[11px] text-muted-foreground">{costsSuppressed ? "no aplica con filtros" : "por lead del CRM"}</p>
        </SummaryTile>

        <SummaryTile label="Ganadas" icon={Trophy} onClick={() => drillOpps("Ganadas de Meta", inv.exactOpps.filter(isWonOpp))}>
          <p className="mt-2 text-[28px] font-bold leading-none tabular-nums text-foreground">{int(s.won)}</p>
          <p className="mt-2 text-[11px] tabular-nums text-muted-foreground">
            {s.leadsCrm > 0 ? `${((s.won / s.leadsCrm) * 100).toLocaleString("es-MX", { maximumFractionDigits: 1 })}% de los leads` : "—"}
          </p>
        </SummaryTile>

        <SummaryTile label="CPA" icon={HandCoins} onClick={() => drillOpps("Ganadas de Meta", inv.exactOpps.filter(isWonOpp))}>
          <p className="mt-2 text-[22px] font-bold leading-none tabular-nums text-foreground">{money(cpaShown, currency)}</p>
          <p className="mt-2 text-[11px] text-muted-foreground">{costsSuppressed ? "no aplica con filtros" : "por venta"}</p>
        </SummaryTile>
      </div>

      <p className="mt-3 text-[11px] tabular-nums text-muted-foreground">
        Impresiones {int(rows.reduce((a, r) => a + r.impressions, 0))} · Clics {int(rows.reduce((a, r) => a + r.clicks, 0))} · CPM{" "}
        {s.mixedCurrency ? "—" : money(cpmOf(rows), currency)} · CTR {pct(ctrOf(rows))}
      </p>

      <div id="meta-campaign-table" className="mt-5 flex items-center justify-between gap-3">
        <h4 className="text-sm font-semibold text-foreground">Gasto y costo por campaña</h4>
        <TopNSlider value={topN} max={rows.length} onChange={setTopN} />
      </div>
      <div className="mt-2 overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {TABLE_COLS.map((c, i) => (
                <TableHead key={c} className={i === 0 ? "min-w-[14rem]" : "text-right"}>{c}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((r) => (
              <TableRow
                key={r.key}
                className="cursor-pointer"
                onClick={() => drillOpps(r.label, (r.oppIds ?? []).map((id) => inv.oppById.get(id)).filter((o): o is Opportunity => !!o), `${int(r.leadsCrm)} leads · ${money(r.spend, r.currency)}`)}
              >
                <TableCell className="max-w-[22rem] truncate font-medium" title={r.label}>{r.label}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.spend, r.currency)}</TableCell>
                <TableCell className="text-right tabular-nums">{int(r.impressions)}</TableCell>
                <TableCell className="text-right tabular-nums">{int(r.clicks)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(r.cpm, r.currency)}</TableCell>
                <TableCell className="text-right tabular-nums">{pct(r.ctr)}</TableCell>
                <TableCell className="text-right tabular-nums">{int(r.leadsMeta)}</TableCell>
                <TableCell className="text-right tabular-nums">{int(r.leadsCrm)}</TableCell>
                <TableCell className="text-right tabular-nums">{int(r.won)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(costsSuppressed ? null : r.cpl, r.currency)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(costsSuppressed ? null : r.cpa, r.currency)}</TableCell>
              </TableRow>
            ))}
            {rest.length > 0 && (
              <TableRow className="text-muted-foreground">
                <TableCell className="font-medium">Otras ({int(rest.length)})</TableCell>
                <TableCell className="text-right tabular-nums">{money(restSpend, currency)}</TableCell>
                <TableCell className="text-right tabular-nums">{int(rest.reduce((a, r) => a + r.impressions, 0))}</TableCell>
                <TableCell className="text-right tabular-nums">{int(rest.reduce((a, r) => a + r.clicks, 0))}</TableCell>
                <TableCell className="text-right">—</TableCell>
                <TableCell className="text-right">—</TableCell>
                <TableCell className="text-right tabular-nums">{int(rest.reduce((a, r) => a + r.leadsMeta, 0))}</TableCell>
                <TableCell className="text-right tabular-nums">{int(restLeads)}</TableCell>
                <TableCell className="text-right tabular-nums">{int(rest.reduce((a, r) => a + r.won, 0))}</TableCell>
                <TableCell className="text-right">—</TableCell>
                <TableCell className="text-right">—</TableCell>
              </TableRow>
            )}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={TABLE_COLS.length} className="text-center text-muted-foreground">Sin gasto en la ventana</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </DashboardCard>
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

Nota: `ChartCardHeader` acepta `icon`/`actions` (ver `dashboard-ui.tsx:171`). Si `HandCoins` no existe en la versión de lucide instalada (`grep -c HandCoins node_modules/lucide-react/dist/lucide-react.d.ts`), usar `Banknote`.

- [ ] **Step 3: Props y montaje en `marketing-dashboard.tsx`**

Imports:

```tsx
import { MetaInvestmentSection, useMetaInvestment } from "./meta-investment-section"
import type { MetaAdsData, MetaAdsStatus } from "@/lib/types"
import type { ResolvedDateRange } from "@/lib/date-range"
```

En `MarketingDashboardProps` (línea ~105-125), agregar:

```ts
  metaAds?: MetaAdsData | null
  metaAdsStatus?: MetaAdsStatus
  dateRange?: ResolvedDateRange | null
```

En la firma de `MarketingDashboard(...)` (línea ~610) agregar `metaAds, metaAdsStatus, dateRange` a la desestructuración.

Después de `const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)`:

```tsx
  const metaInv = useMetaInvestment({
    metaAds,
    opportunities,
    pautas: rankingPautas,
    dateRange,
    attributeFiltersActive: filtersLabel !== undefined,
  })
```

(`rankingPautas` es `allPautas ?? pautas`, ya definido arriba — el historial completo, la misma convención de `isDePauta`.)

En el JSX, justo después de `<MarketingSummaryStrip … />`:

```tsx
      {metaInv && <MetaInvestmentSection inv={metaInv} status={metaAdsStatus} onDrill={setDrill} />}
```

- [ ] **Step 4: Pasar las props desde `dashboard-app.tsx`**

En `<MarketingDashboard …>` (línea ~432), después de `filtersLabel={filtersLabel}`:

```tsx
            metaAds={data?.metaAds ?? null}
            metaAdsStatus={data?.metaAdsStatus}
            dateRange={dateRange}
```

- [ ] **Step 5: tsc y prueba visual contra el caché real**

```bash
npx tsc --noEmit
pnpm dev
```

El dev local lee la misma fila de Neon: abrir **Lezgo Suite** con la contraseña general. Debe aparecer la sección debajo de los tres tiles. Verificar:
- Filtro de fecha **julio 2026** (rango 1–31 jul) → Gasto **$12,825.99 MXN**; **agosto** → **$9,817.97 MXN**.
- "Todo el historial" → Leads CRM = 248 (los `exact` medidos en ①).
- Activar filtro Asesor → CPL y CPA `—`, ScopePill "sin costos con filtros"; Leads CRM baja.
- Clic en Leads CRM → drawer con oportunidades; clic en una fila de campaña → drawer con las suyas.
- Slider Top N recorta y aparece "Otras (N)"; la suma de gastos de la tabla + Otras = tile Gasto.
- **Yconia** (sin cuenta): la sección no existe.
- 400 px de ancho: los tiles van en 2 columnas y la tabla scrollea horizontal sin desbordar la página.

- [ ] **Step 6: Commit**

```bash
git add components/dashboard/dashboard-ui.tsx components/dashboard/meta-investment-section.tsx components/dashboard/marketing-dashboard.tsx components/dashboard/dashboard-app.tsx
git commit -m "feat(meta): sección Inversión en pauta en Marketing — tiles, rendimiento y tabla por campaña con drill-down"
```

---

### Task 3: la sección en el PDF

**Files:**
- Modify: `components/dashboard/meta-investment-section.tsx` (agregar `buildMetaReportSection`)
- Modify: `components/dashboard/marketing-dashboard.tsx` (`buildReport`)

**Interfaces:**
- Consumes: `MetaInvestment`, `ReportSection` (`lib/report.ts`), `money`, `pct`.
- Produces: `export function buildMetaReportSection(inv: MetaInvestment): ReportSection` y `export function metaCoverKpis(inv: MetaInvestment): { label: string; value: string }[]`.

- [ ] **Step 1: Agregar a `meta-investment-section.tsx`** (después de `pct`; importar `type { ReportSection } from "@/lib/report"`):

```ts
// ── PDF ─────────────────────────────────────────────────────────────────────
// La misma sección que se ve en pantalla, en bloques del spec de pdfmake. Se
// construye aquí y no en marketing-dashboard para que el panel y el PDF no
// puedan divergir en qué es "Inversión en pauta".

export function metaCoverKpis(inv: MetaInvestment): { label: string; value: string }[] {
  const s = inv.summary
  const currency = s.currency ?? "?"
  const spend = s.mixedCurrency
    ? Object.entries(s.spendByCurrency).map(([c, v]) => money(v, c)).join(" · ")
    : money(s.spend, currency)
  return [
    { label: "Gasto en Meta", value: spend },
    { label: "CPL", value: inv.costsSuppressed || s.mixedCurrency ? "—" : money(s.cpl, currency) },
  ]
}

export function buildMetaReportSection(inv: MetaInvestment): ReportSection {
  const s = inv.summary
  const currency = s.currency ?? "?"
  const suppressed = inv.costsSuppressed || s.mixedCurrency
  const top = inv.rows.slice(0, 15)
  return {
    id: "meta-investment",
    title: "Inversión en pauta",
    explanation:
      "Gasto de Meta Ads en el periodo, cruzado por id de anuncio con las oportunidades creadas en ese periodo. CPL y CPA usan los leads del CRM, no los que Meta reporta." +
      (inv.costsSuppressed ? " Con filtros de atributo activos el gasto no se recorta, por eso CPL y CPA no se calculan." : ""),
    blocks: [
      {
        t: "kpis",
        items: [
          ...metaCoverKpis(inv),
          { label: "Leads CRM", value: s.leadsCrm.toLocaleString("es-MX") },
          { label: "Leads Meta", value: s.leadsMeta.toLocaleString("es-MX") },
          { label: "Ganadas", value: s.won.toLocaleString("es-MX") },
          { label: "CPA", value: suppressed ? "—" : money(s.cpa, currency) },
          { label: "Impresiones", value: inv.rows.reduce((a, r) => a + r.impressions, 0).toLocaleString("es-MX") },
          { label: "Clics", value: inv.rows.reduce((a, r) => a + r.clicks, 0).toLocaleString("es-MX") },
        ],
      },
      {
        t: "table",
        headers: ["Campaña", "Gasto", "Impr.", "Clics", "CPM", "CTR", "Leads Meta", "Leads CRM", "Ganadas", "CPL", "CPA"],
        rows: top.map((r) => [
          r.label,
          money(r.spend, r.currency),
          r.impressions.toLocaleString("es-MX"),
          r.clicks.toLocaleString("es-MX"),
          money(r.cpm, r.currency),
          pct(r.ctr),
          r.leadsMeta.toLocaleString("es-MX"),
          r.leadsCrm.toLocaleString("es-MX"),
          r.won.toLocaleString("es-MX"),
          suppressed ? "—" : money(r.cpl, r.currency),
          suppressed ? "—" : money(r.cpa, r.currency),
        ]),
      },
    ],
  }
}
```

- [ ] **Step 2: En `buildReport()` de `marketing-dashboard.tsx`**

Importar `buildMetaReportSection, metaCoverKpis` del mismo módulo. Justo después de `const sections: ReportSection[] = []`:

```ts
    if (metaInv) sections.push(buildMetaReportSection(metaInv))
```

Y en el `return { … kpis: [ … ] }`, al final del arreglo `kpis`:

```ts
        ...(metaInv ? metaCoverKpis(metaInv) : []),
```

Agregar `metaInv` a la lista de dependencias del `useCallback`.

- [ ] **Step 3: Verificar con el PDF real**

```bash
npx tsc --noEmit
pnpm dev
```

Lezgo Suite → "Exportar reporte" → el PDF abre con "Inversión en pauta" como primera sección: KPIs + tabla de hasta 15 campañas, y su análisis del modelo. Portada con "Gasto en Meta" y "CPL". Revisar en la respuesta de `/api/analyze-report` (Network) que `analyses["meta-investment"]` existe — si viene vacío, el presupuesto de 8 000 tokens se quedó corto: subir `max_tokens` a `9000` en `app/api/analyze-report/route.ts:96` y anotarlo en CLAUDE.md.

Yconia → el PDF no cambia.

- [ ] **Step 4: Commit**

```bash
git add components/dashboard/meta-investment-section.tsx components/dashboard/marketing-dashboard.tsx
git commit -m "feat(meta): sección Inversión en pauta en el PDF de Marketing"
```

---

### Task 4: el asistente — dataset, índice, herramienta y reglas

**Files:**
- Modify: `lib/ai-tools.ts` (`ChatDataset.metaAds`, definición `meta_ads_report`, ejecutor)
- Modify: `lib/ai-index.ts` (`ChatIndex.metaIndex`)
- Modify: `lib/ai-context.ts` (bloque `=== META ADS ===`, reglas 9-13)
- Modify: `components/dashboard/dashboard-app.tsx` (pasa `metaAds` al chat)

**Interfaces:**
- Consumes: `buildMetaReport`, `buildMetaIndex`, `classifyLead`, `MetaIndex`, `MetaReportRow`, `defaultCurrency`.
- Produces: `ChatDataset.metaAds?: MetaAdsData | null`; `ChatIndex.metaIndex: MetaIndex | null`; herramienta `meta_ads_report`.

- [ ] **Step 1: `ChatDataset` y el índice**

`lib/ai-tools.ts:19-28` — agregar al final de la interfaz:

```ts
  /** Dataset de Meta Ads (entrega ①). null/undefined = no conectado en este proyecto. */
  metaAds?: MetaAdsData | null;
```

(y `MetaAdsData` al `import type` de `@/lib/types`.)

`lib/ai-index.ts` — en `ChatIndex` agregar `metaIndex: MetaIndex | null;`; en `buildChatIndex`, antes del `return`: `const metaIndex = data.metaAds ? buildMetaIndex(data.metaAds) : null;` y devolverlo. Import: `import { buildMetaIndex, type MetaIndex } from "./meta-attribution";`.

`components/dashboard/dashboard-app.tsx` — en el `dataset={{ … }}` de `<ConversationsChat>`, después de `customFieldDefs`: `metaAds: data?.metaAds ?? null,`.

- [ ] **Step 2: Definición de la herramienta** — en `TOOL_DEFINITIONS`, justo después de la definición de `aggregate` (antes de `export_csv`):

```ts
  {
    name: "meta_ads_report",
    description:
      "Gasto de Meta Ads cruzado con el CRM por id de anuncio. ÚSALA para cualquier pregunta de costo: gasto, CPL, CPA, CPM, CTR, 'cuánto gastamos', 'qué campaña rinde mejor'. NUNCA calcules costos dividiendo a mano ni sumando gasto de otras herramientas. Devuelve { currency, window, rows: [{ key, label, currency, spend, impressions, clicks, cpm, ctr, leadsMeta, leadsCrm, won, cpl, cpa, contactIds? }] }. leadsMeta = conversiones que Meta cobró; leadsCrm = oportunidades reales creadas en la ventana con ese anuncio; CPL y CPA usan leadsCrm — di cuál reportas. Una fila con currency '?' mezcla monedas: reporta por moneda, no consolides. El gasto solo se filtra por fecha y campaña, nunca por asesor/origen/etapa. Con includeContactIds: true cada fila trae contactIds para render_chart en UNA llamada.",
    input_schema: {
      type: "object",
      properties: {
        groupBy: {
          type: "string",
          enum: ["none", "campaign", "adset", "ad", "month"],
          description: "'none' = un total; 'campaign' es lo habitual; 'month' para tendencias (cronológico).",
        },
        since: { type: "string", description: "YYYY-MM-DD (día local CDMX), inclusive. Omite ambos para todo el historial." },
        until: { type: "string", description: "YYYY-MM-DD (día local CDMX), inclusive." },
        campaign: { type: "string", description: "Acota a las campañas cuyo nombre contenga este texto (sin acentos ni mayúsculas)." },
        includeContactIds: { type: "boolean", description: "Adjunta contactIds (distintos, tope 50) por fila para gráficas drillables." },
        limit: { type: "number", description: "Máximo de filas (default 50)." },
      },
      required: ["groupBy"],
    },
  },
```

- [ ] **Step 3: El ejecutor** — en `executeTool`, después de `case "aggregate":`:

```ts
    case "meta_ads_report":
      return metaAdsReport(input, data, getChatIndex(data));
```

Y la función, junto a `aggregate` (antes de `function searchPautas`):

```ts
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function metaAdsReport(input: ToolInput, data: ChatDataset, index: ChatIndex) {
  if (!data.metaAds || !index.metaIndex) {
    return { error: "meta_not_connected", message: "Meta Ads no está conectado en este proyecto: no hay datos de gasto." };
  }
  const groupBy = input.groupBy as MetaGroupBy;
  if (!["none", "campaign", "adset", "ad", "month"].includes(groupBy)) {
    return { error: "invalid_groupBy" };
  }
  const since = typeof input.since === "string" && DAY_RE.test(input.since) ? input.since : null;
  const until = typeof input.until === "string" && DAY_RE.test(input.until) ? input.until : null;
  const range = since || until ? { since: since ?? "0000-01-01", until: until ?? "9999-12-31" } : null;
  const limit = clampLimit(input.limit);
  const rows = buildMetaReport({
    opportunities: data.opportunities,
    meta: data.metaAds,
    index: index.metaIndex,
    range,
    pautaContacts: index.pautasByContact,
    groupBy,
    campaign: typeof input.campaign === "string" ? input.campaign : undefined,
    includeIds: input.includeContactIds === true,
  });
  return {
    currency: defaultCurrency(data.metaAds) ?? "?",
    window: range ?? data.metaAds.window,
    accounts: data.metaAds.accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency })),
    total: rows.length,
    rows: rows.slice(0, limit).map((r) => {
      const { oppIds: _omit, ...rest } = r;
      return rest;
    }),
  };
}
```

Imports en `lib/ai-tools.ts`: `import { buildMetaReport, defaultCurrency, type MetaGroupBy } from "./meta-attribution";`. `clampLimit` ya existe en el archivo (`grep -n "function clampLimit" lib/ai-tools.ts`).

- [ ] **Step 4: Bloque en `buildDatasetSummary`** (`lib/ai-context.ts`), antes de `return lines.join("\n")`:

```ts
  // Meta Ads: que el modelo sepa si hay gasto, cuánto y qué tan bien cruza.
  // Determinista y estable entre turnos: el bloque entra al prompt cacheado.
  lines.push("\n=== META ADS ===");
  if (!data.metaAds) {
    lines.push("No conectado en este proyecto. No hay datos de gasto: dilo, no estimes costos.");
  } else {
    const m = data.metaAds;
    const idx = buildMetaIndex(m);
    const pautaContacts = new Set(data.pautas.map((p) => p.contactId).filter((x): x is string => !!x));
    const cur = defaultCurrency(m) ?? "?";
    lines.push(
      `Conectado: ${m.accounts.length} cuenta(s) (${m.accounts.map((a) => `${a.name} ${a.currency}`).join(", ")}). Ventana: ${m.window.since} → ${m.window.until}.`
    );
    const byMonth = buildMetaReport({ opportunities: data.opportunities, meta: m, index: idx, range: null, pautaContacts, groupBy: "month" });
    const totalSpend = byMonth.reduce((a, r) => a + r.spend, 0);
    lines.push(`Gasto total: ${fmtMoney(totalSpend, cur)}. Por mes: ${byMonth.map((r) => `${r.key} ${fmtMoney(r.spend, cur)}`).join(" · ")}`);
    const top = buildMetaReport({ opportunities: data.opportunities, meta: m, index: idx, range: null, pautaContacts, groupBy: "campaign" }).slice(0, 8);
    lines.push(`Top campañas por gasto: ${top.map((r) => `"${r.label}" ${fmtMoney(r.spend, r.currency)} (${r.leadsCrm} leads CRM)`).join(" · ")}`);
    const counts = { exact: 0, unknownAd: 0, noAdId: 0, notPauta: 0 };
    for (const o of data.opportunities) counts[classifyLead(o, { index: idx, pautaContacts })]++;
    lines.push(
      `Cruce con el CRM: ${counts.exact} oportunidades con anuncio en Meta (entran al costo), ${counts.unknownAd} con anuncio fuera de las cuentas asignadas, ${counts.noAdId} de pauta sin ad id. Usa meta_ads_report para cualquier costo.`
    );
  }
```

Con el helper (arriba en el archivo, junto a `isoDay`):

```ts
function fmtMoney(n: number, currency: string): string {
  const num = n.toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === "?" ? `$${num}` : `$${num} ${currency}`;
}
```

Imports: `import { buildMetaIndex, buildMetaReport, classifyLead, defaultCurrency } from "./meta-attribution";`.

- [ ] **Step 5: Reglas 9-13 en `ASSISTANT_SYSTEM_PROMPT`** — después del bloque de la regla 8 (antes de la línea en blanco que precede a `# Cuándo preguntar (ask_user)`):

```
9. **Costos SIEMPRE con \`meta_ads_report\`**: gasto, CPL, CPA, CPM, CTR y "cuánto gastamos" salen de esa herramienta. NUNCA dividas gasto entre leads a mano, ni sumes gasto de resultados de otras herramientas, ni estimes un costo desde el resumen del dataset.
10. **"Leads Meta" ≠ "Leads CRM"**: \`leadsMeta\` son conversiones que Meta cobró; \`leadsCrm\` son oportunidades reales creadas en la ventana con ese anuncio. CPL y CPA usan \`leadsCrm\`. Di siempre cuál reportas, y si difieren mucho, señálalo — leads pagados que no llegaron al CRM son un hallazgo.
11. **El gasto no se filtra por asesor, origen ni etapa**, solo por fecha y campaña. Si piden "el CPL de Ana" o "el costo de los perdidos", explica que el gasto es de la campaña, no del asesor ni del resultado, y ofrece el CPL por campaña o el conteo de leads de Ana por separado.
12. **Moneda de la cuenta, sin convertir**: reporta en la \`currency\` que devuelva la herramienta. Si una fila trae \`currency: "?"\`, mezcla monedas: reporta por moneda y no consolides ni compares.
13. **Sin Meta conectado, dilo**: si el resumen dice "No conectado" o la herramienta devuelve \`meta_not_connected\`, responde que este proyecto no tiene Meta Ads conectado y no inventes ni aproximes costos.
```

- [ ] **Step 6: tsc, verify y prueba con el asistente real**

```bash
npx tsc --noEmit
pnpm verify:write-tools   # sigue verde: la herramienta nueva es de lectura
pnpm dev
```

Lezgo Suite → pestaña Asistente IA:
- "¿Cuánto gastamos en Meta en julio?" → una llamada `meta_ads_report{groupBy:"none", since:"2026-07-01", until:"2026-07-31"}` y responde **$12,825.99 MXN**.
- "¿Qué campaña tuvo el CPL más bajo en agosto?" → `groupBy:"campaign"` con el rango; responde con leads CRM y aclara que son del CRM.
- "Hazme una gráfica de gasto por mes" → `groupBy:"month"` + `render_chart`.
- "¿Cuál es el CPL de [un asesor]?" → explica la regla 11.

Yconia → "¿cuánto gastamos en pauta?" → responde que Meta no está conectado, sin llamar herramientas de costo.

- [ ] **Step 7: Commit**

```bash
git add lib/ai-tools.ts lib/ai-index.ts lib/ai-context.ts components/dashboard/dashboard-app.tsx
git commit -m "feat(meta): el asistente conoce Meta Ads — bloque en el resumen, herramienta meta_ads_report y reglas de costo"
```

---

### Task 5: documentación y verificación completa

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Sección "### Meta Ads" de CLAUDE.md**

Cambiar la frase de estado del segundo párrafo a: "Entrega ① — conexión, dataset en el sync y cruce — y ② — sección "Inversión en pauta" en Marketing y PDF, y el asistente — implementadas (spec ②: `docs/superpowers/specs/2026-09-14-meta-ads-inversion-y-asistente-design.md`)."

Agregar antes de la viñeta "**Conectado en producción el 2026-09-14**":

```markdown
- **Un solo motor para los tres consumidores**: `buildMetaReport(groupBy)` en
  `lib/meta-attribution.ts` alimenta la tabla de "Inversión en pauta"
  (`meta-investment-section.tsx`, `groupBy: "campaign"`), la sección del PDF
  (`buildMetaReportSection`, mismo archivo) y la herramienta `meta_ads_report` del
  asistente. Si un número difiere entre los tres, el bug está en el consumidor, no en
  el cálculo. `useMetaInvestment` memoiza índice, resumen y filas por referencia de
  `metaAds`; Marketing lo llama una vez y lo comparte con `buildReport()`.
- **El gasto no se recorta por atributo.** Con Asesor/Status/Origen/Tipo de pauta
  activos, `gasto ÷ leads de un asesor` sería un CPL falso: la sección muestra Leads
  CRM y Ganadas recortados y **CPL/CPA en `—`** (`costsSuppressed`), y el `ScopePill`
  lo dice. El asistente tiene la misma regla (regla 11 del prompt).
- **Sin `metaAds` la sección no se dibuja** (ni en pantalla ni en el PDF) y el
  resumen del asistente dice "No conectado": la píldora del header es el único
  llamado a conectar.
- Un ad borrado/archivado sigue teniendo insights pero ya no está en `/ads`: sin
  jerarquía, `currencyOf` hereda la única moneda de las cuentas (`defaultCurrency`),
  para que un ad huérfano no dispare `mixedCurrency` y apague los costos.
```

- [ ] **Step 2: Verificación completa**

```bash
pnpm verify:meta-attribution && pnpm verify:meta && pnpm verify:meta-oauth && pnpm verify:write-tools && pnpm verify:filters
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(meta): entrega ② en CLAUDE.md — un motor, la regla de filtros y el asistente"
```

---

### Task 6: contra realidad en producción

Sin código. Tras merge + push:

- [ ] Lezgo Suite, filtro julio 2026 → tile Gasto `$12,825.99 MXN`; agosto `$9,817.97 MXN` (los números cuadrados en ①).
- [ ] Asesor activo → CPL/CPA `—`.
- [ ] PDF con "Inversión en pauta" y análisis.
- [ ] Asistente: "¿cuánto gastamos en julio?" → `$12,825.99 MXN`.
- [ ] Yconia: sin sección; asistente responde "no conectado".
- [ ] Sesión `iw` en Condesa (sin cuenta asignada): nada cambia.
