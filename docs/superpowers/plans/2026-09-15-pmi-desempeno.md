# PMI — pestaña "Desempeño" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reproducir el PMI de la consultoría (indicadores por asesor y equipo, por semana del mes y por año) calculado desde el CRM, en una pestaña "Desempeño" con PDF.

**Architecture:** Tres hitos por oportunidad (`perfilado`, `apartado`, `cierre`) definidos por NOMBRE de etapa, fechados por una bitácora propia en Neon (`opportunity_milestones`) que `syncProject` reconcilia en cada sync y cuelga a cada `Opportunity` como `milestones`. Todo el cálculo (`lib/pmi.ts`) es puro y corre en el navegador sobre `contacts + opportunities + appointments`, como Marketing y Ventas; la pestaña y el PDF son consumidores.

**Tech Stack:** Next.js 16 App Router, TypeScript, `@neondatabase/serverless`, Recharts vía `components/ui/chart.tsx`, pdfmake vía `lib/pdf/*`, scripts de verificación con `node:assert/strict` + `tsx`.

**Spec:** `docs/superpowers/specs/2026-09-15-pmi-desempeno-design.md`

## Global Constraints

- Paquete CJS: **sin top-level `await`** en scripts — `main().catch(...)`.
- `pnpm`, nunca `npm install`.
- `npx tsc --noEmit` es obligatorio: `next build` ignora errores de TS.
- Fechas SIEMPRE en día local `America/Mexico_City` (`localDay` de `lib/meta-attribution.ts`).
- `opportunity_milestones` **no es desechable**; nunca `UPDATE`/`DELETE` desde la app.
- Ninguna falla de Postgres puede tumbar el sync: registrar y seguir.
- UI: `ChartCardHeader` + `ScopePill`, `NonZeroTooltipContent`, sin leyendas, sin scroll dentro de cards, ámbar (`#F59B1B`) solo donde va la atención. Vocabulario "proyecto" en UI, `client` en código.
- Nada de GHL desde componentes: solo `lib/types.ts`.
- Cada commit termina con las líneas de atribución de la sesión.

---

## File map

| Archivo | Responsabilidad |
|---|---|
| `lib/pmi-stages.ts` (nuevo) | Vocabulario de hitos por nombre de etapa; `effectiveStage`, `milestonesOfStage`, `projectHasMilestoneStages` |
| `lib/types.ts` (mod) | `OpportunityMilestones`, `Opportunity.milestones?` |
| `lib/pmi-ledger.ts` (nuevo) | `reconcileMilestones` puro |
| `lib/pmi-ledger-store.ts` (nuevo) | `readMilestones` / `insertMilestones` SQL |
| `scripts/db-migrate.ts` (mod) | tabla `opportunity_milestones` |
| `lib/sync.ts` (mod) | reconciliación en `syncProject` |
| `lib/pmi.ts` (nuevo) | motor: semanas, eventos, mes, año, semáforo, conversiones, rankings |
| `components/dashboard/pmi-ui.tsx` (nuevo) | chrome compartido: `pmiTone`, formatos, `PmiTile`, `ConversionStrip`, `EstimatedNote` |
| `components/dashboard/pmi-week-table.tsx` (nuevo) | indicadores × semana con drill |
| `components/dashboard/pmi-advisor-sheet.tsx` (nuevo) | cuadrícula diaria del asesor |
| `components/dashboard/pmi-year-table.tsx` (nuevo) | vista anual |
| `components/dashboard/pmi-dashboard.tsx` (nuevo) | la pestaña: cabecera, vistas, drill drawer, export |
| `components/dashboard/dashboard-app.tsx` (mod) | pestaña `pmi`, ocultar barra |
| `lib/pmi-report.ts` (nuevo) | `buildPmiReport` → `ReportInput` |
| `lib/report.ts`, `app/api/analyze-report/route.ts` (mod) | `reportType: "pmi"` |
| `scripts/verify-pmi.ts`, `scripts/verify-pmi-ledger.ts` (nuevos) | aserciones |
| `package.json`, `CLAUDE.md` (mod) | scripts y documentación |

---

### Task 1: `lib/pmi-stages.ts` — hitos por nombre de etapa

**Files:**
- Create: `lib/pmi-stages.ts`
- Create: `scripts/verify-pmi.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces:
  ```ts
  export type Milestone = "perfilado" | "apartado" | "cierre"
  export const MILESTONES: readonly Milestone[]
  export function normalizeStage(name: string): string
  export function effectiveStage(opp: Opportunity): string | null
  export function milestonesOfStage(stageName: string | null): Set<Milestone>
  export function projectHasMilestoneStages(pipelines: Pipeline[]): boolean
  ```

- [ ] **Step 1: Write the failing verify script**

```ts
// scripts/verify-pmi.ts
// Verification for lib/pmi-stages.ts and lib/pmi.ts. Run: pnpm verify:pmi
//
// Wrapped in main() rather than using top-level await: this package is CJS
// ("type" is not "module"), so tsx compiles to CJS where TLA is unavailable.
import assert from "node:assert/strict";
import {
  effectiveStage,
  milestonesOfStage,
  projectHasMilestoneStages,
} from "../lib/pmi-stages";
import type { Opportunity, Pipeline } from "../lib/types";

function opp(p: Partial<Opportunity>): Opportunity {
  return {
    id: "o1", name: "", pipelineId: "p", pipelineStageId: "s", status: "open",
    createdAt: "2026-09-01T12:00:00.000Z", contactId: "c1", value: 0,
    stage: "Lead Recibido", pipelineName: "Ventas", ...p,
  };
}

function stagesMain() {
  const has = (name: string, ...ms: string[]) =>
    assert.deepEqual([...milestonesOfStage(name)].sort(), [...ms].sort(), name);

  // Los cinco pipelines reales (cache 2026-09-15). "10." es Ganado en Yconia e
  // Inversión Futura en los demás: por eso se compara por NOMBRE.
  has("02. Cliente Calificado", "perfilado");
  has("03. Cita Agendada", "perfilado");
  has("04. Visita Al Desarrollo", "perfilado");        // Plaza Bosques, mayúscula
  has("04. Visita al Desarrollo", "perfilado");        // Yconia
  has("12. Inversión Futura", "perfilado");
  has("10. Inversión Futura", "perfilado");            // NO es cierre
  has("05. Cotización / Negociación", "perfilado");
  has("06. Apartado", "perfilado", "apartado");
  has("07. Pago de Mensualidades", "perfilado", "apartado");
  has("08. Proceso de Escritura", "perfilado", "apartado", "cierre");
  has("09. Siguiente Escritura", "perfilado", "apartado", "cierre");
  has("09. Negocio Ganado", "perfilado", "apartado", "cierre");
  has("10. Negocio Ganado", "perfilado", "apartado", "cierre");
  has("11. Entregado");                                // fuera del vocabulario, sin hitos
  has("Lead Recibido (Ventas)");
  has("1er Contacto");
  has("01. Contacto En Seguimiento");
  has("Last Call");
  has("Renta");
  has("Negocio Perdido");
  has("Primera Cita", "perfilado");                    // Lezgo Suite cae en "cita" — la
                                                       // pestaña se apaga por pipelines, abajo
  assert.equal(milestonesOfStage(null).size, 0);

  // effectiveStage: abierta → su etapa; perdida → "Última Etapa en el Pipeline"
  assert.equal(effectiveStage(opp({ stage: "06. Apartado" })), "06. Apartado");
  assert.equal(
    effectiveStage(opp({ status: "lost", stage: "Negocio Perdido",
      customFieldsResolved: { "Última Etapa en el Pipeline": "04. Visita al Desarrollo" } })),
    "04. Visita al Desarrollo",
  );
  assert.equal(
    effectiveStage(opp({ status: "lost", stage: "Negocio Perdido",
      customFieldsResolved: { "Última Etapa en el Pipeline": "Negocio Perdido" } })),
    null, "última etapa 'Negocio Perdido' no es una etapa",
  );
  assert.equal(effectiveStage(opp({ status: "lost", stage: "Negocio Perdido" })), null);
  // Etapa "Negocio Perdido" con status open (cuentas que no ponen status): también perdida
  assert.equal(
    effectiveStage(opp({ stage: "Negocio Perdido",
      customFieldsResolved: { "Última Etapa en el Pipeline": "02. Cliente Calificado" } })),
    "02. Cliente Calificado",
  );

  // projectHasMilestoneStages: Yconia sí, Lezgo Suite no
  const yconia: Pipeline[] = [{ id: "a", name: "Ventas", stages: ["Lead Recibido", "02. Cliente Calificado", "06. Apartado"] }];
  const lezgo: Pipeline[] = [{ id: "b", name: "Ventas", stages: ["Primera Cita", "Envío de propuesta", "Cliente Activo"] }];
  assert.equal(projectHasMilestoneStages(yconia), true);
  assert.equal(projectHasMilestoneStages(lezgo), false, "sin etapa de apartado no hay PMI");
  assert.equal(projectHasMilestoneStages([]), false);
}

async function main() {
  stagesMain();
  console.log("✅ verify:pmi — etapas");
}

main().catch((err) => { console.error(err); process.exit(1); });
```

Nota de diseño que sale de escribir esta prueba: `projectHasMilestoneStages` exige una etapa de **apartado** (no solo cualquier hito), porque "Primera Cita" de Lezgo Suite cae en "cita" y encendería la pestaña en un pipeline de servicios.

- [ ] **Step 2: Add the npm script and run it to verify it fails**

En `package.json`, después de `"verify:meta-attribution"`:

```json
    "verify:pmi": "tsx scripts/verify-pmi.ts",
    "verify:pmi-ledger": "tsx --env-file-if-exists=.env.local scripts/verify-pmi-ledger.ts",
```

Run: `pnpm verify:pmi`
Expected: FAIL — `Cannot find module '../lib/pmi-stages'`

- [ ] **Step 3: Implement `lib/pmi-stages.ts`**

```ts
// lib/pmi-stages.ts
// Los tres hitos del PMI, definidos por NOMBRE de etapa. Puro: lo importan el
// sync (servidor) y la pestaña (navegador).
//
// Por nombre y no por número: los cinco proyectos inmobiliarios comparten
// "02. Cliente Calificado" / "06. Apartado" / "08. Proceso de Escritura", pero
// "10." es Negocio Ganado en Yconia e Inversión Futura en Condesa, Plaza Bosques,
// Grand Center y Balvanera. Una regla por número contaría inversiones futuras
// como cierres.
import type { Opportunity, Pipeline } from "./types";

export type Milestone = "perfilado" | "apartado" | "cierre";
export const MILESTONES: readonly Milestone[] = ["perfilado", "apartado", "cierre"];

// Substrings sobre el nombre normalizado (minúsculas, sin acentos). Acumulativos:
// una etapa de cierre también es apartado y perfilado.
const PERFILADO_TERMS = [
  "calificado", "cita", "visita", "inversion futura", "cotizacion",
  "apartado", "mensualidades", "escritura", "ganad",
];
const APARTADO_TERMS = ["apartado", "mensualidades", "escritura", "ganad"];
const CIERRE_TERMS = ["escritura", "ganad"];

const LOST_STAGE = "negocio perdido";
const LAST_STAGE_FIELD = "Última Etapa en el Pipeline";

export function normalizeStage(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

function matches(normalized: string, terms: string[]): boolean {
  return terms.some((t) => normalized.includes(t));
}

// La etapa que se juzga: la actual, o si la oportunidad está perdida, la que
// registró la automatización en "Última Etapa en el Pipeline". Perdida = status
// lost O etapa "Negocio Perdido" (hay cuentas que mueven la etapa sin tocar el
// status). Si el campo dice a su vez "Negocio Perdido" o falta → null: no hay
// hitos que contar.
export function effectiveStage(opp: Opportunity): string | null {
  const current = opp.stage ?? "";
  const lost = opp.status === "lost" || normalizeStage(current) === LOST_STAGE;
  if (!lost) return current || null;
  const raw = opp.customFieldsResolved?.[LAST_STAGE_FIELD];
  const last = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  if (!last || normalizeStage(last) === LOST_STAGE) return null;
  return last;
}

export function milestonesOfStage(stageName: string | null): Set<Milestone> {
  const out = new Set<Milestone>();
  if (!stageName) return out;
  const n = normalizeStage(stageName);
  if (n === LOST_STAGE) return out;
  if (matches(n, PERFILADO_TERMS)) out.add("perfilado");
  if (matches(n, APARTADO_TERMS)) out.add("apartado");
  if (matches(n, CIERRE_TERMS)) out.add("cierre");
  return out;
}

// Decide si el proyecto ve la pestaña: detección por presencia, como los
// segmentos Plaza/Agencia. Exige una etapa de APARTADO y no cualquier hito:
// "Primera Cita" (Lezgo Suite, pipeline de servicios) cae en "cita" y
// encendería el PMI donde no hay nada que medir.
export function projectHasMilestoneStages(pipelines: Pipeline[]): boolean {
  return pipelines.some((p) =>
    p.stages.some((s) => milestonesOfStage(s).has("apartado")),
  );
}
```

- [ ] **Step 4: Run the verify script**

Run: `pnpm verify:pmi`
Expected: `✅ verify:pmi — etapas`

- [ ] **Step 5: Commit**

```bash
git add lib/pmi-stages.ts scripts/verify-pmi.ts package.json
git commit -m "feat(pmi): hitos por nombre de etapa — perfilado / apartado / cierre

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F3a3LMFv11x6QrYvLrpk51"
```

---

### Task 2: `lib/pmi-ledger.ts` — reconciliación pura + tipo `milestones`

**Files:**
- Modify: `lib/types.ts` (dentro de `Opportunity`, después de `originPlatform`)
- Create: `lib/pmi-ledger.ts`
- Create: `scripts/verify-pmi-ledger.ts`

**Interfaces:**
- Consumes: `effectiveStage`, `milestonesOfStage`, `MILESTONES`, `Milestone` (Task 1)
- Produces:
  ```ts
  // lib/types.ts
  export interface OpportunityMilestones {
    perfilado?: string; apartado?: string; cierre?: string; estimated?: boolean
  }
  // lib/pmi-ledger.ts
  export interface MilestoneRow { opportunityId: string; milestone: Milestone; reachedAt: string; estimated: boolean }
  export function reconcileMilestones(existing: MilestoneRow[], opps: Opportunity[], now: Date):
    { inserts: MilestoneRow[]; byOpportunity: Map<string, OpportunityMilestones> }
  ```

- [ ] **Step 1: Add the type to `lib/types.ts`**

Justo antes de `export interface Opportunity {`:

```ts
// Fechas ISO en que la oportunidad alcanzó cada hito del PMI (lib/pmi-stages.ts),
// tomadas de la bitácora opportunity_milestones. `estimated` marca las que se
// rellenaron con updatedAt la primera vez que un proyecto entró a la bitácora:
// GHL no guarda cuándo una oportunidad entró a su etapa.
export interface OpportunityMilestones {
  perfilado?: string
  apartado?: string
  cierre?: string
  estimated?: boolean
}
```

Y dentro de `Opportunity`, después de `originPlatform?: string     // computed: ...`:

```ts
  milestones?: OpportunityMilestones // computed (lib/pmi-ledger.ts): ausente en payloads anteriores a la bitácora
```

- [ ] **Step 2: Write the failing verify script (pure part)**

```ts
// scripts/verify-pmi-ledger.ts
// Verification for lib/pmi-ledger.ts (+ store). Run: pnpm verify:pmi-ledger
//
// La bitácora es la única tabla del panel con historia que no se reconstruye
// desde GHL: un bug aquí borra o inventa la fecha de un apartado. Las
// aserciones puras corren siempre; el roundtrip contra Postgres solo con
// DATABASE_URL, con ids __verify_* que el roster no puede producir.
//
// Wrapped in main() rather than using top-level await: this package is CJS
// ("type" is not "module"), so tsx compiles to CJS where TLA is unavailable.
import assert from "node:assert/strict";
import { reconcileMilestones, type MilestoneRow } from "../lib/pmi-ledger";
import type { Opportunity } from "../lib/types";

function opp(p: Partial<Opportunity>): Opportunity {
  return {
    id: "o1", name: "", pipelineId: "p", pipelineStageId: "s", status: "open",
    createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-20T12:00:00.000Z",
    contactId: "c1", value: 0, stage: "Lead Recibido", pipelineName: "Ventas", ...p,
  };
}

const NOW = new Date("2026-09-15T18:00:00.000Z");
const NOW_ISO = NOW.toISOString();

function pureMain() {
  // 1. Bitácora vacía = primera vez: todo hito vale updatedAt y va estimado.
  {
    const { inserts, byOpportunity } = reconcileMilestones(
      [],
      [opp({ id: "a", stage: "08. Proceso de Escritura" }), opp({ id: "b", stage: "Lead Recibido" })],
      NOW,
    );
    assert.deepEqual(
      inserts.map((r) => [r.opportunityId, r.milestone, r.reachedAt, r.estimated]).sort(),
      [
        ["a", "apartado", "2026-08-20T12:00:00.000Z", true],
        ["a", "cierre", "2026-08-20T12:00:00.000Z", true],
        ["a", "perfilado", "2026-08-20T12:00:00.000Z", true],
      ],
    );
    assert.deepEqual(byOpportunity.get("a"), {
      perfilado: "2026-08-20T12:00:00.000Z", apartado: "2026-08-20T12:00:00.000Z",
      cierre: "2026-08-20T12:00:00.000Z", estimated: true,
    });
    assert.equal(byOpportunity.has("b"), false, "sin hitos no hay entrada");
  }

  // 1b. Sin updatedAt cae a createdAt.
  {
    const { inserts } = reconcileMilestones([], [opp({ id: "a", stage: "06. Apartado", updatedAt: undefined })], NOW);
    assert.ok(inserts.every((r) => r.reachedAt === "2026-08-01T12:00:00.000Z" && r.estimated));
  }

  // 2. Con filas existentes solo se insertan los hitos nuevos, fechados en `now`.
  {
    const existing: MilestoneRow[] = [
      { opportunityId: "a", milestone: "perfilado", reachedAt: "2026-09-02T10:00:00.000Z", estimated: false },
    ];
    const { inserts, byOpportunity } = reconcileMilestones(
      existing, [opp({ id: "a", stage: "06. Apartado" })], NOW,
    );
    assert.deepEqual(inserts, [{ opportunityId: "a", milestone: "apartado", reachedAt: NOW_ISO, estimated: false }]);
    assert.deepEqual(byOpportunity.get("a"), { perfilado: "2026-09-02T10:00:00.000Z", apartado: NOW_ISO });
  }

  // 3. Un hito nunca se retira: retrocedió a seguimiento, el apartado sigue.
  {
    const existing: MilestoneRow[] = [
      { opportunityId: "a", milestone: "perfilado", reachedAt: "2026-09-02T10:00:00.000Z", estimated: false },
      { opportunityId: "a", milestone: "apartado", reachedAt: "2026-09-05T10:00:00.000Z", estimated: false },
    ];
    const { inserts, byOpportunity } = reconcileMilestones(
      existing, [opp({ id: "a", stage: "01. Contacto En Seguimiento" })], NOW,
    );
    assert.equal(inserts.length, 0);
    assert.equal(byOpportunity.get("a")?.apartado, "2026-09-05T10:00:00.000Z");
  }

  // 4. Perdida con última etapa cualificada: hitos por esa etapa.
  {
    const { inserts } = reconcileMilestones(
      [{ opportunityId: "z", milestone: "perfilado", reachedAt: "2026-01-01T00:00:00.000Z", estimated: false }],
      [opp({ id: "a", status: "lost", stage: "Negocio Perdido",
        customFieldsResolved: { "Última Etapa en el Pipeline": "06. Apartado" } })],
      NOW,
    );
    assert.deepEqual(inserts.map((r) => r.milestone).sort(), ["apartado", "perfilado"]);
    assert.ok(inserts.every((r) => r.reachedAt === NOW_ISO && !r.estimated));
  }

  // 5. Filas de oportunidades que ya no existen en el payload no rompen nada ni
  //    aparecen en byOpportunity (la bitácora guarda historia, el payload el presente).
  {
    const { inserts, byOpportunity } = reconcileMilestones(
      [{ opportunityId: "gone", milestone: "cierre", reachedAt: "2026-01-01T00:00:00.000Z", estimated: false }],
      [opp({ id: "a", stage: "Lead Recibido" })],
      NOW,
    );
    assert.equal(inserts.length, 0);
    assert.equal(byOpportunity.size, 0);
  }

  // 6. `estimated` en byOpportunity solo si ALGÚN hito lo es.
  {
    const { byOpportunity } = reconcileMilestones(
      [{ opportunityId: "a", milestone: "perfilado", reachedAt: "2026-06-01T00:00:00.000Z", estimated: true }],
      [opp({ id: "a", stage: "06. Apartado" })],
      NOW,
    );
    assert.equal(byOpportunity.get("a")?.estimated, true);
  }
}

async function main() {
  pureMain();
  console.log("✅ verify:pmi-ledger — reconciliación pura");
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm verify:pmi-ledger`
Expected: FAIL — `Cannot find module '../lib/pmi-ledger'`

- [ ] **Step 4: Implement `lib/pmi-ledger.ts`**

```ts
// lib/pmi-ledger.ts
// Reconciliación de la bitácora de hitos: qué filas nuevas escribir y qué
// fechas colgarle a cada oportunidad. Puro — el SQL vive en pmi-ledger-store.ts.
//
// La bitácora existe porque GHL no guarda cuándo una oportunidad entró a una
// etapa y closedAt viene vacío. Cada sync compara la etapa actual contra lo ya
// anotado y registra la PRIMERA vez que cruza cada hito. Una fila existente
// manda sobre la etapa actual: un apartado que se cae sigue siendo apartado del
// mes en que ocurrió, que es como lo cuenta el PMI.
import type { Opportunity, OpportunityMilestones } from "./types";
import { effectiveStage, milestonesOfStage, type Milestone } from "./pmi-stages";

export interface MilestoneRow {
  opportunityId: string;
  milestone: Milestone;
  reachedAt: string; // ISO
  estimated: boolean;
}

export function reconcileMilestones(
  existing: MilestoneRow[],
  opps: Opportunity[],
  now: Date,
): { inserts: MilestoneRow[]; byOpportunity: Map<string, OpportunityMilestones> } {
  const known = new Map<string, MilestoneRow>();
  for (const r of existing) known.set(`${r.opportunityId} ${r.milestone}`, r);

  // Primera vez que el proyecto entra a la bitácora: no hay historia, así que
  // updatedAt es la mejor estimación de GHL y se marca como tal. Solo la
  // primera vez — después, un hito nuevo ocurrió entre este sync y el anterior.
  const firstRun = existing.length === 0;
  const nowIso = now.toISOString();

  const inserts: MilestoneRow[] = [];
  const byOpportunity = new Map<string, OpportunityMilestones>();

  for (const opp of opps) {
    const reached = milestonesOfStage(effectiveStage(opp));
    const out: OpportunityMilestones = {};
    let estimated = false;

    for (const m of reached) {
      const key = `${opp.id} ${m}`;
      if (known.has(key)) continue;
      const row: MilestoneRow = firstRun
        ? { opportunityId: opp.id, milestone: m, reachedAt: opp.updatedAt ?? opp.createdAt, estimated: true }
        : { opportunityId: opp.id, milestone: m, reachedAt: nowIso, estimated: false };
      known.set(key, row);
      inserts.push(row);
    }

    for (const m of ["perfilado", "apartado", "cierre"] as const) {
      const row = known.get(`${opp.id} ${m}`);
      if (!row) continue;
      out[m] = row.reachedAt;
      if (row.estimated) estimated = true;
    }
    if (out.perfilado || out.apartado || out.cierre) {
      if (estimated) out.estimated = true;
      byOpportunity.set(opp.id, out);
    }
  }

  return { inserts, byOpportunity };
}
```

- [ ] **Step 5: Run the verify script**

Run: `pnpm verify:pmi-ledger`
Expected: `✅ verify:pmi-ledger — reconciliación pura`

- [ ] **Step 6: Commit**

```bash
git add lib/types.ts lib/pmi-ledger.ts scripts/verify-pmi-ledger.ts
git commit -m "feat(pmi): reconciliación pura de la bitácora de hitos + Opportunity.milestones

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F3a3LMFv11x6QrYvLrpk51"
```

---

### Task 3: `opportunity_milestones` — migración y store

**Files:**
- Modify: `scripts/db-migrate.ts`
- Create: `lib/pmi-ledger-store.ts`
- Modify: `scripts/verify-pmi-ledger.ts` (roundtrip contra Postgres)

**Interfaces:**
- Consumes: `MilestoneRow` (Task 2), `getSql`, `ClientConfig`
- Produces:
  ```ts
  export async function readMilestones(client: ClientConfig): Promise<MilestoneRow[]>
  export async function insertMilestones(client: ClientConfig, rows: MilestoneRow[]): Promise<void>
  export async function deleteMilestonesForVerify(projectId: string): Promise<void> // solo ids __verify_*
  ```

- [ ] **Step 1: Add the table to `scripts/db-migrate.ts`**

Después del bloque `meta_project_accounts` y antes del `for (const table of …)`:

```ts
  // La bitácora de hitos del PMI: la PRIMERA vez que cada oportunidad cruzó
  // perfilado / apartado / cierre. NO es desechable: GHL no guarda cuándo una
  // oportunidad entró a su etapa, así que borrar esta tabla pierde esas fechas
  // para siempre. Solo ids y fechas — sin datos personales.
  await sql`
    CREATE TABLE IF NOT EXISTS opportunity_milestones (
      project_id     text        NOT NULL,
      opportunity_id text        NOT NULL,
      milestone      text        NOT NULL,
      reached_at     timestamptz NOT NULL,
      estimated      boolean     NOT NULL DEFAULT false,
      PRIMARY KEY (project_id, opportunity_id, milestone)
    )
  `;
```

Y en el `for`, agregar `"opportunity_milestones"` a la lista. Actualizar el comentario de cabecera: `// Crea las tablas del caché, de Meta y de la bitácora del PMI.`

- [ ] **Step 2: Run the migration locally**

Run: `pnpm db:migrate`
Expected: imprime `✅ opportunity_milestones lista:` con las cinco columnas.

- [ ] **Step 3: Extend the verify script with the DB roundtrip (fails: no store yet)**

En `scripts/verify-pmi-ledger.ts`, agregar imports y el bloque de base:

```ts
import { readMilestones, insertMilestones, deleteMilestonesForVerify } from "../lib/pmi-ledger-store";
import type { ClientConfig } from "../lib/clients";

// Ids que el roster no puede producir: ID_RE prohíbe guiones bajos.
const A: ClientConfig = { id: "__verify_pmi_a", name: "A", locationId: "loc-a", ghlToken: "pit-a" };
const B: ClientConfig = { id: "__verify_pmi_b", name: "B", locationId: "loc-b", ghlToken: "pit-b" };

async function dbMain() {
  if (!process.env.DATABASE_URL) {
    console.log("ℹ️  DATABASE_URL no está: se omite el roundtrip contra Postgres");
    return;
  }
  await deleteMilestonesForVerify(A.id);
  await deleteMilestonesForVerify(B.id);
  try {
    assert.deepEqual(await readMilestones(A), [], "proyecto sin filas");

    const rows: MilestoneRow[] = [
      { opportunityId: "o1", milestone: "perfilado", reachedAt: "2026-09-02T10:00:00.000Z", estimated: false },
      { opportunityId: "o1", milestone: "apartado", reachedAt: "2026-09-05T10:00:00.000Z", estimated: true },
    ];
    await insertMilestones(A, rows);
    await insertMilestones(B, [{ opportunityId: "o1", milestone: "cierre", reachedAt: "2026-09-09T10:00:00.000Z", estimated: false }]);

    const a = (await readMilestones(A)).sort((x, y) => x.milestone.localeCompare(y.milestone));
    assert.deepEqual(a, [rows[1], rows[0]], "roundtrip A, por proyecto");
    assert.deepEqual((await readMilestones(B)).map((r) => r.milestone), ["cierre"], "B no ve las filas de A");

    // Reinsertar la misma llave con otra fecha NO cambia nada: la primera vez manda.
    await insertMilestones(A, [{ opportunityId: "o1", milestone: "perfilado", reachedAt: "2026-09-14T00:00:00.000Z", estimated: false }]);
    const again = (await readMilestones(A)).find((r) => r.milestone === "perfilado");
    assert.equal(again?.reachedAt, "2026-09-02T10:00:00.000Z", "ON CONFLICT DO NOTHING");

    await insertMilestones(A, []); // vacío no falla
  } finally {
    await deleteMilestonesForVerify(A.id);
    await deleteMilestonesForVerify(B.id);
  }
  console.log("✅ verify:pmi-ledger — roundtrip Postgres");
}
```

Y en `main()`: `pureMain(); await dbMain();`

Run: `pnpm verify:pmi-ledger`
Expected: FAIL — `Cannot find module '../lib/pmi-ledger-store'`

- [ ] **Step 4: Implement `lib/pmi-ledger-store.ts`**

```ts
// lib/pmi-ledger-store.ts
// SQL de la bitácora de hitos. Server-only, como sync-store.ts.
//
// Insert-only: ON CONFLICT DO NOTHING, porque la primera fecha manda y dos syncs
// concurrentes (el candado de project_sync se auto-sana a los 10 min) no deben
// pisarse ni fallar. La app nunca actualiza ni borra aquí — la única función
// que borra está restringida a los ids sintéticos del script de verificación.
import { getSql } from "./db";
import type { ClientConfig } from "./clients";
import type { MilestoneRow } from "./pmi-ledger";
import type { Milestone } from "./pmi-stages";

// Toma el ClientConfig, nunca un string suelto: leer la bitácora de otro
// proyecto mezclaría sus apartados con los de este.
export async function readMilestones(client: ClientConfig): Promise<MilestoneRow[]> {
  const rows = await getSql()`
    SELECT opportunity_id, milestone, reached_at, estimated
      FROM opportunity_milestones
     WHERE project_id = ${client.id}
  `;
  return rows.map((r) => ({
    opportunityId: String(r.opportunity_id),
    milestone: r.milestone as Milestone,
    reachedAt: new Date(r.reached_at).toISOString(),
    estimated: Boolean(r.estimated),
  }));
}

export async function insertMilestones(client: ClientConfig, rows: MilestoneRow[]): Promise<void> {
  if (rows.length === 0) return;
  const sql = getSql();
  // Lotes de 500: el primer sync de Yconia inserta ~500 filas; el de un proyecto
  // grande podría ser más, y un INSERT con miles de parámetros es frágil.
  const BATCH = 500;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const projectIds = chunk.map(() => client.id);
    const oppIds = chunk.map((r) => r.opportunityId);
    const milestones = chunk.map((r) => r.milestone);
    const reached = chunk.map((r) => r.reachedAt);
    const estimated = chunk.map((r) => r.estimated);
    await sql`
      INSERT INTO opportunity_milestones (project_id, opportunity_id, milestone, reached_at, estimated)
      SELECT * FROM unnest(
        ${projectIds}::text[], ${oppIds}::text[], ${milestones}::text[],
        ${reached}::timestamptz[], ${estimated}::boolean[]
      )
      ON CONFLICT (project_id, opportunity_id, milestone) DO NOTHING
    `;
  }
}

// Solo para scripts/verify-pmi-ledger.ts. Rechaza cualquier id que no sea
// sintético: la app no borra historia.
export async function deleteMilestonesForVerify(projectId: string): Promise<void> {
  if (!projectId.startsWith("__verify_")) {
    throw new Error(`deleteMilestonesForVerify: id no sintético: ${projectId}`);
  }
  await getSql()`DELETE FROM opportunity_milestones WHERE project_id = ${projectId}`;
}
```

- [ ] **Step 5: Run the verify script**

Run: `pnpm verify:pmi-ledger`
Expected: ambas líneas `✅`.

- [ ] **Step 6: Commit**

```bash
git add scripts/db-migrate.ts lib/pmi-ledger-store.ts scripts/verify-pmi-ledger.ts
git commit -m "feat(pmi): tabla opportunity_milestones + store insert-only

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F3a3LMFv11x6QrYvLrpk51"
```

---

### Task 4: reconciliación en `syncProject`

**Files:**
- Modify: `lib/sync.ts` (imports; bloque nuevo después del `for (const opp of opportunities)` que copia atribución del contacto, antes del comentario `// ── Meta Ads ──`)

**Interfaces:**
- Consumes: `reconcileMilestones`, `readMilestones`, `insertMilestones`

- [ ] **Step 1: Add imports**

Junto a los otros imports de `@/lib/...`:

```ts
import { reconcileMilestones } from "@/lib/pmi-ledger";
import { readMilestones, insertMilestones } from "@/lib/pmi-ledger-store";
import { isDbConfigured } from "@/lib/db";
```

- [ ] **Step 2: Add the reconciliation block**

Justo antes de `// ── Meta Ads ──`:

```ts
      // ── Bitácora de hitos del PMI ─────────────────────────────────────────
      // Un solo lugar sirve al camino en vivo y al refresco en segundo plano.
      // La base no es una dependencia: si falla, las oportunidades salen con
      // hitos fechados en updatedAt y marcados `estimated`, no se inserta nada
      // (la siguiente corrida con base sana hace el backfill real) y el sync
      // sigue. Sin DATABASE_URL (dev sin base) se toma el mismo camino.
      {
        const now = new Date();
        let byOpportunity;
        try {
          if (!isDbConfigured()) throw new Error("DATABASE_URL no configurada");
          const existing = await readMilestones(client);
          const rec = reconcileMilestones(existing, opportunities, now);
          await insertMilestones(client, rec.inserts);
          byOpportunity = rec.byOpportunity;
        } catch (err) {
          console.error(`[pmi] bitácora de hitos no disponible para ${client.id}:`, err);
          byOpportunity = reconcileMilestones([], opportunities, now).byOpportunity;
        }
        for (const opp of opportunities) {
          const m = byOpportunity.get(opp.id);
          if (m) opp.milestones = m;
        }
      }
```

- [ ] **Step 3: Type-check and run the existing sync verification**

Run: `npx tsc --noEmit && pnpm verify:sync-store`
Expected: sin errores; `verify:sync-store` verde (la reconciliación no toca `project_sync`).

- [ ] **Step 4: Drive the real app once**

Run: `pnpm dev`, abrir Yconia, apretar **Actualizar** (`?fresh=1`). Luego:

```bash
node --env-file-if-exists=.env.local -e "
const { neon } = require('@neondatabase/serverless');
neon(process.env.DATABASE_URL)\`SELECT milestone, estimated, count(*) FROM opportunity_milestones WHERE project_id = (SELECT project_id FROM project_sync LIMIT 1) GROUP BY 1,2 ORDER BY 1,2\`.then(r => console.log(r));
"
```

Expected: filas `perfilado/apartado/cierre` con `estimated = true` (primer sync). Un segundo **Actualizar** no agrega filas.

- [ ] **Step 5: Commit**

```bash
git add lib/sync.ts
git commit -m "feat(pmi): syncProject reconcilia la bitácora y cuelga milestones a cada oportunidad

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F3a3LMFv11x6QrYvLrpk51"
```

---

### Task 5: `lib/pmi.ts` — semanas, semáforo, conversiones, eventos

**Files:**
- Create: `lib/pmi.ts`
- Modify: `scripts/verify-pmi.ts`

**Interfaces:**
- Consumes: `localDay` (`lib/meta-attribution.ts`), `isDePauta` (`lib/pauta.ts`)
- Produces (esta tarea):
  ```ts
  export type PmiIndicator = "leads" | "perfilamientos" | "citas" | "apartados" | "cierres"
  export const PMI_INDICATORS: readonly PmiIndicator[]
  export interface PmiObjectives { leads; perfilamientos; citas; apartados; montoApartados; cierres; montoCierres: number }
  export const PMI_OBJECTIVES: PmiObjectives
  export const PMI_CONVERSION_TARGETS: { leadPerfil; perfilCita; citaApartado; apartadoCierre: number }
  export const PMI_BANDS: { alto: 1.8; medio: 1.0; bajo: 0.75 }
  export type PmiTone = "alto" | "medio" | "bajo" | null
  export function semaphore(value: number, objective: number): PmiTone
  export function scaleObjectives(base: PmiObjectives, factor: number): PmiObjectives
  export interface PmiWeek { index: number; label: string; start: string; end: string; days: string[] }
  export function monthDays(month: string): string[]
  export function monthWeeks(month: string): PmiWeek[]
  export interface PmiInput { contacts: Contact[]; opportunities: Opportunity[]; appointments: Appointment[]; pautas: Pauta[] }
  export interface PmiEvent { kind: PmiIndicator; day: string; advisor: string; id: string; monto: number; pauta: boolean; estimated: boolean }
  export function collectEvents(input: PmiInput, since: string, until: string): PmiEvent[]
  export interface PmiCounts { leads; leadsPauta; perfilamientos; citas; apartados; montoApartados; cierres; montoCierres: number; ids: Record<PmiIndicator, string[]> }
  export function emptyCounts(): PmiCounts
  export function addEvent(c: PmiCounts, e: PmiEvent): void
  export function sumCounts(list: PmiCounts[]): PmiCounts
  export interface PmiConversions { leadPerfil; perfilCita; citaApartado; apartadoCierre: number | null }
  export function conversions(c: PmiCounts): PmiConversions
  export const UNASSIGNED = ""
  ```

- [ ] **Step 1: Extend the verify script (fails: module missing)**

Agregar a `scripts/verify-pmi.ts`:

```ts
import {
  monthWeeks, monthDays, semaphore, conversions, collectEvents, emptyCounts, addEvent, sumCounts,
  PMI_OBJECTIVES, scaleObjectives, UNASSIGNED,
} from "../lib/pmi";
import type { Contact, Appointment } from "../lib/types";

function contact(p: Partial<Contact>): Contact {
  return { id: "c1", name: "", email: "", phone: "", tags: [], dateAdded: "2026-09-01T12:00:00.000Z",
    createdAt: "2026-09-01T12:00:00.000Z", ...p };
}
function appt(p: Partial<Appointment>): Appointment {
  return { id: "ap1", contactId: "c1", startTime: "2026-09-08T16:00:00-06:00", endTime: "2026-09-08T17:00:00-06:00",
    status: "showed", ...p };
}

function engineMain() {
  // Semanas del PMI: lunes a domingo recortadas al mes; un pedazo de menos de
  // 4 días se pega a la semana vecina. Los tres meses reales de los archivos.
  const labels = (m: string) => monthWeeks(m).map((w) => w.label);
  assert.deepEqual(labels("2026-09"), ["1 - 6", "7 - 13", "14 - 20", "21 - 30"]);
  assert.deepEqual(labels("2026-08"), ["1 - 9", "10 - 16", "17 - 23", "24 - 31"]);
  assert.deepEqual(labels("2026-07"), ["1 - 5", "6 - 12", "13 - 19", "20 - 26", "27 - 31"]);
  const sep = monthWeeks("2026-09");
  assert.equal(sep[3].start, "2026-09-21");
  assert.equal(sep[3].end, "2026-09-30");
  assert.equal(sep[3].days.length, 10);
  assert.equal(sep.reduce((n, w) => n + w.days.length, 0), 30, "cada día en exactamente una semana");
  assert.equal(monthDays("2026-02").length, 28);
  // 1 de febrero de 2026 es domingo: pedazo de 1 día → se pega a la siguiente.
  assert.deepEqual(labels("2026-02"), ["1 - 8", "9 - 15", "16 - 22", "23 - 28"]);

  // Semáforo, bordes exactos de las fórmulas del Excel (180 % / 100 % / 75 %).
  assert.equal(semaphore(18, 10), "alto");
  assert.equal(semaphore(17.9, 10), "medio");
  assert.equal(semaphore(10, 10), "medio");
  assert.equal(semaphore(7.5, 10), "bajo");
  assert.equal(semaphore(7.4, 10), null);
  assert.equal(semaphore(5, 0), null, "sin objetivo no hay color");

  // Objetivos: semanal = mes ÷ 4, diario = semanal ÷ 7; equipo = × asesores.
  assert.equal(scaleObjectives(PMI_OBJECTIVES, 1 / 4).leads, 10);
  assert.equal(scaleObjectives(PMI_OBJECTIVES, 3).montoApartados, 9_000_000);

  // Conversiones: null con denominador 0, nunca 0 %.
  const c = emptyCounts();
  assert.deepEqual(conversions(c), { leadPerfil: null, perfilCita: null, citaApartado: null, apartadoCierre: null });
  c.leads = 31; c.perfilamientos = 11; c.citas = 4;
  const conv = conversions(c);
  assert.ok(Math.abs((conv.leadPerfil ?? 0) - 11 / 31) < 1e-9);
  assert.equal(conv.citaApartado, 0, "4 citas y 0 apartados es 0 %, no null");
  assert.equal(conv.apartadoCierre, null);

  // Eventos: cada indicador con su registro, fecha LOCAL y asesor.
  const input = {
    contacts: [
      contact({ id: "c1", createdAt: "2026-09-01T05:30:00.000Z", assignedTo: "Arely" }),   // 31 ago 23:30 local → fuera
      contact({ id: "c2", createdAt: "2026-09-01T06:30:00.000Z", assignedTo: "Arely" }),   // 1 sep 00:30 local → dentro
      contact({ id: "c3", createdAt: "2026-09-10T12:00:00.000Z" }),                          // sin asesor
    ],
    opportunities: [
      opp({ id: "o1", contactId: "c2", assignedTo: "Arely", stage: "06. Apartado", value: 3_988_119.69,
        milestones: { perfilado: "2026-09-03T15:00:00.000Z", apartado: "2026-09-03T16:00:00.000Z" } }),
      opp({ id: "o2", contactId: "c3", stage: "02. Cliente Calificado",
        milestones: { perfilado: "2026-08-30T15:00:00.000Z", estimated: true } }),           // agosto: fuera
      opp({ id: "o3", contactId: "c9", assignedTo: "Eder", stage: "Lead Recibido" }),        // sin milestones (payload viejo)
      opp({ id: "o4", contactId: "c2", assignedTo: "Arely", stage: "Lead Recibido",
        source: "facebook", adType: "paid_social" }),                                        // marca c2 como de pauta
    ],
    appointments: [
      appt({ id: "ap1", assignedTo: "Arely", status: "showed" }),
      appt({ id: "ap2", assignedTo: "Arely", status: "noshow" }),
      appt({ id: "ap3", assignedTo: "Arely", status: "confirmed" }),
    ],
    pautas: [],
  };
  const events = collectEvents(input, "2026-09-01", "2026-09-30");
  const kinds = events.map((e) => `${e.kind}:${e.id}:${e.advisor}:${e.day}`).sort();
  assert.deepEqual(kinds, [
    "apartados:o1:Arely:2026-09-03",
    "citas:ap1:Arely:2026-09-08",
    "leads:c2:Arely:2026-09-01",
    `leads:c3:${UNASSIGNED}:2026-09-10`,
    "perfilamientos:o1:Arely:2026-09-03",
  ]);
  assert.equal(events.find((e) => e.id === "c2")?.pauta, true, "de pauta por la opp con tráfico pagado");
  assert.equal(events.find((e) => e.id === "c3")?.pauta, false);
  assert.equal(events.find((e) => e.kind === "apartados")?.monto, 3_988_119.69);

  // Acumulación
  const acc = emptyCounts();
  for (const e of events) addEvent(acc, e);
  assert.equal(acc.leads, 2); assert.equal(acc.leadsPauta, 1); assert.equal(acc.apartados, 1);
  assert.equal(acc.montoApartados, 3_988_119.69); assert.deepEqual(acc.ids.apartados, ["o1"]);
  const total = sumCounts([acc, acc]);
  assert.equal(total.leads, 4); assert.deepEqual(total.ids.leads, ["c2", "c3", "c2", "c3"]);
}
```

Y en `main()`: `stagesMain(); engineMain();` con `console.log("✅ verify:pmi — motor")`.

Run: `pnpm verify:pmi`
Expected: FAIL — `Cannot find module '../lib/pmi'`

- [ ] **Step 2: Implement `lib/pmi.ts` (part 1)**

```ts
// lib/pmi.ts
// El motor del PMI: lo que la consultoría calcula a mano en su Excel, calculado
// desde el CRM. Puro y client-side, como lib/dashboard-filters.ts: el servidor
// sincroniza (y fecha los hitos en la bitácora), el navegador cuenta.
//
// Todo por día LOCAL (America/Mexico_City): el PMI cuenta "el apartado del
// martes 3", y un ISO en UTC corre seis horas el día — la misma trampa que
// drill-export y meta-attribution ya esquivan con localDay.
import type { Appointment, Contact, Opportunity, Pauta } from "./types";
import { localDay } from "./meta-attribution";
import { isDePauta } from "./pauta";

export type PmiIndicator = "leads" | "perfilamientos" | "citas" | "apartados" | "cierres";
export const PMI_INDICATORS: readonly PmiIndicator[] = ["leads", "perfilamientos", "citas", "apartados", "cierres"];

export interface PmiObjectives {
  leads: number;
  perfilamientos: number;
  citas: number;
  apartados: number;
  montoApartados: number;
  cierres: number;
  montoCierres: number;
}

// Por asesor y por mes, los del PMI de septiembre 2026. Fijos a propósito
// (decisión 9 del spec): nadie pidió administrarlos.
export const PMI_OBJECTIVES: PmiObjectives = {
  leads: 40,
  perfilamientos: 16,
  citas: 8,
  apartados: 2,
  montoApartados: 3_000_000,
  cierres: 2,
  montoCierres: 3_000_000,
};

export const PMI_CONVERSION_TARGETS = {
  leadPerfil: 0.4,
  perfilCita: 0.6,
  citaApartado: 0.75,
  apartadoCierre: 1.0,
} as const;

// Sacadas de las fórmulas del Excel (E7=E8*180%, E9=E8*75%): ALTO "superó la
// meta", MEDIO "alcanzó", BAJO "se acercó". Debajo, sin color.
export const PMI_BANDS = { alto: 1.8, medio: 1.0, bajo: 0.75 } as const;
export type PmiTone = "alto" | "medio" | "bajo" | null;

export function semaphore(value: number, objective: number): PmiTone {
  if (!(objective > 0)) return null;
  const r = value / objective;
  if (r >= PMI_BANDS.alto) return "alto";
  if (r >= PMI_BANDS.medio) return "medio";
  if (r >= PMI_BANDS.bajo) return "bajo";
  return null;
}

export function scaleObjectives(base: PmiObjectives, factor: number): PmiObjectives {
  return {
    leads: base.leads * factor,
    perfilamientos: base.perfilamientos * factor,
    citas: base.citas * factor,
    apartados: base.apartados * factor,
    montoApartados: base.montoApartados * factor,
    cierres: base.cierres * factor,
    montoCierres: base.montoCierres * factor,
  };
}

// ── Calendario ──────────────────────────────────────────────────────────────

export interface PmiWeek {
  index: number; // 0-based
  label: string; // "21 - 30"
  start: string; // YYYY-MM-DD
  end: string;
  days: string[];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function monthDays(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${y}-${pad2(m)}-${pad2(i + 1)}`);
}

// 0 = domingo … 6 = sábado, del día calendario (no de un instante).
function weekdayOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Lunes a domingo recortadas al mes. Un pedazo de menos de 4 días se pega a la
// semana vecina: reproduce las semanas del PMI (sept 2026 "21 - 30", ago 2026
// "1 - 9", jul 2026 con cinco semanas).
const MIN_WEEK_DAYS = 4;

export function monthWeeks(month: string): PmiWeek[] {
  const days = monthDays(month);
  const groups: string[][] = [];
  for (const day of days) {
    if (groups.length === 0 || weekdayOf(day) === 1) groups.push([day]);
    else groups[groups.length - 1].push(day);
  }
  if (groups.length > 1 && groups[0].length < MIN_WEEK_DAYS) {
    groups[1].unshift(...groups[0]);
    groups.shift();
  }
  if (groups.length > 1 && groups[groups.length - 1].length < MIN_WEEK_DAYS) {
    groups[groups.length - 2].push(...groups[groups.length - 1]);
    groups.pop();
  }
  return groups.map((g, index) => ({
    index,
    label: `${Number(g[0].slice(8))} - ${Number(g[g.length - 1].slice(8))}`,
    start: g[0],
    end: g[g.length - 1],
    days: g,
  }));
}

// ── Eventos ─────────────────────────────────────────────────────────────────

export interface PmiInput {
  contacts: Contact[];
  opportunities: Opportunity[];
  appointments: Appointment[];
  pautas: Pauta[];
}

export interface PmiEvent {
  kind: PmiIndicator;
  day: string; // local
  advisor: string; // UNASSIGNED cuando no hay
  id: string; // contacto, oportunidad o cita según kind
  monto: number; // solo apartados / cierres
  pauta: boolean; // solo leads
  estimated: boolean; // solo hitos
}

export const UNASSIGNED = "";

function advisorOf(name: string | undefined): string {
  return name?.trim() || UNASSIGNED;
}

// Contactos "de pauta": ligados a un objeto Pauta O con alguna oportunidad de
// tráfico pagado — la unión canónica de lib/pauta.ts, subida a contacto.
function pautaContactSet(input: PmiInput): Set<string> {
  const linked = new Set<string>();
  for (const p of input.pautas) if (p.contactId) linked.add(p.contactId);
  const out = new Set<string>(linked);
  for (const opp of input.opportunities) {
    if (opp.contactId && isDePauta(opp, linked)) out.add(opp.contactId);
  }
  return out;
}

// Todos los eventos del PMI entre dos días locales (inclusive). Una pasada por
// dataset; mes y año la comparten.
export function collectEvents(input: PmiInput, since: string, until: string): PmiEvent[] {
  const inRange = (day: string) => day >= since && day <= until;
  const pauta = pautaContactSet(input);
  const events: PmiEvent[] = [];

  for (const c of input.contacts) {
    if (!c.createdAt) continue;
    const day = localDay(c.createdAt);
    if (!inRange(day)) continue;
    events.push({ kind: "leads", day, advisor: advisorOf(c.assignedTo), id: c.id, monto: 0, pauta: pauta.has(c.id), estimated: false });
  }

  for (const opp of input.opportunities) {
    const m = opp.milestones;
    if (!m) continue;
    const advisor = advisorOf(opp.assignedTo);
    const estimated = m.estimated === true;
    const push = (kind: PmiIndicator, iso: string | undefined, monto: number) => {
      if (!iso) return;
      const day = localDay(iso);
      if (!inRange(day)) return;
      events.push({ kind, day, advisor, id: opp.id, monto, pauta: false, estimated });
    };
    push("perfilamientos", m.perfilado, 0);
    push("apartados", m.apartado, opp.value ?? 0);
    push("cierres", m.cierre, opp.value ?? 0);
  }

  for (const a of input.appointments) {
    if (a.status !== "showed" || !a.startTime) continue;
    const day = localDay(a.startTime);
    if (!inRange(day)) continue;
    events.push({ kind: "citas", day, advisor: advisorOf(a.assignedTo), id: a.id, monto: 0, pauta: false, estimated: false });
  }

  return events;
}

// ── Conteos ─────────────────────────────────────────────────────────────────

export interface PmiCounts {
  leads: number;
  leadsPauta: number;
  perfilamientos: number;
  citas: number;
  apartados: number;
  montoApartados: number;
  cierres: number;
  montoCierres: number;
  // Para el drill-down: contactos (leads), oportunidades (perfil/apartados/
  // cierres) y citas.
  ids: Record<PmiIndicator, string[]>;
}

export function emptyCounts(): PmiCounts {
  return {
    leads: 0, leadsPauta: 0, perfilamientos: 0, citas: 0,
    apartados: 0, montoApartados: 0, cierres: 0, montoCierres: 0,
    ids: { leads: [], perfilamientos: [], citas: [], apartados: [], cierres: [] },
  };
}

export function addEvent(c: PmiCounts, e: PmiEvent): void {
  c[e.kind] += 1;
  c.ids[e.kind].push(e.id);
  if (e.kind === "leads" && e.pauta) c.leadsPauta += 1;
  if (e.kind === "apartados") c.montoApartados += e.monto;
  if (e.kind === "cierres") c.montoCierres += e.monto;
}

export function sumCounts(list: PmiCounts[]): PmiCounts {
  const out = emptyCounts();
  for (const c of list) {
    out.leads += c.leads; out.leadsPauta += c.leadsPauta; out.perfilamientos += c.perfilamientos;
    out.citas += c.citas; out.apartados += c.apartados; out.montoApartados += c.montoApartados;
    out.cierres += c.cierres; out.montoCierres += c.montoCierres;
    for (const k of PMI_INDICATORS) out.ids[k].push(...c.ids[k]);
  }
  return out;
}

export interface PmiConversions {
  leadPerfil: number | null;
  perfilCita: number | null;
  citaApartado: number | null;
  apartadoCierre: number | null;
}

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

export function conversions(c: PmiCounts): PmiConversions {
  return {
    leadPerfil: ratio(c.perfilamientos, c.leads),
    perfilCita: ratio(c.citas, c.perfilamientos),
    citaApartado: ratio(c.apartados, c.citas),
    apartadoCierre: ratio(c.cierres, c.apartados),
  };
}
```

- [ ] **Step 3: Run the verify script**

Run: `pnpm verify:pmi`
Expected: `✅ verify:pmi — etapas` y `✅ verify:pmi — motor`

- [ ] **Step 4: Commit**

```bash
git add lib/pmi.ts scripts/verify-pmi.ts
git commit -m "feat(pmi): motor — semanas del mes, semáforo, conversiones y eventos por día local

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F3a3LMFv11x6QrYvLrpk51"
```

---

### Task 6: `buildPmiMonth`

**Files:**
- Modify: `lib/pmi.ts`
- Modify: `scripts/verify-pmi.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PmiSlice { byWeek: PmiCounts[]; byDay: PmiCounts[]; total: PmiCounts;
    objectives: { month: PmiObjectives; week: PmiObjectives; day: PmiObjectives }; conversions: PmiConversions }
  export interface PmiAdvisor extends PmiSlice { name: string }
  export interface PmiRankingRow { name: string; monto: number; count: number; avance: number | null }
  export interface PmiMonth { month: string; weeks: PmiWeek[]; days: string[]; team: PmiSlice;
    advisors: PmiAdvisor[]; unassigned: PmiSlice | null; activeAdvisors: number;
    rankingApartados: PmiRankingRow[]; rankingCierres: PmiRankingRow[]; estimatedCount: number }
  export function buildPmiMonth(input: PmiInput, month: string): PmiMonth
  export function currentMonth(now?: Date): string
  export function monthLabel(month: string): string   // "Septiembre 2026"
  export function shiftMonth(month: string, delta: number): string
  ```

- [ ] **Step 1: Extend the verify script (fails)**

```ts
import { buildPmiMonth, monthLabel, shiftMonth } from "../lib/pmi";

function monthMain() {
  assert.equal(monthLabel("2026-09"), "Septiembre 2026");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");

  const input = {
    contacts: [
      ...Array.from({ length: 29 }, (_, i) => contact({ id: `a${i}`, assignedTo: "Arely", createdAt: `2026-09-${pad(1 + (i % 20))}T15:00:00.000Z` })),
      ...Array.from({ length: 31 }, (_, i) => contact({ id: `m${i}`, assignedTo: "Monica", createdAt: `2026-09-${pad(1 + (i % 12))}T15:00:00.000Z` })),
      contact({ id: "x1", createdAt: "2026-09-05T15:00:00.000Z" }), // sin asesor
    ],
    opportunities: [
      opp({ id: "o1", contactId: "a0", assignedTo: "Arely", stage: "06. Apartado", value: 3_988_119.69,
        milestones: { perfilado: "2026-09-02T15:00:00.000Z", apartado: "2026-09-03T15:00:00.000Z" } }),
      opp({ id: "o2", contactId: "a1", assignedTo: "Arely", stage: "02. Cliente Calificado",
        milestones: { perfilado: "2026-09-09T15:00:00.000Z", estimated: true } }),
      opp({ id: "o3", contactId: "m0", assignedTo: "Monica", stage: "08. Proceso de Escritura", value: 3_265_823.51,
        milestones: { perfilado: "2026-08-10T15:00:00.000Z", apartado: "2026-08-12T15:00:00.000Z", cierre: "2026-09-16T15:00:00.000Z" } }),
    ],
    appointments: [
      appt({ id: "ap1", assignedTo: "Arely", startTime: "2026-09-08T16:00:00-06:00" }),
      appt({ id: "ap2", assignedTo: "Arely", startTime: "2026-09-22T16:00:00-06:00" }),
    ],
    pautas: [],
  };
  const pmi = buildPmiMonth(input, "2026-09");

  assert.equal(pmi.weeks.length, 4);
  assert.deepEqual(pmi.advisors.map((a) => a.name), ["Arely", "Monica"], "orden alfabético, activos del mes");
  assert.equal(pmi.activeAdvisors, 2);
  assert.equal(pmi.unassigned?.total.leads, 1, "'Sin asignar' aparece porque no es cero");

  const arely = pmi.advisors[0];
  assert.equal(arely.total.leads, 29);
  assert.equal(arely.total.perfilamientos, 2);
  assert.equal(arely.total.citas, 2);
  assert.equal(arely.total.apartados, 1);
  assert.equal(arely.total.montoApartados, 3_988_119.69);
  assert.equal(arely.byWeek[0].apartados, 1, "3 de sept cae en la semana 1 - 6");
  assert.equal(arely.byWeek[3].citas, 1, "22 de sept cae en 21 - 30");
  assert.equal(arely.byDay[2].apartados, 1, "byDay[2] es el día 3");
  assert.equal(arely.byDay.length, 30);
  assert.equal(arely.objectives.month.leads, 40);
  assert.equal(arely.objectives.week.leads, 10);
  assert.ok(Math.abs(arely.objectives.day.leads - 10 / 7) < 1e-9);
  assert.ok(Math.abs((arely.conversions.leadPerfil ?? 0) - 2 / 29) < 1e-9);

  // Equipo = todos los asesores (sin "Sin asignar"), objetivo × activos.
  assert.equal(pmi.team.total.leads, 60);
  assert.equal(pmi.team.total.cierres, 1);
  assert.equal(pmi.team.objectives.month.leads, 80);
  assert.equal(pmi.team.objectives.month.montoApartados, 6_000_000);

  // Rankings por monto, con avance contra $3M.
  assert.deepEqual(pmi.rankingApartados.map((r) => [r.name, r.count]), [["Arely", 1], ["Monica", 0]]);
  assert.ok(Math.abs((pmi.rankingApartados[0].avance ?? 0) - 3_988_119.69 / 3_000_000) < 1e-9);
  assert.equal(pmi.rankingCierres[0].name, "Monica");

  // Un hito estimado en el mes se reporta.
  assert.equal(pmi.estimatedCount, 1);

  // Un mes vacío no explota.
  const empty = buildPmiMonth({ contacts: [], opportunities: [], appointments: [], pautas: [] }, "2026-02");
  assert.equal(empty.advisors.length, 0);
  assert.equal(empty.activeAdvisors, 0);
  assert.equal(empty.unassigned, null);
  assert.equal(empty.team.objectives.month.leads, 0);
}
```

Con `const pad = (n: number) => String(n).padStart(2, "0");` arriba, y `monthMain()` en `main()`.

Run: `pnpm verify:pmi`
Expected: FAIL — `buildPmiMonth is not a function` (o import inexistente)

- [ ] **Step 2: Implement `buildPmiMonth` and month helpers in `lib/pmi.ts`**

Al final del archivo:

```ts
// ── Mes ─────────────────────────────────────────────────────────────────────

export interface PmiSlice {
  byWeek: PmiCounts[];
  byDay: PmiCounts[];
  total: PmiCounts;
  objectives: { month: PmiObjectives; week: PmiObjectives; day: PmiObjectives };
  conversions: PmiConversions;
}

export interface PmiAdvisor extends PmiSlice {
  name: string;
}

export interface PmiRankingRow {
  name: string;
  monto: number;
  count: number;
  avance: number | null; // monto ÷ objetivo del mes
}

export interface PmiMonth {
  month: string;
  weeks: PmiWeek[];
  days: string[];
  team: PmiSlice;
  advisors: PmiAdvisor[];
  unassigned: PmiSlice | null;
  activeAdvisors: number;
  rankingApartados: PmiRankingRow[];
  rankingCierres: PmiRankingRow[];
  estimatedCount: number;
}

const MONTHS_ES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS_ES[m - 1]} ${y}`;
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

export function currentMonth(now: Date = new Date()): string {
  return localDay(now.toISOString()).slice(0, 7);
}

function buildSlice(events: PmiEvent[], weeks: PmiWeek[], days: string[], objectiveFactor: number): PmiSlice {
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const weekOfDay = new Map<string, number>();
  for (const w of weeks) for (const d of w.days) weekOfDay.set(d, w.index);

  const byDay = days.map(() => emptyCounts());
  const byWeek = weeks.map(() => emptyCounts());
  for (const e of events) {
    const di = dayIndex.get(e.day);
    if (di === undefined) continue;
    addEvent(byDay[di], e);
    addEvent(byWeek[weekOfDay.get(e.day)!], e);
  }
  const total = sumCounts(byWeek);
  const month = scaleObjectives(PMI_OBJECTIVES, objectiveFactor);
  return {
    byWeek,
    byDay,
    total,
    objectives: { month, week: scaleObjectives(month, 1 / 4), day: scaleObjectives(month, 1 / 28) },
    conversions: conversions(total),
  };
}

function ranking(advisors: PmiAdvisor[], kind: "apartados" | "cierres"): PmiRankingRow[] {
  const montoKey = kind === "apartados" ? "montoApartados" : "montoCierres";
  return advisors
    .map((a) => ({
      name: a.name,
      monto: a.total[montoKey],
      count: a.total[kind],
      avance: ratio(a.total[montoKey], PMI_OBJECTIVES[montoKey]),
    }))
    .sort((x, y) => y.monto - x.monto || y.count - x.count || x.name.localeCompare(y.name));
}

export function buildPmiMonth(input: PmiInput, month: string): PmiMonth {
  const days = monthDays(month);
  const weeks = monthWeeks(month);
  const events = collectEvents(input, days[0], days[days.length - 1]);

  const byAdvisor = new Map<string, PmiEvent[]>();
  for (const e of events) {
    const list = byAdvisor.get(e.advisor) ?? [];
    list.push(e);
    byAdvisor.set(e.advisor, list);
  }

  const names = [...byAdvisor.keys()].filter((n) => n !== UNASSIGNED).sort((a, b) => a.localeCompare(b, "es"));
  const advisors: PmiAdvisor[] = names.map((name) => ({
    name,
    ...buildSlice(byAdvisor.get(name)!, weeks, days, 1),
  }));

  const teamEvents = events.filter((e) => e.advisor !== UNASSIGNED);
  const team = buildSlice(teamEvents, weeks, days, names.length);

  const unassignedEvents = byAdvisor.get(UNASSIGNED) ?? [];
  const unassigned = unassignedEvents.length > 0 ? buildSlice(unassignedEvents, weeks, days, 0) : null;

  return {
    month,
    weeks,
    days,
    team,
    advisors,
    unassigned,
    activeAdvisors: names.length,
    rankingApartados: ranking(advisors, "apartados"),
    rankingCierres: ranking(advisors, "cierres"),
    estimatedCount: events.filter((e) => e.estimated).length,
  };
}
```

Nota: el objetivo **diario** es semanal ÷ 7 = mensual ÷ 28 — así lo hace el Excel (`D8=C7/7`).

- [ ] **Step 3: Run the verify script**

Run: `pnpm verify:pmi`
Expected: verde, con `✅ verify:pmi — mes` añadido al final de `main()`.

- [ ] **Step 4: Commit**

```bash
git add lib/pmi.ts scripts/verify-pmi.ts
git commit -m "feat(pmi): buildPmiMonth — equipo, asesores, semanas, días, rankings

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F3a3LMFv11x6QrYvLrpk51"
```

---

### Task 7: `buildPmiYear`

**Files:**
- Modify: `lib/pmi.ts`
- Modify: `scripts/verify-pmi.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface PmiYearAdvisor { name: string; byMonth: PmiCounts[]; byQuarter: PmiCounts[]; total: PmiCounts;
    mesesActivo: number; promedio: PmiCounts | null; ticketPromedio: number | null }
  export interface PmiYearRankingRow { name: string; monto: number; count: number; mesesActivo: number;
    avance: number | null; paraLlegar: number; promedio: number | null }
  export interface PmiYear { year: number; advisors: PmiYearAdvisor[]; team: { byMonth: PmiCounts[]; byQuarter: PmiCounts[]; total: PmiCounts;
    activeByMonth: number[]; pctMeta: (PmiObjectives | null)[] }; rankingApartados: PmiYearRankingRow[]; rankingCierres: PmiYearRankingRow[]; estimatedCount: number }
  export function buildPmiYear(input: PmiInput, year: number): PmiYear
  ```

- [ ] **Step 1: Extend the verify script (fails)**

```ts
import { buildPmiYear } from "../lib/pmi";

function yearMain() {
  const input = {
    contacts: [
      contact({ id: "a1", assignedTo: "Arely", createdAt: "2026-03-05T15:00:00.000Z" }),
      contact({ id: "a2", assignedTo: "Arely", createdAt: "2026-09-05T15:00:00.000Z" }),
      contact({ id: "m1", assignedTo: "Monica", createdAt: "2026-01-05T15:00:00.000Z" }),
    ],
    opportunities: [
      opp({ id: "o1", assignedTo: "Arely", value: 5_967_052.46, stage: "08. Proceso de Escritura",
        milestones: { perfilado: "2026-05-01T15:00:00.000Z", apartado: "2026-05-10T15:00:00.000Z", cierre: "2026-07-10T15:00:00.000Z" } }),
      opp({ id: "o2", assignedTo: "Arely", value: 6_497_283.09, stage: "06. Apartado",
        milestones: { perfilado: "2026-06-01T15:00:00.000Z", apartado: "2026-06-10T15:00:00.000Z" } }),
      opp({ id: "o3", assignedTo: "Monica", value: 3_145_022.6, stage: "10. Negocio Ganado",
        milestones: { perfilado: "2025-12-01T15:00:00.000Z", apartado: "2025-12-10T15:00:00.000Z", cierre: "2026-01-20T15:00:00.000Z" } }),
    ],
    appointments: [],
    pautas: [],
  };
  const y = buildPmiYear(input, 2026);
  const arely = y.advisors.find((a) => a.name === "Arely")!;
  assert.equal(arely.byMonth.length, 12);
  assert.equal(arely.byMonth[4].apartados, 1, "mayo");
  assert.equal(arely.byMonth[5].apartados, 1, "junio");
  assert.equal(arely.byQuarter[1].apartados, 2, "2do trimestre");
  assert.equal(arely.byQuarter[2].cierres, 1, "3er trimestre");
  assert.equal(arely.total.montoApartados, 5_967_052.46 + 6_497_283.09);
  assert.equal(arely.mesesActivo, 5, "mar, may, jun, jul, sep");
  assert.ok(Math.abs((arely.promedio?.montoApartados ?? 0) - (5_967_052.46 + 6_497_283.09) / 5) < 1e-6);
  assert.equal(arely.ticketPromedio, 5_967_052.46);

  const monica = y.advisors.find((a) => a.name === "Monica")!;
  assert.equal(monica.total.apartados, 0, "el apartado fue en diciembre 2025: fuera del año");
  assert.equal(monica.total.cierres, 1);
  assert.equal(monica.mesesActivo, 1);

  assert.equal(y.team.byMonth[0].leads, 1);
  assert.deepEqual(y.team.activeByMonth.slice(0, 3), [1, 0, 1]);
  assert.equal(y.team.pctMeta[1], null, "febrero sin asesores activos: sin % de meta");
  assert.ok(Math.abs((y.team.pctMeta[0]?.leads ?? 0) - 1 / 40) < 1e-9);
  assert.equal(y.team.byQuarter[2].cierres, 1);

  const r = y.rankingApartados[0];
  assert.equal(r.name, "Arely");
  assert.ok(Math.abs((r.avance ?? 0) - r.monto / (3_000_000 * 5)) < 1e-9, "meta = $3M × meses activo");
  assert.equal(r.paraLlegar, Math.max(0, 3_000_000 * 5 - r.monto));
  assert.equal(y.rankingCierres[0].name, "Arely");
  assert.equal(y.rankingCierres[1].name, "Monica");
  assert.equal(y.estimatedCount, 0);
}
```

Run: `pnpm verify:pmi`
Expected: FAIL — `buildPmiYear` no existe

- [ ] **Step 2: Implement `buildPmiYear`**

Al final de `lib/pmi.ts`:

```ts
// ── Año (la hoja DASH) ──────────────────────────────────────────────────────

export interface PmiYearAdvisor {
  name: string;
  byMonth: PmiCounts[]; // 12
  byQuarter: PmiCounts[]; // 4
  total: PmiCounts;
  mesesActivo: number; // meses con algún registro
  promedio: PmiCounts | null; // total ÷ mesesActivo (ids vacíos)
  ticketPromedio: number | null; // montoCierres ÷ cierres
}

export interface PmiYearRankingRow {
  name: string;
  monto: number;
  count: number;
  mesesActivo: number;
  avance: number | null; // monto ÷ (objetivo mensual × mesesActivo)
  paraLlegar: number;
  promedio: number | null; // monto ÷ mesesActivo
}

export interface PmiYear {
  year: number;
  advisors: PmiYearAdvisor[];
  team: {
    byMonth: PmiCounts[];
    byQuarter: PmiCounts[];
    total: PmiCounts;
    activeByMonth: number[]; // asesores con actividad, por mes
    pctMeta: (PmiObjectives | null)[]; // avance por mes; null sin asesores activos
  };
  rankingApartados: PmiYearRankingRow[];
  rankingCierres: PmiYearRankingRow[];
  estimatedCount: number;
}

function divideCounts(c: PmiCounts, n: number): PmiCounts | null {
  if (!(n > 0)) return null;
  const out = emptyCounts();
  out.leads = c.leads / n; out.leadsPauta = c.leadsPauta / n; out.perfilamientos = c.perfilamientos / n;
  out.citas = c.citas / n; out.apartados = c.apartados / n; out.montoApartados = c.montoApartados / n;
  out.cierres = c.cierres / n; out.montoCierres = c.montoCierres / n;
  return out;
}

function hasActivity(c: PmiCounts): boolean {
  return c.leads + c.perfilamientos + c.citas + c.apartados + c.cierres > 0;
}

function quarters(byMonth: PmiCounts[]): PmiCounts[] {
  return [0, 1, 2, 3].map((q) => sumCounts(byMonth.slice(q * 3, q * 3 + 3)));
}

function yearRanking(advisors: PmiYearAdvisor[], kind: "apartados" | "cierres"): PmiYearRankingRow[] {
  const montoKey = kind === "apartados" ? "montoApartados" : "montoCierres";
  return advisors
    .map((a) => {
      const meta = PMI_OBJECTIVES[montoKey] * a.mesesActivo;
      const monto = a.total[montoKey];
      return {
        name: a.name,
        monto,
        count: a.total[kind],
        mesesActivo: a.mesesActivo,
        avance: ratio(monto, meta),
        paraLlegar: Math.max(0, meta - monto),
        promedio: ratio(monto, a.mesesActivo),
      };
    })
    .sort((x, y) => y.monto - x.monto || y.count - x.count || x.name.localeCompare(y.name));
}

export function buildPmiYear(input: PmiInput, year: number): PmiYear {
  const events = collectEvents(input, `${year}-01-01`, `${year}-12-31`);
  const monthOf = (day: string) => Number(day.slice(5, 7)) - 1;

  const byAdvisor = new Map<string, PmiCounts[]>();
  for (const e of events) {
    if (e.advisor === UNASSIGNED) continue;
    let months = byAdvisor.get(e.advisor);
    if (!months) {
      months = Array.from({ length: 12 }, () => emptyCounts());
      byAdvisor.set(e.advisor, months);
    }
    addEvent(months[monthOf(e.day)], e);
  }

  const advisors: PmiYearAdvisor[] = [...byAdvisor.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "es"))
    .map(([name, byMonth]) => {
      const total = sumCounts(byMonth);
      const mesesActivo = byMonth.filter(hasActivity).length;
      return {
        name,
        byMonth,
        byQuarter: quarters(byMonth),
        total,
        mesesActivo,
        promedio: divideCounts(total, mesesActivo),
        ticketPromedio: ratio(total.montoCierres, total.cierres),
      };
    });

  const teamByMonth = Array.from({ length: 12 }, (_, i) => sumCounts(advisors.map((a) => a.byMonth[i])));
  const activeByMonth = Array.from({ length: 12 }, (_, i) => advisors.filter((a) => hasActivity(a.byMonth[i])).length);
  const pctMeta = teamByMonth.map((c, i) => {
    const n = activeByMonth[i];
    if (n === 0) return null;
    const o = scaleObjectives(PMI_OBJECTIVES, n);
    return {
      leads: c.leads / o.leads,
      perfilamientos: c.perfilamientos / o.perfilamientos,
      citas: c.citas / o.citas,
      apartados: c.apartados / o.apartados,
      montoApartados: c.montoApartados / o.montoApartados,
      cierres: c.cierres / o.cierres,
      montoCierres: c.montoCierres / o.montoCierres,
    };
  });

  return {
    year,
    advisors,
    team: { byMonth: teamByMonth, byQuarter: quarters(teamByMonth), total: sumCounts(teamByMonth), activeByMonth, pctMeta },
    rankingApartados: yearRanking(advisors, "apartados"),
    rankingCierres: yearRanking(advisors, "cierres"),
    estimatedCount: events.filter((e) => e.estimated && e.advisor !== UNASSIGNED).length,
  };
}
```

- [ ] **Step 3: Run the verify script and type-check**

Run: `pnpm verify:pmi && npx tsc --noEmit`
Expected: verde (añade `yearMain()` y `✅ verify:pmi — año` a `main()`).

- [ ] **Step 4: Commit**

```bash
git add lib/pmi.ts scripts/verify-pmi.ts
git commit -m "feat(pmi): buildPmiYear — meses, trimestres, rankings anuales, ticket promedio

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F3a3LMFv11x6QrYvLrpk51"
```

---

### Task 8: chrome compartido y la pestaña con vista Equipo (tiles + conversiones)

**Files:**
- Create: `components/dashboard/pmi-ui.tsx`
- Create: `components/dashboard/pmi-dashboard.tsx`
- Modify: `components/dashboard/dashboard-app.tsx`

**Interfaces:**
- Consumes: `buildPmiMonth`, `buildPmiYear`, `currentMonth`, `monthLabel`, `shiftMonth`, `PmiMonth`, `PmiYear`, `PmiSlice`, `PmiTone`, `semaphore`, `PMI_CONVERSION_TARGETS`, `projectHasMilestoneStages`
- Produces (`pmi-ui.tsx`):
  ```ts
  export function toneClass(tone: PmiTone): string            // clases de fondo/texto para celdas
  export function fmtInt(n: number): string
  export function fmtMxn(n: number): string
  export function fmtPct(r: number | null, digits?: number): string // "—" si null
  export function PmiTile(props: { label: string; value: string; objective: string; avance: number | null; sub?: string; onClick?: () => void })
  export function ConversionStrip(props: { conversions: PmiConversions })
  export function EstimatedNote(props: { count: number })
  export const INDICATOR_LABELS: Record<PmiIndicator, string>
  ```
- Produces (`pmi-dashboard.tsx`): `export function PmiDashboard(props: PmiDashboardProps)` con
  ```ts
  interface PmiDashboardProps {
    contacts: Contact[]; opportunities: Opportunity[]; appointments: Appointment[]; pautas: Pauta[];
    tasks: Task[]; calls: Call[]; messages: Message[]; locationId: string; locationName?: string
  }
  ```

- [ ] **Step 1: Write `components/dashboard/pmi-ui.tsx`**

```tsx
"use client"

import type { ReactNode } from "react"
import { Info } from "lucide-react"
import { cn } from "@/lib/utils"
import { PMI_CONVERSION_TARGETS, type PmiConversions, type PmiIndicator, type PmiTone } from "@/lib/pmi"

export const INDICATOR_LABELS: Record<PmiIndicator, string> = {
  leads: "Leads",
  perfilamientos: "Perfilamientos",
  citas: "Citas efectivas",
  apartados: "Apartados",
  cierres: "Cierres",
}

// Los tres tonos del Excel (verde / cian / rojo) traducidos a la paleta del
// panel: el semáforo es información, no decoración, así que nada de ámbar aquí.
export function toneClass(tone: PmiTone): string {
  switch (tone) {
    case "alto":
      return "bg-emerald-500/15 text-emerald-800 dark:text-emerald-200"
    case "medio":
      return "bg-sky-500/15 text-sky-800 dark:text-sky-200"
    case "bajo":
      return "bg-rose-500/15 text-rose-800 dark:text-rose-200"
    default:
      return "text-muted-foreground"
  }
}

export function fmtInt(n: number): string {
  return n.toLocaleString("es-MX", { maximumFractionDigits: 0 })
}

export function fmtMxn(n: number): string {
  return n.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 })
}

export function fmtPct(r: number | null, digits = 0): string {
  if (r === null || !Number.isFinite(r)) return "—"
  return `${(r * 100).toLocaleString("es-MX", { maximumFractionDigits: digits, minimumFractionDigits: digits })} %`
}

export function PmiTile({
  label, value, objective, avance, sub, onClick,
}: {
  label: string
  value: string
  objective: string
  avance: number | null
  sub?: string
  onClick?: () => void
}) {
  const tone: PmiTone =
    avance === null ? null : avance >= 1.8 ? "alto" : avance >= 1 ? "medio" : avance >= 0.75 ? "bajo" : null
  return (
    <div
      className={cn(
        "flex flex-col gap-1 rounded-xl border border-border bg-card px-4 py-3.5",
        onClick && "cursor-pointer transition-[border-color] hover:border-primary/35",
      )}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.09em] text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums leading-none">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
      <div className="mt-1 flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">Objetivo {objective}</span>
        <span className={cn("rounded px-1.5 py-0.5 font-medium tabular-nums", toneClass(tone))}>{fmtPct(avance)}</span>
      </div>
    </div>
  )
}

const CONVERSION_LABELS: { key: keyof PmiConversions; label: string }[] = [
  { key: "leadPerfil", label: "Leads → Perfilamientos" },
  { key: "perfilCita", label: "Perfilamientos → Citas" },
  { key: "citaApartado", label: "Citas → Apartados" },
  { key: "apartadoCierre", label: "Apartados → Cierres" },
]

export function ConversionStrip({ conversions }: { conversions: PmiConversions }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {CONVERSION_LABELS.map(({ key, label }) => {
        const r = conversions[key]
        const target = PMI_CONVERSION_TARGETS[key]
        const tone: PmiTone = r === null ? null : r >= target ? "medio" : r >= target * 0.75 ? "bajo" : null
        return (
          <div key={key} className="rounded-lg border border-border bg-card px-3 py-2">
            <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
            <div className="mt-1 flex items-baseline justify-between">
              <span className={cn("rounded px-1.5 text-lg font-semibold tabular-nums", toneClass(tone))}>{fmtPct(r)}</span>
              <span className="text-[11px] text-muted-foreground">meta {fmtPct(target)}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function EstimatedNote({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
      <Info className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
      <span>
        {count} {count === 1 ? "hito tiene" : "hitos tienen"} fecha estimada: son anteriores al arranque de la
        bitácora y llevan la fecha de su última edición en el CRM.
      </span>
    </p>
  )
}

export function PmiSection({ title, hint, children }: { title: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {hint}
      </div>
      {children}
    </section>
  )
}
```

- [ ] **Step 2: Write `components/dashboard/pmi-dashboard.tsx` (shell + Equipo tiles)**

```tsx
"use client"

import { useCallback, useMemo, useState } from "react"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import type { Appointment, Call, Contact, Message, Opportunity, Pauta, Task } from "@/lib/types"
import {
  buildPmiMonth, buildPmiYear, currentMonth, monthLabel, shiftMonth,
  type PmiIndicator, type PmiSlice,
} from "@/lib/pmi"
import { DashboardShell, ScopePill } from "./dashboard-ui"
import { ChartDrillDrawer, DRILL_CLOSED, type DrillState } from "./chart-drill-drawer"
import { ConversionStrip, EstimatedNote, INDICATOR_LABELS, PmiSection, PmiTile, fmtInt, fmtMxn } from "./pmi-ui"

interface PmiDashboardProps {
  contacts: Contact[]
  opportunities: Opportunity[]
  appointments: Appointment[]
  pautas: Pauta[]
  tasks: Task[]
  calls: Call[]
  messages: Message[]
  locationId: string
  locationName?: string
}

type PmiView = "month" | "year"
const TEAM = "__team__"

export const PMI_RULES = {
  leads: "Todo contacto nuevo asignado al asesor en el período, venga de donde venga; abajo, cuántos son de pauta.",
  perfilamientos: "Primera vez que la oportunidad llegó a Cliente Calificado o una etapa posterior. Las perdidas cuentan por su última etapa.",
  citas: "Citas de calendario con estado 'showed' (el lead sí fue), por su fecha.",
  apartados: "Primera vez que la oportunidad llegó a Apartado o una etapa posterior. Un apartado que después se cae sigue contando en su mes.",
  cierres: "Primera vez que la oportunidad llegó a Proceso de Escritura, Siguiente Escritura o Negocio Ganado.",
} as const

export function PmiDashboard(props: PmiDashboardProps) {
  const { contacts, opportunities, appointments, pautas, tasks, calls, messages, locationId } = props
  const [view, setView] = useState<PmiView>("month")
  const [month, setMonth] = useState(() => currentMonth())
  const [advisor, setAdvisor] = useState<string>(TEAM)
  const [drill, setDrill] = useState<DrillState>(DRILL_CLOSED)

  const input = useMemo(
    () => ({ contacts, opportunities, appointments, pautas }),
    [contacts, opportunities, appointments, pautas],
  )
  const pmi = useMemo(() => buildPmiMonth(input, month), [input, month])
  const year = Number(month.slice(0, 4))
  const pmiYear = useMemo(() => (view === "year" ? buildPmiYear(input, year) : null), [input, year, view])

  const advisorNames = pmi.advisors.map((a) => a.name)
  const selected = advisor === TEAM ? null : pmi.advisors.find((a) => a.name === advisor) ?? null
  const slice: PmiSlice = selected ?? pmi.team

  const contactById = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts])
  const oppById = useMemo(() => new Map(opportunities.map((o) => [o.id, o])), [opportunities])

  // Un solo camino de drill: por indicador, con los ids que el motor guardó.
  const openDrill = useCallback(
    (kind: PmiIndicator, ids: string[], title: string, subtitle?: string) => {
      if (kind === "leads") {
        const items = ids.map((id) => contactById.get(id)).filter((c): c is Contact => Boolean(c))
        setDrill({ open: true, title, subtitle, opportunities: [], contactItems: items })
        return
      }
      if (kind === "citas") {
        const byContact = new Set(appointments.filter((a) => ids.includes(a.id)).map((a) => a.contactId))
        const items = [...byContact].map((id) => contactById.get(id)).filter((c): c is Contact => Boolean(c))
        setDrill({ open: true, title, subtitle, opportunities: [], contactItems: items })
        return
      }
      const opps = ids.map((id) => oppById.get(id)).filter((o): o is Opportunity => Boolean(o))
      setDrill({ open: true, title, subtitle, opportunities: opps })
    },
    [appointments, contactById, oppById],
  )

  const periodTitle = view === "year" ? String(year) : monthLabel(month)
  const scopeTitle = selected ? selected.name : "Equipo"

  return (
    <DashboardShell>
      {/* Cabecera propia: el PMI es mensual por construcción, la barra global no aplica */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" className="h-8 w-8" aria-label="Período anterior"
            onClick={() => setMonth((m) => shiftMonth(m, view === "year" ? -12 : -1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="min-w-[10rem] text-center text-sm font-semibold tabular-nums">{periodTitle}</span>
          <Button variant="outline" size="icon" className="h-8 w-8" aria-label="Período siguiente"
            onClick={() => setMonth((m) => shiftMonth(m, view === "year" ? 12 : 1))}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
        <div className="flex rounded-lg border border-border p-0.5 text-xs">
          {(["month", "year"] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)}
              className={cn("rounded-md px-3 py-1 font-medium", view === v ? "bg-primary/10 text-foreground" : "text-muted-foreground hover:text-foreground")}>
              {v === "month" ? "Mes" : "Año"}
            </button>
          ))}
        </div>
        {view === "month" && (
          <div className="flex flex-wrap gap-1 text-xs">
            {[TEAM, ...advisorNames].map((name) => (
              <button key={name} type="button" onClick={() => setAdvisor(name)}
                className={cn("rounded-full border px-3 py-1 font-medium transition-colors",
                  advisor === name ? "border-primary/40 bg-primary/10 text-foreground" : "border-border text-muted-foreground hover:text-foreground")}>
                {name === TEAM ? "Equipo" : name}
              </button>
            ))}
          </div>
        )}
        <div className="ml-auto" data-slot="pmi-export" />
      </div>

      {view === "month" && (
        <>
          <EstimatedNote count={pmi.estimatedCount} />
          <PmiSection title={`${scopeTitle} · ${monthLabel(month)}`}
            hint={<ScopePill label="Objetivos" tooltip="Objetivos fijos por asesor y mes (leads 40, perfilamientos 16, citas 8, apartados 2 / $3M, cierres 2 / $3M). El equipo suma un objetivo por asesor con actividad en el mes." />}>
            <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
              <PmiTile label="Leads" value={fmtInt(slice.total.leads)} sub={`${fmtInt(slice.total.leadsPauta)} de pauta`}
                objective={fmtInt(slice.objectives.month.leads)}
                avance={slice.objectives.month.leads > 0 ? slice.total.leads / slice.objectives.month.leads : null}
                onClick={() => openDrill("leads", slice.total.ids.leads, `Leads · ${scopeTitle}`, monthLabel(month))} />
              <PmiTile label="Perfilamientos" value={fmtInt(slice.total.perfilamientos)}
                objective={fmtInt(slice.objectives.month.perfilamientos)}
                avance={slice.objectives.month.perfilamientos > 0 ? slice.total.perfilamientos / slice.objectives.month.perfilamientos : null}
                onClick={() => openDrill("perfilamientos", slice.total.ids.perfilamientos, `Perfilamientos · ${scopeTitle}`, monthLabel(month))} />
              <PmiTile label="Citas efectivas" value={fmtInt(slice.total.citas)}
                objective={fmtInt(slice.objectives.month.citas)}
                avance={slice.objectives.month.citas > 0 ? slice.total.citas / slice.objectives.month.citas : null}
                onClick={() => openDrill("citas", slice.total.ids.citas, `Citas efectivas · ${scopeTitle}`, monthLabel(month))} />
              <PmiTile label="Apartados" value={fmtInt(slice.total.apartados)} sub={fmtMxn(slice.total.montoApartados)}
                objective={`${fmtInt(slice.objectives.month.apartados)} · ${fmtMxn(slice.objectives.month.montoApartados)}`}
                avance={slice.objectives.month.montoApartados > 0 ? slice.total.montoApartados / slice.objectives.month.montoApartados : null}
                onClick={() => openDrill("apartados", slice.total.ids.apartados, `Apartados · ${scopeTitle}`, monthLabel(month))} />
              <PmiTile label="Cierres" value={fmtInt(slice.total.cierres)} sub={fmtMxn(slice.total.montoCierres)}
                objective={`${fmtInt(slice.objectives.month.cierres)} · ${fmtMxn(slice.objectives.month.montoCierres)}`}
                avance={slice.objectives.month.montoCierres > 0 ? slice.total.montoCierres / slice.objectives.month.montoCierres : null}
                onClick={() => openDrill("cierres", slice.total.ids.cierres, `Cierres · ${scopeTitle}`, monthLabel(month))} />
            </div>
          </PmiSection>

          <PmiSection title="Conversiones"
            hint={<ScopePill label="Metas" tooltip="Metas de conversión del PMI: 40 % / 60 % / 75 % / 100 %. Sin denominador la conversión se muestra como —, no como 0 %." />}>
            <ConversionStrip conversions={slice.conversions} />
          </PmiSection>
          {/* Task 9–11 agregan aquí: semana, por asesor, rankings, tendencia, cuadrícula diaria */}
        </>
      )}

      {view === "year" && pmiYear && (
        <>
          <EstimatedNote count={pmiYear.estimatedCount} />
          {/* Task 12 agrega aquí la vista anual */}
        </>
      )}

      <ChartDrillDrawer
        drill={drill}
        onDrillChange={setDrill}
        contacts={contacts}
        tasks={tasks}
        calls={calls}
        allOpportunities={opportunities}
        allPautas={pautas}
        appointments={appointments}
        messages={messages}
        locationId={locationId}
      />
    </DashboardShell>
  )
}

// Reexport para que la pestaña y el PDF compartan el texto de las reglas.
export { INDICATOR_LABELS }
```

- [ ] **Step 3: Wire the tab in `dashboard-app.tsx`**

1. `type DashboardTab = "marketing" | "sales" | "conversations" | "pmi"` y en `TAB_TITLES`: `pmi: "Desempeño - Lezgo Suite CRM",`.
2. Imports: `import { PmiDashboard } from "@/components/dashboard/pmi-dashboard"`, `import { projectHasMilestoneStages } from "@/lib/pmi-stages"`, y `Award` ya está importado de lucide (era el ícono de la pestaña bloqueada "Asesores").
3. Reemplazar la entrada bloqueada `{ id: "advisors" as const, label: "Asesores", icon: Award, locked: true }` por:
   ```ts
   ...(hasPmi ? [{ id: "pmi" as const, label: "Desempeño", icon: Award, locked: false }] : []),
   ```
   con, antes del `return`, `const hasPmi = projectHasMilestoneStages(data?.pipelines ?? [])`. Como ya no queda ninguna pestaña `locked`, borra la rama `if (locked)` y el import de `Lock` si queda sin uso (deja `TooltipProvider`/`Tooltip` si otro sitio los usa).
4. La barra de filtros: `{activeTab !== "conversations" && activeTab !== "pmi" && (<FilterBar …/>)}`.
5. Render, después del bloque `sales`:
   ```tsx
   {activeTab === "pmi" && (
     <PmiDashboard
       contacts={data?.contacts ?? []}
       opportunities={data?.opportunities ?? []}
       appointments={data?.appointments ?? []}
       pautas={data?.pautas ?? []}
       tasks={data?.tasks ?? []}
       calls={data?.calls ?? []}
       messages={messages}
       locationId={data?.locationId ?? ""}
       locationName={locationName ?? undefined}
     />
   )}
   ```
6. Si `activeTab === "pmi"` y `hasPmi` pasa a `false` (cambio de datos), volver a marketing: `useEffect(() => { if (activeTab === "pmi" && !hasPmi) setActiveTab("marketing") }, [activeTab, hasPmi])`.

- [ ] **Step 4: Type-check and drive the app**

Run: `npx tsc --noEmit && pnpm dev`
Expected: en Yconia aparece la pestaña **Desempeño**; en Lezgo Suite no. Septiembre 2026 muestra cinco tiles con Arely/Eder/Mónica seleccionables; clic en el tile de Apartados abre el drawer con la oportunidad de Arely. Los números de Leads deben ser ~32 / 36 / 37 (todos los contactos).

- [ ] **Step 5: Commit**

```bash
git add components/dashboard/pmi-ui.tsx components/dashboard/pmi-dashboard.tsx components/dashboard/dashboard-app.tsx
git commit -m "feat(pmi): pestaña Desempeño — cabecera, tiles y conversiones del mes

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F3a3LMFv11x6QrYvLrpk51"
```

---

### Task 9: `pmi-week-table.tsx` — indicadores × semana con drill

**Files:**
- Create: `components/dashboard/pmi-week-table.tsx`
- Modify: `components/dashboard/pmi-dashboard.tsx`

**Interfaces:**
- Produces:
  ```ts
  export function PmiWeekTable(props: { slice: PmiSlice; weeks: PmiWeek[];
    onCell: (kind: PmiIndicator, ids: string[], weekLabel: string) => void })
  ```

- [ ] **Step 1: Write the component**

```tsx
"use client"

import { cn } from "@/lib/utils"
import { semaphore, type PmiCounts, type PmiIndicator, type PmiSlice, type PmiWeek } from "@/lib/pmi"
import { DashboardCard, ChartCardHeader, ChartCardContent, ScopePill } from "./dashboard-ui"
import { INDICATOR_LABELS, fmtInt, fmtMxn, fmtPct, toneClass } from "./pmi-ui"

// Filas de la tabla: los cinco conteos y los dos montos. Los montos no son
// indicadores con ids propios: abren el drill de su conteo.
type Row =
  | { key: PmiIndicator; label: string; money?: false }
  | { key: "montoApartados" | "montoCierres"; label: string; money: true; drill: PmiIndicator }

const ROWS: Row[] = [
  { key: "leads", label: INDICATOR_LABELS.leads },
  { key: "perfilamientos", label: INDICATOR_LABELS.perfilamientos },
  { key: "citas", label: INDICATOR_LABELS.citas },
  { key: "apartados", label: INDICATOR_LABELS.apartados },
  { key: "montoApartados", label: "Monto de apartados", money: true, drill: "apartados" },
  { key: "cierres", label: INDICATOR_LABELS.cierres },
  { key: "montoCierres", label: "Monto de cierres", money: true, drill: "cierres" },
]

function cellValue(c: PmiCounts, row: Row): number {
  return c[row.key]
}

export function PmiWeekTable({
  slice, weeks, onCell,
}: {
  slice: PmiSlice
  weeks: PmiWeek[]
  onCell: (kind: PmiIndicator, ids: string[], weekLabel: string) => void
}) {
  return (
    <DashboardCard>
      <ChartCardHeader
        title="Indicadores por semana"
        actions={<ScopePill label="Semáforo" tooltip="Contra el objetivo semanal (mes ÷ 4): verde ≥ 180 %, azul ≥ 100 %, rojo ≥ 75 %; debajo, sin color. Semanas de lunes a domingo; un pedazo de menos de 4 días se pega a la vecina." />}
      />
      <ChartCardContent>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-xs tabular-nums">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 pr-2 text-left font-medium">Indicador</th>
                <th className="py-1.5 px-2 text-right font-medium">Obj. semana</th>
                {weeks.map((w) => (
                  <th key={w.index} className="py-1.5 px-2 text-right font-medium">
                    <span className="block">Semana {w.index + 1}</span>
                    <span className="block font-normal normal-case">{w.label}</span>
                  </th>
                ))}
                <th className="py-1.5 px-2 text-right font-medium">Total</th>
                <th className="py-1.5 pl-2 text-right font-medium">Obj. mes</th>
                <th className="py-1.5 pl-2 text-right font-medium">Avance</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((row) => {
                const fmt = row.money ? fmtMxn : fmtInt
                const objWeek = slice.objectives.week[row.key]
                const objMonth = slice.objectives.month[row.key]
                const total = cellValue(slice.total, row)
                const drillKind: PmiIndicator = row.money ? row.drill : row.key
                return (
                  <tr key={row.key} className="border-t border-border/60">
                    <td className="py-1.5 pr-2 font-medium">{row.label}</td>
                    <td className="py-1.5 px-2 text-right text-muted-foreground">{fmt(objWeek)}</td>
                    {weeks.map((w) => {
                      const c = slice.byWeek[w.index]
                      const v = cellValue(c, row)
                      const ids = c.ids[drillKind]
                      return (
                        <td key={w.index} className="py-1 px-1 text-right">
                          <button
                            type="button"
                            disabled={ids.length === 0}
                            onClick={() => onCell(drillKind, ids, `Semana ${w.index + 1} (${w.label})`)}
                            className={cn(
                              "w-full rounded px-1.5 py-1 text-right transition-colors",
                              toneClass(semaphore(v, objWeek)),
                              ids.length > 0 ? "hover:ring-1 hover:ring-primary/40" : "cursor-default",
                            )}
                          >
                            {fmt(v)}
                          </button>
                        </td>
                      )
                    })}
                    <td className={cn("py-1 px-2 text-right font-semibold", toneClass(semaphore(total, objMonth)))}>{fmt(total)}</td>
                    <td className="py-1.5 pl-2 text-right text-muted-foreground">{fmt(objMonth)}</td>
                    <td className="py-1.5 pl-2 text-right">{fmtPct(objMonth > 0 ? total / objMonth : null)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </ChartCardContent>
    </DashboardCard>
  )
}
```

- [ ] **Step 2: Mount it in `pmi-dashboard.tsx`**

Reemplazar el comentario `{/* Task 9–11 agregan aquí… */}` por:

```tsx
          <PmiWeekTable
            slice={slice}
            weeks={pmi.weeks}
            onCell={(kind, ids, weekLabel) => openDrill(kind, ids, `${INDICATOR_LABELS[kind]} · ${scopeTitle}`, `${weekLabel} · ${monthLabel(month)}`)}
          />
          {/* Task 10–11 */}
```

con `import { PmiWeekTable } from "./pmi-week-table"`.

- [ ] **Step 3: Type-check and drive**

Run: `npx tsc --noEmit`, luego en la app: Yconia · septiembre · Equipo. Las semanas deben leer `1 - 6 · 7 - 13 · 14 - 20 · 21 - 30`; la celda Apartados/Semana 1 muestra 1 y abre el drawer con la oportunidad de Arely. Con Arely seleccionada, Leads por semana ≈ 10 / 19 / … (el PMI capturó 10 / 19 / 0 / 0).

- [ ] **Step 4: Commit**

```bash
git add components/dashboard/pmi-week-table.tsx components/dashboard/pmi-dashboard.tsx
git commit -m "feat(pmi): tabla indicadores × semana con semáforo y drill-down

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F3a3LMFv11x6QrYvLrpk51"
```

---

### Task 10: por asesor, rankings y tendencia semanal (vista Equipo)

**Files:**
- Modify: `components/dashboard/pmi-dashboard.tsx`

**Interfaces:**
- Consumes: `PmiMonth.advisors`, `rankingApartados`, `rankingCierres`, `team.byWeek`, `NonZeroTooltipContent`, `CHART_TICK`, `CHART_GRID_STROKE`, `STRUCTURAL_NAVY`, `BRAND_AMBER` de `dashboard-ui.tsx`, `ChartContainer` de `components/ui/chart.tsx`, Recharts.

- [ ] **Step 1: Add the "Por asesor" table**

Debajo de `<PmiWeekTable …/>`, solo cuando `advisor === TEAM`:

```tsx
          {advisor === TEAM && (
            <DashboardCard>
              <ChartCardHeader title="Por asesor" total={pmi.activeAdvisors}
                actions={<ScopePill label="Activos" tooltip="Asesores con al menos un registro en el mes. 'Sin asignar' agrupa lo que no tiene asesor y no entra al ranking." />} />
              <ChartCardContent>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-xs tabular-nums">
                    <thead>
                      <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        <th className="py-1.5 pr-2 text-left font-medium">Asesor</th>
                        {(["leads", "perfilamientos", "citas", "apartados", "cierres"] as const).map((k) => (
                          <th key={k} className="py-1.5 px-2 text-right font-medium">{INDICATOR_LABELS[k]}</th>
                        ))}
                        <th className="py-1.5 px-2 text-right font-medium">$ Apartados</th>
                        <th className="py-1.5 px-2 text-right font-medium">$ Cierres</th>
                        <th className="py-1.5 px-2 text-right font-medium">L→P</th>
                        <th className="py-1.5 px-2 text-right font-medium">P→C</th>
                        <th className="py-1.5 px-2 text-right font-medium">C→A</th>
                        <th className="py-1.5 pl-2 text-right font-medium">A→Ci</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...pmi.advisors, ...(pmi.unassigned ? [{ name: "Sin asignar", ...pmi.unassigned }] : [])].map((a) => {
                        const clickable = a.name !== "Sin asignar"
                        return (
                          <tr key={a.name}
                            className={cn("border-t border-border/60", clickable && "cursor-pointer hover:bg-primary/5")}
                            onClick={clickable ? () => setAdvisor(a.name) : undefined}>
                            <td className="py-1.5 pr-2 font-medium">{a.name}</td>
                            {(["leads", "perfilamientos", "citas", "apartados", "cierres"] as const).map((k) => (
                              <td key={k} className={cn("py-1.5 px-2 text-right", toneClass(semaphore(a.total[k], a.objectives.month[k])))}>{fmtInt(a.total[k])}</td>
                            ))}
                            <td className="py-1.5 px-2 text-right">{fmtMxn(a.total.montoApartados)}</td>
                            <td className="py-1.5 px-2 text-right">{fmtMxn(a.total.montoCierres)}</td>
                            <td className="py-1.5 px-2 text-right">{fmtPct(a.conversions.leadPerfil)}</td>
                            <td className="py-1.5 px-2 text-right">{fmtPct(a.conversions.perfilCita)}</td>
                            <td className="py-1.5 px-2 text-right">{fmtPct(a.conversions.citaApartado)}</td>
                            <td className="py-1.5 pl-2 text-right">{fmtPct(a.conversions.apartadoCierre)}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </ChartCardContent>
            </DashboardCard>
          )}
```

Imports nuevos: `DashboardCard, ChartCardHeader, ChartCardContent` de `./dashboard-ui`; `semaphore` de `@/lib/pmi`; `toneClass, fmtPct` de `./pmi-ui`.

- [ ] **Step 2: Add the two rankings (bar charts vs META)**

Un componente local en el mismo archivo:

```tsx
function RankingChart({
  title, rows, objective, onBar,
}: {
  title: string
  rows: PmiRankingRow[]
  objective: number
  onBar: (name: string) => void
}) {
  const data = rows.map((r) => ({ name: r.name, monto: r.monto, count: r.count }))
  return (
    <DashboardCard>
      <ChartCardHeader title={title}
        actions={<ScopePill label="Meta" tooltip={`La línea marca la meta mensual por asesor: ${fmtMxn(objective)}.`} />} />
      <ChartCardContent>
        {data.length === 0 ? (
          <ChartEmpty message="Sin asesores con actividad en el mes." />
        ) : (
          <ChartContainer config={{ monto: { label: "Monto" } }} className="h-[220px] w-full">
            <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke={CHART_GRID_STROKE} />
              <XAxis dataKey="name" tick={CHART_TICK} axisLine={false} tickLine={false} />
              <YAxis tick={CHART_TICK} axisLine={false} tickLine={false} width={72}
                tickFormatter={(v: number) => `$${(v / 1_000_000).toLocaleString("es-MX", { maximumFractionDigits: 1 })}M`} />
              <ReferenceLine y={objective} stroke={BRAND_AMBER} strokeDasharray="4 4"
                label={{ value: "META", position: "insideTopRight", fontSize: 10, fill: BRAND_AMBER }} />
              <ChartTooltip content={<NonZeroTooltipContent formatter={(v) => fmtMxn(Number(v))} />} />
              <Bar dataKey="monto" fill={STRUCTURAL_NAVY} radius={[4, 4, 0, 0]} onClick={(d) => onBar(String((d as { name: string }).name))} cursor="pointer" />
            </BarChart>
          </ChartContainer>
        )}
      </ChartCardContent>
    </DashboardCard>
  )
}
```

Y en la vista Equipo, después de "Por asesor":

```tsx
          {advisor === TEAM && (
            <div className="grid gap-4 lg:grid-cols-2">
              <RankingChart title="Ranking de apartados" rows={pmi.rankingApartados} objective={PMI_OBJECTIVES.montoApartados}
                onBar={(name) => { const a = pmi.advisors.find((x) => x.name === name); if (a) openDrill("apartados", a.total.ids.apartados, `Apartados · ${name}`, monthLabel(month)) }} />
              <RankingChart title="Ranking de cierres" rows={pmi.rankingCierres} objective={PMI_OBJECTIVES.montoCierres}
                onBar={(name) => { const a = pmi.advisors.find((x) => x.name === name); if (a) openDrill("cierres", a.total.ids.cierres, `Cierres · ${name}`, monthLabel(month)) }} />
            </div>
          )}
```

Imports: `import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, XAxis, YAxis } from "recharts"`, `import { ChartContainer, ChartTooltip } from "@/components/ui/chart"`, `NonZeroTooltipContent, CHART_TICK, CHART_GRID_STROKE, STRUCTURAL_NAVY, BRAND_AMBER, ChartEmpty` de `./dashboard-ui`, `PMI_OBJECTIVES, type PmiRankingRow` de `@/lib/pmi`. Revisa la firma real de `NonZeroTooltipContent` en `dashboard-ui.tsx:14` y ajusta el `formatter` a lo que acepte (si no acepta `formatter`, omítelo: el tooltip mostrará el número crudo).

- [ ] **Step 3: Add the weekly trend (two lines)**

```tsx
function WeekTrend({ title, weeks, values, onPoint }: { title: string; weeks: PmiWeek[]; values: number[]; onPoint: (i: number) => void }) {
  const data = weeks.map((w, i) => ({ label: `Semana ${i + 1}`, value: values[i] }))
  return (
    <DashboardCard>
      <ChartCardHeader title={title} />
      <ChartCardContent>
        <ChartContainer config={{ value: { label: title } }} className="h-[180px] w-full">
          <LineChart data={data} margin={{ top: 12, right: 12, left: 0, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke={CHART_GRID_STROKE} />
            <XAxis dataKey="label" tick={CHART_TICK} axisLine={false} tickLine={false} />
            <YAxis tick={CHART_TICK} axisLine={false} tickLine={false} width={28} allowDecimals={false} />
            <ChartTooltip content={<NonZeroTooltipContent />} />
            <Line type="monotone" dataKey="value" stroke={STRUCTURAL_NAVY} strokeWidth={2}
              dot={{ r: 4, cursor: "pointer" }} activeDot={{ r: 6, onClick: (_e, p) => onPoint((p as { index: number }).index) }}
              label={{ position: "top", fontSize: 11 }} />
          </LineChart>
        </ChartContainer>
      </ChartCardContent>
    </DashboardCard>
  )
}
```

Montado en la vista de mes (Equipo y Asesor, con `slice`):

```tsx
          <div className="grid gap-4 lg:grid-cols-2">
            <WeekTrend title="Perfilamientos por semana" weeks={pmi.weeks} values={slice.byWeek.map((c) => c.perfilamientos)}
              onPoint={(i) => openDrill("perfilamientos", slice.byWeek[i].ids.perfilamientos, `Perfilamientos · ${scopeTitle}`, `Semana ${i + 1} · ${monthLabel(month)}`)} />
            <WeekTrend title="Citas efectivas por semana" weeks={pmi.weeks} values={slice.byWeek.map((c) => c.citas)}
              onPoint={(i) => openDrill("citas", slice.byWeek[i].ids.citas, `Citas efectivas · ${scopeTitle}`, `Semana ${i + 1} · ${monthLabel(month)}`)} />
          </div>
```

`type PmiWeek` al import de `@/lib/pmi`.

- [ ] **Step 4: Type-check and drive**

Run: `npx tsc --noEmit`. En la app: la tabla por asesor lista Arely / Eder / Mónica (+ "Sin asignar" si aplica); clic en una fila cambia el selector; el ranking de apartados muestra la barra de Arely por encima de la línea META; las dos líneas dibujan cuatro puntos.

- [ ] **Step 5: Commit**

```bash
git add components/dashboard/pmi-dashboard.tsx
git commit -m "feat(pmi): tabla por asesor, rankings contra meta y tendencia semanal

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F3a3LMFv11x6QrYvLrpk51"
```

---

### Task 11: `pmi-advisor-sheet.tsx` — cuadrícula diaria

**Files:**
- Create: `components/dashboard/pmi-advisor-sheet.tsx`
- Modify: `components/dashboard/pmi-dashboard.tsx`

**Interfaces:**
- Produces:
  ```ts
  export function PmiAdvisorSheet(props: { slice: PmiSlice; weeks: PmiWeek[]; days: string[];
    onCell: (kind: PmiIndicator, ids: string[], dayLabel: string) => void })
  ```

- [ ] **Step 1: Write the component**

```tsx
"use client"

import { cn } from "@/lib/utils"
import { semaphore, type PmiIndicator, type PmiSlice, type PmiWeek } from "@/lib/pmi"
import { DashboardCard, ChartCardHeader, ChartCardContent, ScopePill } from "./dashboard-ui"
import { INDICATOR_LABELS, fmtInt, toneClass } from "./pmi-ui"

const WEEKDAY = ["D", "L", "M", "M", "J", "V", "S"]

function weekdayLetter(day: string): string {
  const [y, m, d] = day.split("-").map(Number)
  return WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]
}

const ROWS: PmiIndicator[] = ["leads", "perfilamientos", "citas", "apartados", "cierres"]

// La ficha del asesor: indicadores × días agrupados por semana, teñida por el
// semáforo DIARIO (objetivo mes ÷ 28), con el total por semana. Es la tabla
// que el asesor llenaba a mano.
export function PmiAdvisorSheet({
  slice, weeks, days, onCell,
}: {
  slice: PmiSlice
  weeks: PmiWeek[]
  days: string[]
  onCell: (kind: PmiIndicator, ids: string[], dayLabel: string) => void
}) {
  const dayIndex = new Map(days.map((d, i) => [d, i]))
  return (
    <DashboardCard>
      <ChartCardHeader title="Día a día"
        actions={<ScopePill label="Semáforo diario" tooltip="Contra el objetivo diario (semanal ÷ 7): verde ≥ 180 %, azul ≥ 100 %, rojo ≥ 75 %; debajo, sin color. El total de cada semana se compara con el objetivo semanal." />} />
      <ChartCardContent>
        <div className="overflow-x-auto">
          <table className="text-[11px] tabular-nums">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="sticky left-0 bg-card py-1 pr-2 text-left font-medium">Indicador</th>
                {weeks.map((w) => (
                  <th key={w.index} colSpan={w.days.length + 1} className="border-l border-border/60 px-1 py-1 text-center font-medium">
                    Semana {w.index + 1} · {w.label}
                  </th>
                ))}
              </tr>
              <tr className="text-[10px] text-muted-foreground">
                <th className="sticky left-0 bg-card" />
                {weeks.map((w) => (
                  <>
                    {w.days.map((d) => (
                      <th key={d} className="w-7 px-0.5 py-0.5 text-center font-normal">
                        <span className="block">{Number(d.slice(8))}</span>
                        <span className="block opacity-70">{weekdayLetter(d)}</span>
                      </th>
                    ))}
                    <th key={`t${w.index}`} className="px-1 py-0.5 text-center font-medium">Σ</th>
                  </>
                ))}
              </tr>
            </thead>
            <tbody>
              {ROWS.map((kind) => {
                const objDay = slice.objectives.day[kind]
                const objWeek = slice.objectives.week[kind]
                return (
                  <tr key={kind} className="border-t border-border/60">
                    <td className="sticky left-0 bg-card py-0.5 pr-2 font-medium">{INDICATOR_LABELS[kind]}</td>
                    {weeks.map((w) => (
                      <>
                        {w.days.map((d) => {
                          const c = slice.byDay[dayIndex.get(d)!]
                          const v = c[kind]
                          const ids = c.ids[kind]
                          return (
                            <td key={d} className="px-0.5 py-0.5">
                              <button type="button" disabled={ids.length === 0}
                                onClick={() => onCell(kind, ids, `${Number(d.slice(8))} de ${MONTH_NAMES[Number(d.slice(5, 7)) - 1]}`)}
                                className={cn("h-6 w-7 rounded text-center", toneClass(semaphore(v, objDay)),
                                  ids.length > 0 ? "hover:ring-1 hover:ring-primary/40" : "cursor-default opacity-70")}>
                                {v}
                              </button>
                            </td>
                          )
                        })}
                        <td key={`t${w.index}`} className={cn("px-1 py-0.5 text-center font-semibold", toneClass(semaphore(slice.byWeek[w.index][kind], objWeek)))}>
                          {fmtInt(slice.byWeek[w.index][kind])}
                        </td>
                      </>
                    ))}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </ChartCardContent>
    </DashboardCard>
  )
}

const MONTH_NAMES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"]
```

Los fragmentos `<>…</>` dentro de `map` necesitan `key`: usa `<Fragment key={w.index}>` importando `Fragment` de React.

- [ ] **Step 2: Mount it when an advisor is selected**

En `pmi-dashboard.tsx`, en la vista de mes, entre la tira de conversiones y la tabla semanal:

```tsx
          {selected && (
            <PmiAdvisorSheet slice={selected} weeks={pmi.weeks} days={pmi.days}
              onCell={(kind, ids, dayLabel) => openDrill(kind, ids, `${INDICATOR_LABELS[kind]} · ${selected.name}`, dayLabel)} />
          )}
```

- [ ] **Step 3: Type-check and drive**

Run: `npx tsc --noEmit`. En la app, Yconia · septiembre · Arely: la cuadrícula muestra 30 días en cuatro grupos, el día 3 tiene un 1 en Apartados que abre el drawer.

- [ ] **Step 4: Commit**

```bash
git add components/dashboard/pmi-advisor-sheet.tsx components/dashboard/pmi-dashboard.tsx
git commit -m "feat(pmi): ficha del asesor — cuadrícula diaria con semáforo

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F3a3LMFv11x6QrYvLrpk51"
```

---

### Task 12: `pmi-year-table.tsx` — vista anual

**Files:**
- Create: `components/dashboard/pmi-year-table.tsx`
- Modify: `components/dashboard/pmi-dashboard.tsx`

**Interfaces:**
- Produces:
  ```ts
  export function PmiYearView(props: { year: PmiYear; onCell: (kind: PmiIndicator, ids: string[], label: string) => void })
  ```

- [ ] **Step 1: Write the component**

```tsx
"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { PMI_OBJECTIVES, type PmiCounts, type PmiIndicator, type PmiYear, type PmiYearRankingRow } from "@/lib/pmi"
import { DashboardCard, ChartCardHeader, ChartCardContent, ScopePill } from "./dashboard-ui"
import { INDICATOR_LABELS, fmtInt, fmtMxn, fmtPct } from "./pmi-ui"

const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"]
type Metric = PmiIndicator | "montoApartados" | "montoCierres"
const METRICS: { key: Metric; label: string; money: boolean; drill: PmiIndicator }[] = [
  { key: "leads", label: INDICATOR_LABELS.leads, money: false, drill: "leads" },
  { key: "perfilamientos", label: INDICATOR_LABELS.perfilamientos, money: false, drill: "perfilamientos" },
  { key: "citas", label: INDICATOR_LABELS.citas, money: false, drill: "citas" },
  { key: "apartados", label: INDICATOR_LABELS.apartados, money: false, drill: "apartados" },
  { key: "montoApartados", label: "$ Apartados", money: true, drill: "apartados" },
  { key: "cierres", label: INDICATOR_LABELS.cierres, money: false, drill: "cierres" },
  { key: "montoCierres", label: "$ Cierres", money: true, drill: "cierres" },
]

function Cell({ c, metric, onClick }: { c: PmiCounts; metric: (typeof METRICS)[number]; onClick: () => void }) {
  const v = c[metric.key]
  const ids = c.ids[metric.drill]
  return (
    <td className="px-1 py-0.5 text-right">
      <button type="button" disabled={ids.length === 0} onClick={onClick}
        className={cn("w-full rounded px-1 py-0.5 text-right", ids.length > 0 ? "hover:bg-primary/10" : "cursor-default text-muted-foreground")}>
        {metric.money ? fmtMxn(v) : fmtInt(v)}
      </button>
    </td>
  )
}

function YearRanking({ title, rows, objective }: { title: string; rows: PmiYearRankingRow[]; objective: number }) {
  return (
    <DashboardCard>
      <ChartCardHeader title={title}
        actions={<ScopePill label="Meta anual" tooltip={`${fmtMxn(objective)} por asesor por cada mes con actividad. "$ para llegar" es lo que falta contra esa meta.`} />} />
      <ChartCardContent>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-xs tabular-nums">
            <thead>
              <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                <th className="py-1.5 pr-2 text-left font-medium">Asesor</th>
                <th className="py-1.5 px-2 text-right font-medium">Total</th>
                <th className="py-1.5 px-2 text-right font-medium">#</th>
                <th className="py-1.5 px-2 text-right font-medium">Meses activo</th>
                <th className="py-1.5 px-2 text-right font-medium">Promedio</th>
                <th className="py-1.5 px-2 text-right font-medium">Avance</th>
                <th className="py-1.5 pl-2 text-right font-medium">$ para llegar</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className="border-t border-border/60">
                  <td className="py-1.5 pr-2 font-medium">{r.name}</td>
                  <td className="py-1.5 px-2 text-right">{fmtMxn(r.monto)}</td>
                  <td className="py-1.5 px-2 text-right">{fmtInt(r.count)}</td>
                  <td className="py-1.5 px-2 text-right">{r.mesesActivo}</td>
                  <td className="py-1.5 px-2 text-right">{r.promedio === null ? "—" : fmtMxn(r.promedio)}</td>
                  <td className="py-1.5 px-2 text-right">{fmtPct(r.avance)}</td>
                  <td className="py-1.5 pl-2 text-right">{fmtMxn(r.paraLlegar)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCardContent>
    </DashboardCard>
  )
}

export function PmiYearView({ year, onCell }: { year: PmiYear; onCell: (kind: PmiIndicator, ids: string[], label: string) => void }) {
  const [metricKey, setMetricKey] = useState<Metric>("apartados")
  const metric = METRICS.find((m) => m.key === metricKey)!
  return (
    <>
      <DashboardCard>
        <ChartCardHeader title={`Asesor × mes · ${year.year}`}
          actions={
            <select value={metricKey} onChange={(e) => setMetricKey(e.target.value as Metric)}
              className="h-8 rounded-md border border-border bg-card px-2 text-xs" aria-label="Indicador">
              {METRICS.map((m) => <option key={m.key} value={m.key}>{m.label}</option>)}
            </select>
          } />
        <ChartCardContent>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-xs tabular-nums">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  <th className="py-1.5 pr-2 text-left font-medium">Asesor</th>
                  {MONTHS.map((m, i) => (
                    <th key={m} className={cn("py-1.5 px-1 text-right font-medium", i % 3 === 0 && "border-l border-border/60")}>{m}</th>
                  ))}
                  {["T1", "T2", "T3", "T4"].map((q) => <th key={q} className="border-l border-border/60 py-1.5 px-1 text-right font-medium">{q}</th>)}
                  <th className="border-l border-border/60 py-1.5 px-1 text-right font-medium">Total</th>
                  <th className="py-1.5 px-1 text-right font-medium">Meses</th>
                  <th className="py-1.5 pl-1 text-right font-medium">Prom.</th>
                </tr>
              </thead>
              <tbody>
                {year.advisors.map((a) => (
                  <tr key={a.name} className="border-t border-border/60">
                    <td className="py-1 pr-2 font-medium">{a.name}</td>
                    {a.byMonth.map((c, i) => <Cell key={i} c={c} metric={metric} onClick={() => onCell(metric.drill, c.ids[metric.drill], `${a.name} · ${MONTHS[i]} ${year.year}`)} />)}
                    {a.byQuarter.map((c, q) => <Cell key={`q${q}`} c={c} metric={metric} onClick={() => onCell(metric.drill, c.ids[metric.drill], `${a.name} · T${q + 1} ${year.year}`)} />)}
                    <Cell c={a.total} metric={metric} onClick={() => onCell(metric.drill, a.total.ids[metric.drill], `${a.name} · ${year.year}`)} />
                    <td className="py-1 px-1 text-right">{a.mesesActivo}</td>
                    <td className="py-1 pl-1 text-right">{a.promedio ? (metric.money ? fmtMxn(a.promedio[metric.key]) : a.promedio[metric.key].toLocaleString("es-MX", { maximumFractionDigits: 1 })) : "—"}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-border font-semibold">
                  <td className="py-1 pr-2">Equipo</td>
                  {year.team.byMonth.map((c, i) => <Cell key={i} c={c} metric={metric} onClick={() => onCell(metric.drill, c.ids[metric.drill], `Equipo · ${MONTHS[i]} ${year.year}`)} />)}
                  {year.team.byQuarter.map((c, q) => <Cell key={`q${q}`} c={c} metric={metric} onClick={() => onCell(metric.drill, c.ids[metric.drill], `Equipo · T${q + 1} ${year.year}`)} />)}
                  <Cell c={year.team.total} metric={metric} onClick={() => onCell(metric.drill, year.team.total.ids[metric.drill], `Equipo · ${year.year}`)} />
                  <td /><td />
                </tr>
                <tr className="text-muted-foreground">
                  <td className="py-1 pr-2">% meta</td>
                  {year.team.pctMeta.map((p, i) => <td key={i} className="px-1 py-1 text-right">{fmtPct(p ? p[metric.key] : null)}</td>)}
                  <td colSpan={7} />
                </tr>
              </tbody>
            </table>
          </div>
        </ChartCardContent>
      </DashboardCard>
      <div className="grid gap-4 lg:grid-cols-2">
        <YearRanking title={`Ranking de apartados ${year.year}`} rows={year.rankingApartados} objective={PMI_OBJECTIVES.montoApartados} />
        <YearRanking title={`Ranking de cierres ${year.year}`} rows={year.rankingCierres} objective={PMI_OBJECTIVES.montoCierres} />
      </div>
      <DashboardCard>
        <ChartCardHeader title="Ticket promedio" />
        <ChartCardContent>
          <ul className="grid gap-1 text-xs sm:grid-cols-2 lg:grid-cols-4">
            {year.advisors.map((a) => (
              <li key={a.name} className="flex justify-between rounded border border-border px-3 py-2">
                <span>{a.name}</span>
                <span className="tabular-nums">{a.ticketPromedio === null ? "—" : fmtMxn(a.ticketPromedio)}</span>
              </li>
            ))}
          </ul>
        </ChartCardContent>
      </DashboardCard>
    </>
  )
}
```

- [ ] **Step 2: Mount in `pmi-dashboard.tsx`**

Reemplazar `{/* Task 12 agrega aquí la vista anual */}` por:

```tsx
          <PmiYearView year={pmiYear} onCell={(kind, ids, label) => openDrill(kind, ids, `${INDICATOR_LABELS[kind]} · ${label}`)} />
```

- [ ] **Step 3: Type-check and drive**

Run: `npx tsc --noEmit`. En la app: Año → 2026 muestra asesor × mes con selector de indicador; la fila "% meta" es `—` en meses sin actividad; los dos rankings anuales y el ticket promedio se dibujan.

- [ ] **Step 4: Commit**

```bash
git add components/dashboard/pmi-year-table.tsx components/dashboard/pmi-dashboard.tsx
git commit -m "feat(pmi): vista anual — asesor × mes, trimestres, rankings y ticket promedio

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F3a3LMFv11x6QrYvLrpk51"
```

---

### Task 13: PDF — `lib/pmi-report.ts` + `reportType: "pmi"`

**Files:**
- Modify: `lib/report.ts:24` (`reportType`), `:130-141` (tipoLabel / subtitle)
- Modify: `app/api/analyze-report/route.ts:13`, `:79`
- Create: `lib/pmi-report.ts`
- Modify: `components/dashboard/pmi-dashboard.tsx` (botón)

**Interfaces:**
- Produces:
  ```ts
  export type PmiReportVariant = { kind: "month-team"; pmi: PmiMonth } | { kind: "month-advisor"; pmi: PmiMonth; advisor: PmiAdvisor } | { kind: "year"; year: PmiYear }
  export function buildPmiReport(v: PmiReportVariant, locationName?: string): ReportInput
  ```

- [ ] **Step 1: Widen `reportType`**

`lib/report.ts`: `reportType: "marketing" | "ventas" | "pmi"`. En `buildReportSpec`:

```ts
  const tipoLabel = input.reportType === "marketing" ? "Marketing" : input.reportType === "ventas" ? "Ventas" : "Desempeño"
  …
    subtitle:
      input.reportType === "marketing"
        ? "Reporte de adquisición: fuentes, pautas, atribución y resultados de campañas."
        : input.reportType === "ventas"
          ? "Reporte comercial: embudo, conversión, citas y análisis de pérdidas."
          : "Reporte de desempeño (PMI): indicadores por asesor contra objetivos, conversiones y ranking.",
```

`app/api/analyze-report/route.ts`: `reportType: "marketing" | "ventas" | "pmi";` y

```ts
    `Tipo de reporte: ${body.reportType === "marketing" ? "Marketing (adquisición)" : body.reportType === "ventas" ? "Ventas (comercial)" : "Desempeño (PMI: indicadores por asesor contra objetivos fijos)"}`,
```

- [ ] **Step 2: Write `lib/pmi-report.ts`**

```ts
// lib/pmi-report.ts
// El PMI → ReportInput, sobre los mismos lib/pdf/* que Marketing y Ventas.
// Tres variantes según lo que esté en pantalla; el análisis de Haiku va por
// analyze-report como en los otros dos.
import type { ReportInput, ReportSection } from "./report";
import {
  PMI_CONVERSION_TARGETS, PMI_OBJECTIVES, monthLabel, semaphore,
  type PmiAdvisor, type PmiMonth, type PmiSlice, type PmiYear,
} from "./pmi";

export type PmiReportVariant =
  | { kind: "month-team"; pmi: PmiMonth }
  | { kind: "month-advisor"; pmi: PmiMonth; advisor: PmiAdvisor }
  | { kind: "year"; year: PmiYear };

const mxn = (v: number) => v.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
const int = (v: number) => v.toLocaleString("es-MX", { maximumFractionDigits: 0 });
const pct = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(0)} %`);
const toneWord = (t: ReturnType<typeof semaphore>) =>
  t === "alto" ? "Superó" : t === "medio" ? "Alcanzó" : t === "bajo" ? "Se acercó" : "Debajo";

function kpisOf(s: PmiSlice) {
  const o = s.objectives.month;
  return [
    { label: "Leads", value: `${int(s.total.leads)} / ${int(o.leads)}` },
    { label: "Perfilamientos", value: `${int(s.total.perfilamientos)} / ${int(o.perfilamientos)}` },
    { label: "Citas efectivas", value: `${int(s.total.citas)} / ${int(o.citas)}` },
    { label: "Apartados", value: `${int(s.total.apartados)} · ${mxn(s.total.montoApartados)}` },
    { label: "Cierres", value: `${int(s.total.cierres)} · ${mxn(s.total.montoCierres)}` },
  ];
}

function weekSection(s: PmiSlice, pmi: PmiMonth): ReportSection {
  const rows: [string, "leads" | "perfilamientos" | "citas" | "apartados" | "cierres", boolean][] = [
    ["Leads", "leads", false], ["Perfilamientos", "perfilamientos", false], ["Citas efectivas", "citas", false],
    ["Apartados", "apartados", false], ["Cierres", "cierres", false],
  ];
  return {
    id: "semanas",
    title: "Indicadores por semana",
    explanation:
      "Cada indicador por semana del mes contra su objetivo semanal (mes ÷ 4), con el total del mes, el objetivo y el avance. Superó ≥ 180 %, Alcanzó ≥ 100 %, Se acercó ≥ 75 %.",
    blocks: [{
      t: "table",
      headers: ["Indicador", ...pmi.weeks.map((w) => `Sem ${w.index + 1} (${w.label})`), "Total", "Objetivo", "Avance", "Semáforo"],
      rows: rows.map(([label, k]) => {
        const total = s.total[k];
        const obj = s.objectives.month[k];
        return [label, ...s.byWeek.map((c) => int(c[k])), int(total), int(obj), pct(obj > 0 ? total / obj : null), toneWord(semaphore(total, obj))];
      }).concat([
        ["Monto de apartados", ...s.byWeek.map((c) => mxn(c.montoApartados)), mxn(s.total.montoApartados), mxn(s.objectives.month.montoApartados), pct(s.objectives.month.montoApartados > 0 ? s.total.montoApartados / s.objectives.month.montoApartados : null), toneWord(semaphore(s.total.montoApartados, s.objectives.month.montoApartados))],
        ["Monto de cierres", ...s.byWeek.map((c) => mxn(c.montoCierres)), mxn(s.total.montoCierres), mxn(s.objectives.month.montoCierres), pct(s.objectives.month.montoCierres > 0 ? s.total.montoCierres / s.objectives.month.montoCierres : null), toneWord(semaphore(s.total.montoCierres, s.objectives.month.montoCierres))],
      ]),
    }],
  };
}

function conversionsSection(s: PmiSlice): ReportSection {
  const c = s.conversions;
  return {
    id: "conversiones",
    title: "Conversiones del embudo",
    explanation: "Conversión entre etapas consecutivas del PMI contra la meta de cada paso (40 / 60 / 75 / 100 %). Sin denominador no hay conversión que reportar.",
    blocks: [{
      t: "table",
      headers: ["Paso", "Resultado", "Meta"],
      rows: [
        ["Leads → Perfilamientos", pct(c.leadPerfil), pct(PMI_CONVERSION_TARGETS.leadPerfil)],
        ["Perfilamientos → Citas efectivas", pct(c.perfilCita), pct(PMI_CONVERSION_TARGETS.perfilCita)],
        ["Citas efectivas → Apartados", pct(c.citaApartado), pct(PMI_CONVERSION_TARGETS.citaApartado)],
        ["Apartados → Cierres", pct(c.apartadoCierre), pct(PMI_CONVERSION_TARGETS.apartadoCierre)],
      ],
    }],
  };
}

function trendSection(s: PmiSlice, pmi: PmiMonth): ReportSection {
  return {
    id: "tendencia",
    title: "Perfilamientos y citas efectivas por semana",
    explanation: "Actividad de productividad semana a semana: cuántos perfilamientos y cuántas citas efectivas hubo en cada una.",
    blocks: [{
      t: "chart", type: "line", valueLabel: "Registros",
      categories: pmi.weeks.map((w) => `Semana ${w.index + 1}`),
      series: [
        { name: "Perfilamientos", values: s.byWeek.map((c) => c.perfilamientos) },
        { name: "Citas efectivas", values: s.byWeek.map((c) => c.citas) },
      ],
    }],
  };
}

function estimatedCallout(count: number): ReportSection[] {
  if (count === 0) return [];
  return [{
    id: "estimados",
    title: "Nota sobre las fechas",
    explanation: "Aviso metodológico, no un resultado.",
    ai: false,
    blocks: [{ t: "callout", style: "info", text: `${count} hitos del período tienen fecha estimada: son anteriores al arranque de la bitácora y llevan la fecha de su última edición en el CRM.` }],
  }];
}

export function buildPmiReport(v: PmiReportVariant, locationName?: string): ReportInput {
  if (v.kind === "year") {
    const y = v.year;
    const months = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];
    const sections: ReportSection[] = [
      {
        id: "apartados-mes",
        title: "Apartados por asesor y mes",
        explanation: "Monto apartado por asesor en cada mes del año, con el total anual.",
        blocks: [{
          t: "table",
          headers: ["Asesor", ...months, "Total"],
          rows: y.advisors.map((a) => [a.name, ...a.byMonth.map((c) => mxn(c.montoApartados)), mxn(a.total.montoApartados)])
            .concat([["Equipo", ...y.team.byMonth.map((c) => mxn(c.montoApartados)), mxn(y.team.total.montoApartados)]]),
        }],
      },
      {
        id: "cierres-mes",
        title: "Cierres por asesor y mes",
        explanation: "Monto cerrado por asesor en cada mes del año, con el total anual.",
        blocks: [{
          t: "table",
          headers: ["Asesor", ...months, "Total"],
          rows: y.advisors.map((a) => [a.name, ...a.byMonth.map((c) => mxn(c.montoCierres)), mxn(a.total.montoCierres)])
            .concat([["Equipo", ...y.team.byMonth.map((c) => mxn(c.montoCierres)), mxn(y.team.total.montoCierres)]]),
        }],
      },
      {
        id: "actividad-trimestre",
        title: "Actividad por trimestre",
        explanation: "Leads, perfilamientos, citas efectivas, apartados y cierres del equipo por trimestre.",
        blocks: [{
          t: "chart", type: "bar", valueLabel: "Registros",
          categories: ["T1", "T2", "T3", "T4"],
          series: [
            { name: "Leads", values: y.team.byQuarter.map((c) => c.leads) },
            { name: "Perfilamientos", values: y.team.byQuarter.map((c) => c.perfilamientos) },
            { name: "Citas efectivas", values: y.team.byQuarter.map((c) => c.citas) },
            { name: "Apartados", values: y.team.byQuarter.map((c) => c.apartados) },
            { name: "Cierres", values: y.team.byQuarter.map((c) => c.cierres) },
          ],
        }],
      },
      {
        id: "ranking-anual",
        title: "Ranking anual de apartados",
        explanation: `Monto apartado en el año por asesor contra la meta de ${mxn(PMI_OBJECTIVES.montoApartados)} por mes activo, con el promedio mensual y lo que falta para llegar.`,
        blocks: [{
          t: "table",
          headers: ["Asesor", "Total", "Apartados", "Meses activo", "Promedio", "Avance", "$ para llegar"],
          rows: y.rankingApartados.map((r) => [r.name, mxn(r.monto), int(r.count), String(r.mesesActivo), r.promedio === null ? "—" : mxn(r.promedio), pct(r.avance), mxn(r.paraLlegar)]),
        }],
      },
      {
        id: "ticket",
        title: "Ticket promedio",
        explanation: "Monto cerrado entre número de cierres, por asesor.",
        blocks: [{ t: "table", headers: ["Asesor", "Cierres", "Ticket promedio"], rows: y.advisors.map((a) => [a.name, int(a.total.cierres), a.ticketPromedio === null ? "—" : mxn(a.ticketPromedio)]) }],
      },
      ...estimatedCallout(y.estimatedCount),
    ];
    return {
      reportType: "pmi",
      title: `Desempeño ${y.year}`,
      locationName,
      periodLabel: String(y.year),
      kpis: [
        { label: "Leads", value: int(y.team.total.leads) },
        { label: "Apartados", value: `${int(y.team.total.apartados)} · ${mxn(y.team.total.montoApartados)}` },
        { label: "Cierres", value: `${int(y.team.total.cierres)} · ${mxn(y.team.total.montoCierres)}` },
      ],
      sections,
    };
  }

  const { pmi } = v;
  const slice: PmiSlice = v.kind === "month-advisor" ? v.advisor : pmi.team;
  const scope = v.kind === "month-advisor" ? v.advisor.name : "Equipo";
  const sections: ReportSection[] = [weekSection(slice, pmi), conversionsSection(slice)];

  if (v.kind === "month-team") {
    sections.push({
      id: "por-asesor",
      title: "Resultados por asesor",
      explanation: "Los cinco indicadores y los montos de cada asesor en el mes, con sus conversiones.",
      blocks: [{
        t: "table",
        headers: ["Asesor", "Leads", "Perfil.", "Citas", "Apartados", "$ Apartados", "Cierres", "$ Cierres", "L→P", "P→C", "C→A", "A→Ci"],
        rows: pmi.advisors.map((a) => [
          a.name, int(a.total.leads), int(a.total.perfilamientos), int(a.total.citas), int(a.total.apartados), mxn(a.total.montoApartados),
          int(a.total.cierres), mxn(a.total.montoCierres), pct(a.conversions.leadPerfil), pct(a.conversions.perfilCita), pct(a.conversions.citaApartado), pct(a.conversions.apartadoCierre),
        ]),
      }],
    });
    sections.push({
      id: "ranking",
      title: "Ranking de apartados",
      explanation: `Monto apartado por asesor en el mes contra la meta de ${mxn(PMI_OBJECTIVES.montoApartados)}.`,
      blocks: [{ t: "chart", type: "bar", valueLabel: "Monto (MXN)", series: pmi.rankingApartados.map((r) => ({ label: r.name, value: r.monto })) }],
    });
  } else {
    // Ficha del asesor: la cuadrícula diaria como tabla, una fila por indicador.
    sections.push({
      id: "dia-a-dia",
      title: "Día a día",
      explanation: "Registros por día del mes para cada indicador. El objetivo diario es el semanal entre 7.",
      blocks: [{
        t: "table",
        headers: ["Indicador", ...pmi.days.map((d) => String(Number(d.slice(8))))],
        rows: (["leads", "perfilamientos", "citas", "apartados", "cierres"] as const).map((k) => [
          k === "leads" ? "Leads" : k === "perfilamientos" ? "Perfilamientos" : k === "citas" ? "Citas efectivas" : k === "apartados" ? "Apartados" : "Cierres",
          ...slice.byDay.map((c) => String(c[k])),
        ]),
      }],
    });
  }
  sections.push(trendSection(slice, pmi), ...estimatedCallout(pmi.estimatedCount));

  return {
    reportType: "pmi",
    title: `Desempeño · ${scope} · ${monthLabel(pmi.month)}`,
    locationName,
    periodLabel: monthLabel(pmi.month),
    filtersLabel: v.kind === "month-advisor" ? `Asesor: ${v.advisor.name}` : undefined,
    kpis: kpisOf(slice),
    sections,
  };
}
```

- [ ] **Step 3: Mount the export button**

En `pmi-dashboard.tsx`, reemplazar `<div className="ml-auto" data-slot="pmi-export" />` por:

```tsx
        <div className="ml-auto">
          <ExportReportButton getInput={buildReport} />
        </div>
```

con

```tsx
  const buildReport = useCallback((): ReportInput => {
    if (view === "year") return buildPmiReport({ kind: "year", year: pmiYear ?? buildPmiYear(input, year) }, props.locationName)
    if (selected) return buildPmiReport({ kind: "month-advisor", pmi, advisor: selected }, props.locationName)
    return buildPmiReport({ kind: "month-team", pmi }, props.locationName)
  }, [view, pmiYear, input, year, selected, pmi, props.locationName])
```

Imports: `ExportReportButton` de `./export-report-button`, `buildPmiReport` de `@/lib/pmi-report`, `type ReportInput` de `@/lib/report`.

- [ ] **Step 4: Type-check and drive the export**

Run: `npx tsc --noEmit`. En la app, exportar las tres variantes (Equipo, Arely, Año). Los tres PDF abren, con portada "Desempeño · …", la tabla semanal con la columna Semáforo, y el callout de fechas estimadas cuando aplica. pdfmake no corre en Node: esto solo se verifica así.

- [ ] **Step 5: Commit**

```bash
git add lib/pmi-report.ts lib/report.ts app/api/analyze-report/route.ts components/dashboard/pmi-dashboard.tsx
git commit -m "feat(pmi): exportar el PMI a PDF — equipo, asesor y año

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F3a3LMFv11x6QrYvLrpk51"
```

---

### Task 14: documentación, verificación completa y cuadre contra el PMI real

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-09-15-pmi-desempeno-design.md` (estado)

- [ ] **Step 1: Document in `CLAUDE.md`**

1. En el bloque de comandos, después de `verify:meta-attribution`:
   ```
   pnpm verify:pmi          # lib/pmi-stages.ts + lib/pmi.ts — hitos por NOMBRE de etapa, semanas del
                            #   mes, semáforo, conversiones, mes y año
   pnpm verify:pmi-ledger   # lib/pmi-ledger.ts — la bitácora nunca retira un hito; primera vez = estimado;
                            #   roundtrip Postgres con ids sintéticos si hay DATABASE_URL
   ```
   Y en `pnpm db:migrate`: `…, meta_project_accounts y opportunity_milestones en Neon.`
2. En "Current state", una viñeta: la cuarta pestaña **Desempeño** (`pmi-dashboard.tsx`), solo en proyectos con etapa de apartado; ignora la barra de filtros.
3. Nueva sección `### PMI (pestaña Desempeño)` después de "Meta Ads", con estos puntos (redactados en el estilo del archivo):
   - Qué es (el Excel de la consultoría, calculado) y el spec.
   - **Hitos por NOMBRE, no por número** (`10.` es Ganado en Yconia e Inversión Futura en los demás). Tabla de términos. `projectHasMilestoneStages` exige etapa de **apartado** ("Primera Cita" de Lezgo Suite).
   - **`opportunity_milestones` NO es desechable**: la única tabla con historia irrecuperable desde GHL; insert-only, `ON CONFLICT DO NOTHING`; primera vez = `updatedAt` + `estimated`; la base no es dependencia (cae a estimado y sigue).
   - **`status: won` se pone al apartar en Yconia**: `isWonOpp()` cuenta apartados como ganadas en "Ganadas" de Ventas y el CPA de Meta. El PMI va por etapa. **Deuda conocida.**
   - Semanas lunes–domingo, pedazo < 4 días se pega; objetivos fijos `PMI_OBJECTIVES`; bandas 180/100/75.
   - Cita efectiva = cita `showed` por su fecha; lead = todo contacto (con desglose de pauta); apartado es EVENTO, no estado.
   - Fuera: cambaceo, accountability, objetivos editables, asistente.
4. En "Verification scripts" al final de "Internal projects": agregar `verify:pmi`, `verify:pmi-ledger`.

- [ ] **Step 2: Run every verification**

Run:
```bash
pnpm verify:pmi && pnpm verify:pmi-ledger && pnpm verify:sync-store && pnpm verify:filters && pnpm verify:pauta && npx tsc --noEmit && pnpm lint
```
Expected: todo verde; `lint` sin errores nuevos.

- [ ] **Step 3: Cuadre contra el PMI de la consultoría**

En la app, Yconia · Septiembre 2026 · Equipo, anotar en el spec (sección nueva "Cuadre 2026-09-15") la tabla panel vs PMI:

| Asesor | Leads (PMI 31/29/32) | Perfil. (11/8/10) | Citas (4/5/3) | Apartados (0/1/0) | $ Apartados (0 / 3,988,119.69 / 0) |
|---|---|---|---|---|---|
| Mónica / Arely / Eder | … | … | … | … | … |

Las citas `showed` del caché daban 3 / 5 / 1 y los leads 37 / 32 / 36. Perfilamientos y apartados salen con fecha **estimada** este mes. Cualquier diferencia se explica en el spec, no se "corrige" el motor para cuadrar con una captura manual.

- [ ] **Step 4: Mark the spec as implemented and commit**

En el spec: `Estado: implementado 2026-09-15 (rama feat/pmi-desempeno)`.

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-15-pmi-desempeno-design.md
git commit -m "docs(pmi): CLAUDE.md — hitos por nombre, bitácora no desechable, deuda de isWonOpp, cuadre

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01F3a3LMFv11x6QrYvLrpk51"
```

- [ ] **Step 5: Despliegue (con el usuario)**

Antes de mergear/pushear: `pnpm db:migrate` contra producción (`DATABASE_URL_UNPOOLED` de Vercel, `vercel env pull` si hace falta). Luego merge a `main` + push, y un **Actualizar** en cada proyecto inmobiliario para el primer backfill de la bitácora. Confirmar en Neon que `opportunity_milestones` tiene filas por `project_id`.

---

## Self-review

**Spec coverage.** Hitos por nombre (T1) · `effectiveStage` con última etapa (T1) · `projectHasMilestoneStages` (T1, con la corrección de "apartado obligatorio") · tabla + store insert-only (T3) · `reconcileMilestones` con primera vez estimada y sin retiro (T2) · `syncProject` con fallback (T4) · semanas, semáforo, conversiones null, eventos por día local, lead=todos con pauta, cita=showed (T5) · mes: equipo/asesores/sin asignar/rankings/estimados (T6) · año completo: trimestres, meses activo, promedio, ticket, $ para llegar, % meta (T7) · pestaña con selector mes/año/asesor, barra oculta, presencia (T8) · tabla semanal con drill (T9) · por asesor, rankings vs META, tendencia (T10) · cuadrícula diaria (T11) · vista anual (T12) · PDF tres variantes con `filtersLabel` (T13) · docs, deuda de `isWonOpp`, cuadre (T14). Payload viejo sin `milestones` → ceros, no error: cubierto por `collectEvents` (`if (!m) continue`).

**Placeholders.** Ninguno; T10 deja una nota explícita sobre verificar la firma de `NonZeroTooltipContent` en lugar de asumirla.

**Type consistency.** `PmiCounts.ids: Record<PmiIndicator, string[]>` se usa igual en T5–T13. `PmiSlice.objectives.{month,week,day}` igual en T6, T8–T11, T13. `PmiRankingRow.avance: number | null` (T6) y `PmiYearRankingRow` (T7) coinciden con sus consumidores (T10, T12, T13). `buildPmiReport(v, locationName?)` (T13) coincide con su llamada. `OpportunityMilestones` (T2) es lo que lee `collectEvents` (T5).
