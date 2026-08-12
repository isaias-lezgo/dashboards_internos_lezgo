# Caché de sincronización en Postgres — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que abrir un proyecto sirva el dashboard desde Postgres en ~2 segundos en vez de esperar entre 34 y 60 segundos a la API de GHL.

**Architecture:** Una tabla `project_sync` guarda, por proyecto, el payload del dashboard comprimido con gzip más la hora en que se sincronizó. `/api/dashboard` lee esa fila y la sirve; si tiene más de 15 minutos, dispara el refresco en `after()` **después** de responder, así que nadie espera. La orquestación del sync sale del route handler a `lib/sync.ts` para que la ruta y el refresco en segundo plano llamen al mismo código.

**Tech Stack:** Next.js 16 App Router, TypeScript, Neon (PostgreSQL 17 serverless) vía `@neondatabase/serverless`, gzip de `node:zlib`.

**Spec:** `docs/superpowers/specs/2026-08-11-cache-postgres-design.md`

## Global Constraints

- **No hay framework de tests y no se adopta uno.** La verificación son scripts `scripts/verify-*.ts` con `node:assert/strict` vía `tsx`, más manejar la app real.
- **El paquete es CommonJS** (`package.json` no tiene `"type": "module"`): `tsx` compila a CJS y **`await` de nivel superior falla**. Todo script con `await` va dentro de `main()` con `main().catch(...)`.
- **Gestor de paquetes: pnpm.** `pnpm add @neondatabase/serverless` — **nunca `npm install`**, que escribe `package-lock.json` y deja `pnpm-lock.yaml` viejo, rompiendo el build de Vercel con `ERR_PNPM_OUTDATED_LOCKFILE`.
- **`npx tsc --noEmit` es obligatorio** antes de cada commit: `next build` ignora los errores de TypeScript.
- **La base es un acelerador, nunca una dependencia.** Cualquier fallo de Postgres se registra y cae al sync en vivo. Introducir Neon no debe crear una forma nueva de que el dashboard no cargue.
- **Aislamiento entre proyectos:** las funciones del store reciben un `ClientConfig`, nunca un id suelto. Un bug que lea la fila equivocada es la misma clase de fuga que la regla de `AsyncLocalStorage`.
- **`AsyncLocalStorage` sigue intocable:** nada aquí reemplaza `withClient` por una variable de módulo.
- Umbral de frescura: **15 minutos**. Ventana del candado: **10 minutos**. Ambas constantes en código, no en env vars.

**Dos desviaciones deliberadas respecto al spec**, ambas simplificaciones encontradas al leer el código:

1. El spec propone agregar un campo `syncedAt` al frame `data`. **No hace falta:** el payload ya lleva `meta.fetchedAt`, puesto cuando se construye, que es exactamente ese dato — y el header ya lo lee (`dashboard-app.tsx:201`). El contrato NDJSON no cambia en absoluto.
2. **El camino frío no toma el candado.** Dos personas abriendo a la vez un proyecto nunca sincronizado producen dos syncs. Se acepta a propósito: la alternativa sería que la segunda espere el sync de la primera sin ver nada, y eso es peor que gastar una sincronización de más en un caso que ocurre una vez por proyecto. El candado protege el refresco en segundo plano, que sí es frecuente.
- Comentarios y commits en español, con los prefijos del repo (`feat(...)`, `refactor(...)`, `docs(...)`).

---

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `lib/db.ts` **(nuevo)** | El cliente de Neon. **La costura**: nada aguas abajo sabe que la base es Neon. Cambiar de proveedor toca solo este archivo. |
| `lib/sync-store.ts` **(nuevo)** | Leer, escribir y reclamar `project_sync`. La compresión y el umbral de frescura viven aquí. Único módulo que conoce la tabla. |
| `lib/sync.ts` **(nuevo)** | `syncProject()`: la orquestación extraída del route handler, con todos sus helpers de transformación. |
| `lib/types.ts` | Gana `DashboardPayload`, el tipo que hoy está duplicado como `DashboardData` en el hook. |
| `app/api/dashboard/route.ts` | Adelgaza de 689 a ~100 líneas: resuelve el cliente, lee el store, sirve, decide si refresca. |
| `hooks/use-dashboard-data.ts` | `refresh({ fresh: true })` para forzar GHL; `DashboardData` pasa a ser `DashboardPayload`. |
| `components/dashboard/dashboard-app.tsx` | "Actualizado hace X" relativo en vez de la hora del reloj. |
| `components/dashboard/loading-screen.tsx` consumidor | La pantalla de carga espera 300 ms antes de aparecer, para no parpadear en lecturas calientes. |
| `scripts/db-migrate.ts` **(nuevo)** | `CREATE TABLE IF NOT EXISTS`, idempotente. |
| `scripts/verify-sync-store.ts` **(nuevo)** | Aserciones puras + roundtrip real contra la base. |

---

### Task 1: La costura de la base y la tabla

**Files:**
- Create: `lib/db.ts`
- Create: `scripts/db-migrate.ts`
- Modify: `package.json` (bloque `scripts`, dependencia)

**Interfaces:**
- Consumes: `DATABASE_URL` y `DATABASE_URL_UNPOOLED` de `.env.local` (ya configuradas).
- Produces:
  - `function getSql(): NeonQueryFunction<false, false>` — el tagged template de Neon, perezoso y cacheado.
  - `function isDbConfigured(): boolean`
  - `const DB_UNAVAILABLE: unique symbol` no; en su lugar los callers usan try/catch.

- [ ] **Step 1: Instalar la dependencia**

```bash
pnpm add @neondatabase/serverless
```

Verificar que **solo** cambió `pnpm-lock.yaml` y `package.json`:

```bash
git status --short
```

Si aparece `package-lock.json` modificado, se usó npm por error: revertirlo y repetir con pnpm.

- [ ] **Step 2: Escribir `lib/db.ts`**

```ts
// lib/db.ts
// The seam between "where the cache lives" and everything downstream — the same
// role lib/clients.ts plays for the roster. Nothing outside this file knows the
// database is Neon, so swapping providers (or dropping to object storage) touches
// only this module.
//
// Server-only: the browser never talks to the database. Every read and write is
// made by code that already resolved the project through requireClient().
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

let cached: NeonQueryFunction<false, false> | null = null;

export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

// Lazy rather than initialised at module load: importing this file in an
// environment without DATABASE_URL (a verify script, a build step) must not throw.
export function getSql(): NeonQueryFunction<false, false> {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  cached = neon(url);
  return cached;
}
```

- [ ] **Step 3: Escribir `scripts/db-migrate.ts`**

Usa la conexión **sin pooler**: pgbouncer en modo transaction estorba al DDL.

```ts
// Creates the cache table. Idempotent — safe to run on every deploy or by hand.
// Run: pnpm db:migrate
//
// No migration framework: one table does not justify one, and the repo has no
// test framework either. If this ever grows past a couple of tables, revisit.
//
// Wrapped in main() rather than using top-level await: this package is CJS
// ("type" is not "module"), so tsx compiles to CJS where TLA is unavailable.
import { neon } from "@neondatabase/serverless";

async function main() {
  // DDL goes through the UNPOOLED connection: pgbouncer in transaction mode
  // interferes with schema changes.
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL_UNPOOLED (or DATABASE_URL) is not set");
  const sql = neon(url);

  await sql`
    CREATE TABLE IF NOT EXISTS project_sync (
      project_id      text PRIMARY KEY,
      payload         bytea       NOT NULL,
      synced_at       timestamptz NOT NULL,
      sync_started_at timestamptz,
      last_error      text
    )
  `;

  const rows = await sql`
    SELECT column_name, data_type
      FROM information_schema.columns
     WHERE table_name = 'project_sync'
     ORDER BY ordinal_position
  `;
  console.log("✅ project_sync lista:");
  for (const r of rows) console.log(`   ${r.column_name} ${r.data_type}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 4: Registrar el script**

En `package.json`, en el bloque `scripts`, después de `"add-client"`:

```json
    "db:migrate": "tsx scripts/db-migrate.ts",
```

- [ ] **Step 5: Correr la migración**

Run: `pnpm db:migrate`
Expected: imprime las cinco columnas — `project_id text`, `payload bytea`, `synced_at timestamp with time zone`, `sync_started_at timestamp with time zone`, `last_error text`.

Correrlo **una segunda vez** y confirmar que vuelve a pasar sin error: eso prueba que es idempotente.

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add lib/db.ts scripts/db-migrate.ts package.json pnpm-lock.yaml
git commit -m "feat(cache): agrega la costura de Neon y la tabla project_sync"
```

---

### Task 2: El store

**Files:**
- Create: `lib/sync-store.ts`
- Create: `scripts/verify-sync-store.ts`
- Modify: `package.json` (bloque `scripts`)
- Modify: `lib/types.ts` (agregar `DashboardPayload`)

**Interfaces:**
- Consumes: `getSql`, `isDbConfigured` de `lib/db.ts` (Task 1); `ClientConfig` de `lib/clients.ts`.
- Produces:
  - `const FRESH_WINDOW_MS = 15 * 60 * 1000`
  - `function isStale(syncedAt: string | Date, now?: Date): boolean`
  - `async function readSync(client: ClientConfig): Promise<{ payload: DashboardPayload; syncedAt: string } | null>`
  - `async function writeSync(client: ClientConfig, payload: DashboardPayload): Promise<void>`
  - `async function claimSync(client: ClientConfig): Promise<boolean>`
  - `async function releaseSync(client: ClientConfig, error?: string): Promise<void>`
  - En `lib/types.ts`: `interface DashboardPayload`

- [ ] **Step 1: Agregar `DashboardPayload` a `lib/types.ts`**

Al final del archivo. Es la forma exacta del frame `data` que hoy emite el route y que consume el hook — hoy está duplicada como `DashboardData` en `hooks/use-dashboard-data.ts`.

```ts
// The whole dashboard dataset: what the sync produces, what the cache stores, and
// what the browser receives. One definition so the three cannot drift apart.
export interface DashboardPayload {
  locationName: string;
  contacts: Contact[];
  opportunities: Opportunity[];
  calls: Call[];
  tasks: Task[];
  appointments: Appointment[];
  pipelines: Pipeline[];
  members: string[];
  tags: string[];
  campaigns: string[];
  sources: string[];
  pautas: Pauta[];
  customFieldDefs: CustomFieldDef[];
  locationId: string;
  meta: {
    totalContacts: number;
    totalOpportunities: number;
    // When the data was fetched FROM GHL — not when it was read from the cache.
    // This is the timestamp the header renders as "actualizado hace X".
    fetchedAt: string;
  };
}
```

- [ ] **Step 2: Escribir el script de verificación (falla primero)**

`scripts/verify-sync-store.ts`. Corre las aserciones puras siempre, y el roundtrip real **solo si** hay `DATABASE_URL` — así sigue sirviendo en un entorno sin base.

```ts
// Verification for lib/sync-store.ts. Run: pnpm verify:sync-store
//
// The store is keyed BY PROJECT, so a bug here is a cross-project data leak — the
// same class of failure the credential context exists to prevent. That is why this
// script also exercises the real database when DATABASE_URL is present: the SQL is
// where the key actually gets used.
//
// Wrapped in main() rather than using top-level await: this package is CJS
// ("type" is not "module"), so tsx compiles to CJS where TLA is unavailable.
import assert from "node:assert/strict";
import {
  FRESH_WINDOW_MS,
  isStale,
  readSync,
  writeSync,
  claimSync,
  releaseSync,
} from "../lib/sync-store";
import type { ClientConfig } from "../lib/clients";
import type { DashboardPayload } from "../lib/types";

// Synthetic ids that can never collide with a real project: the roster's ID_RE
// forbids underscores, so nothing in DASHBOARD_CLIENTS can ever be named this.
const A: ClientConfig = { id: "__verify_a", name: "A", locationId: "loc-a", ghlToken: "pit-a" };
const B: ClientConfig = { id: "__verify_b", name: "B", locationId: "loc-b", ghlToken: "pit-b" };

function payload(marker: string, fetchedAt: string): DashboardPayload {
  return {
    locationName: `Ubicación ${marker} ñ 🎯`,
    contacts: [],
    opportunities: [],
    calls: [],
    tasks: [],
    appointments: [],
    pipelines: [],
    members: [marker],
    tags: [],
    campaigns: [],
    sources: [],
    pautas: [],
    customFieldDefs: [],
    locationId: `loc-${marker}`,
    meta: { totalContacts: 0, totalOpportunities: 0, fetchedAt },
  };
}

async function main() {
  const now = new Date("2026-08-12T12:00:00.000Z");

  // --- freshness: exact boundaries, not "about 15 minutes"
  assert.equal(FRESH_WINDOW_MS, 15 * 60 * 1000);
  assert.equal(isStale(new Date(now.getTime() - 1000).toISOString(), now), false, "1s old is fresh");
  assert.equal(
    isStale(new Date(now.getTime() - FRESH_WINDOW_MS + 1).toISOString(), now),
    false,
    "just under the window is fresh",
  );
  assert.equal(
    isStale(new Date(now.getTime() - FRESH_WINDOW_MS).toISOString(), now),
    true,
    "exactly the window is stale",
  );
  assert.equal(
    isStale(new Date(now.getTime() - 60 * 60 * 1000).toISOString(), now),
    true,
    "an hour old is stale",
  );
  // A clock skew that puts synced_at in the future must not read as stale.
  assert.equal(isStale(new Date(now.getTime() + 5000).toISOString(), now), false, "future is not stale");

  if (!process.env.DATABASE_URL) {
    console.log("⚠️  DATABASE_URL ausente — se omitió el roundtrip real");
    console.log("✅ lib/sync-store.ts — aserciones puras pasaron");
    return;
  }

  // --- roundtrip: what goes in comes out byte-identical, accents and emoji included
  const stamp = new Date().toISOString();
  await writeSync(A, payload("a", stamp));
  const readA = await readSync(A);
  assert.ok(readA, "A must read back");
  assert.deepEqual(readA.payload, payload("a", stamp), "payload must survive gzip roundtrip");
  assert.equal(readA.payload.locationName, "Ubicación a ñ 🎯");

  // --- THE ISOLATION GUARANTEE: one project's write is invisible to another
  await writeSync(B, payload("b", stamp));
  const againA = await readSync(A);
  assert.ok(againA);
  assert.equal(againA.payload.members[0], "a", "A must still read A's payload, never B's");
  const readB = await readSync(B);
  assert.ok(readB);
  assert.equal(readB.payload.members[0], "b");

  // --- a project that was never synced reads as null, not as an error
  const never = await readSync({ ...A, id: "__verify_nunca" });
  assert.equal(never, null);

  // --- the lock: the second claimer gets nothing while the first holds it
  assert.equal(await claimSync(A), true, "first claim wins");
  assert.equal(await claimSync(A), false, "second claim is refused while held");
  await releaseSync(A);
  assert.equal(await claimSync(A), true, "claimable again after release");
  await releaseSync(A, "boom");

  // --- releasing with an error records it without destroying the cached payload
  const afterError = await readSync(A);
  assert.ok(afterError, "a failed sync must NOT drop the payload we already had");
  assert.equal(afterError.payload.members[0], "a");

  // --- writing overwrites: the cache holds only the present
  const newer = new Date(Date.now() + 1000).toISOString();
  await writeSync(A, payload("a2", newer));
  const overwritten = await readSync(A);
  assert.ok(overwritten);
  assert.equal(overwritten.payload.members[0], "a2");
  assert.equal(overwritten.syncedAt, newer);

  // --- clean up so the table only ever holds real projects
  const { getSql } = await import("../lib/db");
  await getSql()`DELETE FROM project_sync WHERE project_id LIKE '\\_\\_verify%'`;
  const leftovers = await getSql()`SELECT count(*)::int AS n FROM project_sync WHERE project_id LIKE '\\_\\_verify%'`;
  assert.equal(leftovers[0].n, 0, "verification rows must be cleaned up");

  console.log("✅ lib/sync-store.ts — todas las aserciones pasaron (incluido el roundtrip real)");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Registrar el script y correrlo para verlo fallar**

En `package.json`, después de `"verify:scopes"`:

```json
    "verify:sync-store": "tsx scripts/verify-sync-store.ts",
```

Run: `node --env-file=.env.local ./node_modules/.bin/tsx scripts/verify-sync-store.ts`
Expected: FAIL — `Cannot find module '../lib/sync-store'`.

(Se usa `node --env-file` porque `DATABASE_URL` contiene `&`, que rompe el `source` de zsh. Ver el Step 5 para la forma definitiva.)

- [ ] **Step 4: Implementar `lib/sync-store.ts`**

```ts
// lib/sync-store.ts
// The cache: one row per project holding the whole dashboard payload, gzipped.
//
// The cache is DISPOSABLE by design. It is overwritten on every sync and holds
// only the present, never history — so if the table is dropped, it refills itself
// from GHL and nothing is lost. That property is what keeps this one table instead
// of a schema, and it is also what keeps historical personal data from piling up.
//
// bytea + gzip rather than jsonb: we never query inside the payload, we ship it
// whole. Measured on the real Yconia dataset — 27.7 MB → 2.49 MB, 11.1x.
import { gzipSync, gunzipSync } from "node:zlib";
import { getSql } from "./db";
import type { ClientConfig } from "./clients";
import type { DashboardPayload } from "./types";

// How old a payload may be before a visit triggers a background refresh.
export const FRESH_WINDOW_MS = 15 * 60 * 1000;

// How long a claimed sync may run before another request may take the lock over.
// Self-healing: a function that dies mid-sync must not freeze the project forever.
const LOCK_TIMEOUT_MINUTES = 10;

export function isStale(syncedAt: string | Date, now: Date = new Date()): boolean {
  const then = syncedAt instanceof Date ? syncedAt : new Date(syncedAt);
  const age = now.getTime() - then.getTime();
  // A negative age means clock skew put synced_at in the future. Treat it as
  // fresh: re-syncing on every visit would be worse than trusting the row.
  if (age < 0) return false;
  return age >= FRESH_WINDOW_MS;
}

// Every function here takes the ClientConfig, never a bare string. Reading the
// wrong row would render project A's dashboard with project B's data — the same
// cross-project leak lib/ghl-context.ts exists to prevent — so the caller has to
// have resolved a real project through requireClient() to call these at all.
export async function readSync(
  client: ClientConfig,
): Promise<{ payload: DashboardPayload; syncedAt: string } | null> {
  const rows = await getSql()`
    SELECT payload, synced_at FROM project_sync WHERE project_id = ${client.id}
  `;
  if (rows.length === 0) return null;
  const gz = Buffer.from(rows[0].payload);
  // claimSync seeds an empty payload when it takes the lock on a project that was
  // never synced. If that sync then fails, the row survives with zero bytes —
  // gunzip would throw on it. An empty payload means "no cache", not "corrupt".
  if (gz.length === 0) return null;
  const raw = gunzipSync(gz);
  return {
    payload: JSON.parse(raw.toString("utf8")) as DashboardPayload,
    syncedAt: new Date(rows[0].synced_at).toISOString(),
  };
}

export async function writeSync(client: ClientConfig, payload: DashboardPayload): Promise<void> {
  const gz = gzipSync(Buffer.from(JSON.stringify(payload), "utf8"));
  // synced_at comes from the payload, not from now(): it records when the data was
  // fetched from GHL, which is what the header means by "actualizado hace X".
  await getSql()`
    INSERT INTO project_sync (project_id, payload, synced_at, sync_started_at, last_error)
    VALUES (${client.id}, ${gz}, ${payload.meta.fetchedAt}, NULL, NULL)
    ON CONFLICT (project_id) DO UPDATE
       SET payload = EXCLUDED.payload,
           synced_at = EXCLUDED.synced_at,
           sync_started_at = NULL,
           last_error = NULL
  `;
}

// Atomically takes the sync lock. Returns false when someone else holds it, which
// is how two people opening the same stale project at once produce ONE sync.
//
// The whole decision is inside the UPDATE's WHERE clause on purpose: doing it as
// read-then-write in TypeScript would leave a window where both callers see it
// free and both proceed.
export async function claimSync(client: ClientConfig): Promise<boolean> {
  const rows = await getSql()`
    INSERT INTO project_sync (project_id, payload, synced_at, sync_started_at)
    VALUES (${client.id}, ''::bytea, to_timestamp(0), now())
    ON CONFLICT (project_id) DO UPDATE
       SET sync_started_at = now()
     WHERE project_sync.sync_started_at IS NULL
        OR project_sync.sync_started_at < now() - make_interval(mins => ${LOCK_TIMEOUT_MINUTES})
    RETURNING project_id
  `;
  return rows.length > 0;
}

// Releases the lock WITHOUT touching the payload: a failed refresh must leave the
// last good cache in place. Serving data from an hour ago beats serving nothing.
export async function releaseSync(client: ClientConfig, error?: string): Promise<void> {
  await getSql()`
    UPDATE project_sync
       SET sync_started_at = NULL,
           last_error = ${error ?? null}
     WHERE project_id = ${client.id}
  `;
}
```

- [ ] **Step 5: Correr la verificación**

`DATABASE_URL` contiene `&`, así que `source .env.local` en zsh falla. Usar `node --env-file`:

Run: `node --env-file=.env.local ./node_modules/.bin/tsx scripts/verify-sync-store.ts`
Expected: PASS — `✅ lib/sync-store.ts — todas las aserciones pasaron (incluido el roundtrip real)`

Si el `claimSync` del caso "first claim wins" falla en la primera corrida, revisar que la fila sembrada por el INSERT tenga `payload = ''::bytea`: la columna es `NOT NULL`, y un claim sobre un proyecto nunca sincronizado tiene que poder crear la fila.

Run: `npx tsc --noEmit`
Expected: sin errores.

- [ ] **Step 6: Commit**

```bash
git add lib/sync-store.ts scripts/verify-sync-store.ts lib/types.ts package.json
git commit -m "feat(cache): agrega el store de project_sync con su verificacion"
```

---

### Task 3: Extraer el sync a `lib/sync.ts`

Refactor puro: **ningún cambio de comportamiento**. Es lo que permite que el route y el refresco en segundo plano llamen al mismo código, y de paso saca un archivo de 689 líneas del territorio donde nadie lo puede leer entero.

**Files:**
- Create: `lib/sync.ts`
- Modify: `app/api/dashboard/route.ts`

**Interfaces:**
- Consumes: `ClientConfig` de `lib/clients.ts`; `DashboardPayload` de `lib/types.ts` (Task 2); todo `lib/ghl-client.ts`; `withClient` de `lib/ghl-context.ts`.
- Produces:
  - `type SyncFrame = { type: "location"; name: string } | { type: "step"; key: string; status: "loading" | "done"; count?: number } | { type: "progress"; message: string }`
  - `async function syncProject(client: ClientConfig, onFrame?: (frame: SyncFrame) => void): Promise<DashboardPayload>`

- [ ] **Step 1: Mover los helpers a `lib/sync.ts`**

Cortar de `app/api/dashboard/route.ts` **las líneas 1 a 341**, que son los imports y todos los helpers de transformación, y pegarlas en un archivo nuevo `lib/sync.ts` — **con dos excepciones que se quedan en el route**:

- `function enc(obj: unknown): string` (líneas 207-209): es el codificador NDJSON, una preocupación de HTTP.
- `import { requireClient, unauthorized } from "@/lib/session";`: solo lo usa el route.

Encabezar `lib/sync.ts` con:

```ts
// lib/sync.ts
// The GHL sync: everything between "we know which project" and "here is the whole
// dashboard payload". Extracted from app/api/dashboard/route.ts so the route and
// the background refresh call the SAME code — two copies of this would drift.
//
// Knows nothing about HTTP, streams or the cache. It reports progress through
// onFrame and returns the payload; whoever called it decides what to do with both.
import type { ClientConfig } from "./clients";
import type { DashboardPayload } from "./types";
```

y agregar los tipos internos que ya estaban (`Attribution`, etc.) sin cambios.

Ajustar las rutas de import: dentro de `lib/` los imports `@/lib/x` siguen funcionando (el alias `@` apunta a la raíz), así que **no hace falta cambiarlos**. Dejarlos tal cual reduce el diff.

- [ ] **Step 2: Envolver el cuerpo del sync en `syncProject`**

Mover el contenido del callback de `withClient` — **las líneas 366 a 676** del archivo original, o sea el bloque `try { … } catch { … } finally { … }` que hoy vive dentro de `start(controller)` — al cuerpo de esta función:

```ts
export type SyncFrame =
  | { type: "location"; name: string }
  | { type: "step"; key: string; status: "loading" | "done"; count?: number }
  | { type: "progress"; message: string };

// Runs one full sync inside the project's credential context and returns the
// payload. Throws on failure — the caller decides whether that means an error
// frame on a cold load or a swallowed background refresh.
export async function syncProject(
  client: ClientConfig,
  onFrame: (frame: SyncFrame) => void = () => {},
): Promise<DashboardPayload> {
  return withClient(
    client,
    async () => {
      const sendStep = (key: string, status: "loading" | "done", count?: number) =>
        onFrame({ type: "step", key, status, ...(count !== undefined ? { count } : {}) });

      // …the existing body, verbatim, with these mechanical substitutions:
      //   send({ type: "progress", message: m })  →  onFrame({ type: "progress", message: m })
      //   send({ type: "location", name })        →  onFrame({ type: "location", name })
      //   send({ type: "data", ...fields })       →  return { ...fields }
      // The try/catch around it goes away: syncProject throws and the caller
      // handles it. The `finally { controller.close() }` is the route's job.
    },
    // Keeps the caller honest while ghlFetch waits out a backoff. Without this the
    // stream goes silent mid-retry and the UI is stuck at 0% with no way to tell
    // "retrying" from "hung" — which is exactly how a GHL 522 presented on
    // 2026-07-23.
    ({ status, attempt, maxAttempts, delayMs }) => {
      const secs = Math.round(delayMs / 1000);
      onFrame({
        type: "progress",
        message:
          status === 429
            ? `Límite de solicitudes alcanzado, reintentando en ${secs}s… (${attempt}/${maxAttempts})`
            : `El CRM no responde (${status}), reintentando en ${secs}s… (${attempt}/${maxAttempts})`,
      });
    },
  );
}
```

El `send({ type: "data", … })` del final (líneas 632-651 del original) se convierte en el `return` de la función, con exactamente los mismos campos. `locationName` y `client.locationId` siguen resolviéndose igual.

- [ ] **Step 3: Dejar el route llamando a `syncProject`**

`app/api/dashboard/route.ts` queda así **en su totalidad** (todavía sin caché — eso es la Task 4):

```ts
import { requireClient, unauthorized } from "@/lib/session";
import { syncProject } from "@/lib/sync";

export const runtime = "nodejs";

function enc(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

export async function GET() {
  // Resolve the client here, in the request scope — cookies() is unavailable
  // inside the stream callback below.
  const client = await requireClient();
  if (!client) return unauthorized();

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(enc(obj)));
      try {
        const payload = await syncProject(client, send);
        send({ type: "data", ...payload });
      } catch (error) {
        console.error("[GHL Dashboard API Error]", error);
        send({
          type: "error",
          error: "Failed to fetch dashboard data",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
```

- [ ] **Step 4: Verificar que NADA cambió para el usuario**

Run: `npx tsc --noEmit`
Expected: sin errores.

Run: `pnpm dev`, abrir un proyecto.
Expected: **idéntico a antes** — la pantalla de carga con sus seis filas, los contadores subiendo, y el dashboard con los mismos números. Este refactor no debe notarse. Si la pantalla de carga se comporta distinto, alguna substitución de `send` → `onFrame` se perdió.

Run: `wc -l app/api/dashboard/route.ts`
Expected: ~45 líneas (era 689).

- [ ] **Step 5: Commit**

```bash
git add lib/sync.ts app/api/dashboard/route.ts
git commit -m "refactor(sync): extrae la orquestacion del sync a lib/sync.ts"
```

---

### Task 4: La ruta lee el caché

**Files:**
- Modify: `app/api/dashboard/route.ts`

**Interfaces:**
- Consumes: `syncProject`, `SyncFrame` de `lib/sync.ts` (Task 3); `readSync`, `writeSync`, `claimSync`, `releaseSync`, `isStale` de `lib/sync-store.ts` (Task 2); `isDbConfigured` de `lib/db.ts` (Task 1); `after` de `next/server`.
- Produces: `/api/dashboard` sirve del caché; `?fresh=1` fuerza GHL.

- [ ] **Step 1: Reescribir el route completo**

```ts
import { after } from "next/server";
import { requireClient, unauthorized } from "@/lib/session";
import { isDbConfigured } from "@/lib/db";
import { claimSync, isStale, readSync, releaseSync, writeSync } from "@/lib/sync-store";
import { syncProject } from "@/lib/sync";
import type { ClientConfig } from "@/lib/clients";
import type { DashboardPayload } from "@/lib/types";

export const runtime = "nodejs";

// A cold sync took 33.9s on 2026-08-11 and 60.3s half an hour later, on the same
// data — GHL's response time swings by nearly 2x. 300s (Vercel Pro) leaves room
// for that plus growth. Do NOT lower this to the Hobby ceiling of 60s: a refresh
// killed mid-flight fails SILENTLY, because it runs after the response was sent.
export const maxDuration = 300;

function enc(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

export async function GET(req: Request) {
  // Resolve the client here, in the request scope — cookies() is unavailable both
  // inside the stream callback and inside after().
  const client = await requireClient();
  if (!client) return unauthorized();

  const forceFresh = new URL(req.url).searchParams.get("fresh") === "1";

  // The cache is an accelerator, never a dependency: any database failure logs and
  // falls through to the live sync, exactly as the app behaved before it existed.
  const cached = forceFresh ? null : await readCache(client);

  if (cached) {
    // Warm path: one frame, no progress, no GHL. This is the whole point.
    const body = enc({ type: "data", ...cached.payload });
    if (isStale(cached.syncedAt)) {
      // after() runs once the response is fully sent, so the user never waits on
      // this. Without it the function would be torn down as soon as the response
      // closed and the refresh would silently never happen.
      after(() => refreshInBackground(client));
    }
    return ndjson(body);
  }

  // Cold path (never synced, ?fresh=1, or the database is unreachable): stream the
  // live sync with the loading screen, exactly as before, and cache the result.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(enc(obj)));
      try {
        const payload = await syncProject(client, send);
        send({ type: "data", ...payload });
        await saveQuietly(client, payload);
      } catch (error) {
        console.error("[GHL Dashboard API Error]", error);
        send({
          type: "error",
          error: "Failed to fetch dashboard data",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        controller.close();
      }
    },
  });
  return ndjson(stream);
}

function ndjson(body: BodyInit): Response {
  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}

async function readCache(client: ClientConfig) {
  if (!isDbConfigured()) return null;
  try {
    return await readSync(client);
  } catch (err) {
    console.error("[cache] read failed, falling back to a live sync:", err);
    return null;
  }
}

// A cache write must never break a response the user already got.
async function saveQuietly(client: ClientConfig, payload: DashboardPayload) {
  if (!isDbConfigured()) return;
  try {
    await writeSync(client, payload);
  } catch (err) {
    console.error("[cache] write failed:", err);
  }
}

// Runs after the response. Nothing here can reach the user, so every failure path
// ends in a log — but the lock MUST be released either way, or the project stops
// refreshing until the 10-minute timeout expires.
async function refreshInBackground(client: ClientConfig) {
  let claimed = false;
  try {
    claimed = await claimSync(client);
    // Someone else is already syncing this project: two people opening the same
    // stale project at once must produce one sync, not two.
    if (!claimed) return;
    const payload = await syncProject(client);
    await writeSync(client, payload);
    console.log(`[cache] ${client.id} refrescado en segundo plano`);
  } catch (err) {
    console.error(`[cache] background refresh failed for ${client.id}:`, err);
    if (claimed) {
      // Release WITHOUT touching the payload: the last good cache stays, because
      // an hour-old dashboard beats no dashboard.
      await releaseSync(client, err instanceof Error ? err.message : String(err)).catch(() => {});
    }
  }
}
```

Nota sobre `writeSync` en el camino de éxito: ya pone `sync_started_at = NULL`, así que libera el candado por sí solo. `releaseSync` solo hace falta en el camino de error.

- [ ] **Step 2: Verificar el camino frío**

Run: `npx tsc --noEmit`
Expected: sin errores.

Vaciar la tabla y abrir un proyecto:

```bash
node --env-file=.env.local -e "const{neon}=require('@neondatabase/serverless');neon(process.env.DATABASE_URL)\`DELETE FROM project_sync\`.then(()=>console.log('tabla vaciada'))"
```

Con `pnpm dev`, abrir Balvanera (el más rápido, 8.6s).
Expected: pantalla de carga normal, y al terminar queda una fila:

```bash
node --env-file=.env.local -e "const{neon}=require('@neondatabase/serverless');neon(process.env.DATABASE_URL)\`SELECT project_id, synced_at, octet_length(payload) AS bytes FROM project_sync\`.then(r=>console.table(r))"
```

- [ ] **Step 3: Verificar el camino caliente — el resultado que justifica todo**

Recargar la página del mismo proyecto.
Expected: **el dashboard aparece sin pantalla de carga**, en ~1-2 segundos. En la pestaña Network, `/api/dashboard` responde en menos de 2s con un solo frame.

- [ ] **Step 4: Verificar el refresco en segundo plano y el candado**

Envejecer la fila a la fuerza y recargar:

```bash
node --env-file=.env.local -e "const{neon}=require('@neondatabase/serverless');neon(process.env.DATABASE_URL)\`UPDATE project_sync SET synced_at = now() - interval '20 minutes'\`.then(()=>console.log('envejecida'))"
```

Expected: la página aparece **igual de rápido** con lo viejo, y unos segundos después el log del servidor imprime `[cache] balvanera refrescado en segundo plano`, y `synced_at` en la base ya es reciente.

Para el candado: envejecer otra vez y abrir **dos pestañas a la vez** del mismo proyecto.
Expected: **una sola** línea `refrescado en segundo plano` en el log.

- [ ] **Step 5: Verificar que la base no es una dependencia**

Con el servidor corriendo, romper la conexión a propósito:

```bash
DATABASE_URL=postgresql://nadie:nada@no-existe.neon.tech/x?sslmode=require pnpm dev
```

Abrir un proyecto.
Expected: **el dashboard carga en vivo**, con la pantalla de carga de siempre, y en el log aparece `[cache] read failed, falling back to a live sync`. Si en cambio se ve una pantalla de error, la protección no está funcionando y hay que corregirla antes de seguir.

- [ ] **Step 6: Commit**

```bash
git add app/api/dashboard/route.ts
git commit -m "feat(cache): la ruta sirve del cache y refresca en segundo plano"
```

---

### Task 5: La UI dice qué tan viejo es el dato

Un caché sin marca de tiempo visible miente por omisión. Hoy el header muestra la hora del reloj ("Actualizado 14:32"), que con datos en vivo bastaba; con caché lo que importa es **la antigüedad**, no la hora.

**Files:**
- Modify: `components/dashboard/dashboard-app.tsx:199-216`
- Modify: `hooks/use-dashboard-data.ts`

**Interfaces:**
- Consumes: `DashboardPayload` de `lib/types.ts` (Task 2); `?fresh=1` de la ruta (Task 4).
- Produces: `refresh(opts?: { fresh?: boolean })` en `useDashboardData`.

- [ ] **Step 1: Que `DashboardData` deje de duplicar el tipo**

En `hooks/use-dashboard-data.ts`, borrar la `interface DashboardData` completa (líneas 38-58) y reemplazarla por un re-export, para no romper los ~6 archivos que la importan:

```ts
import type { DashboardPayload } from "@/lib/types";

// The payload the sync produces and the cache stores. Kept as an alias because
// several components import DashboardData by name.
export type DashboardData = DashboardPayload;
```

- [ ] **Step 2: Que `refresh` pueda forzar GHL**

En el mismo archivo, cambiar `load` para aceptar la bandera y pasarla a la URL:

```ts
  const load = useCallback(async (sd?: string, ed?: string, fresh?: boolean) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const searchParams = new URLSearchParams();
    if (sd) searchParams.set("startDate", sd);
    if (ed) searchParams.set("endDate", ed);
    // The cache serves everyone by default; this is the escape hatch for someone
    // who just changed something in the CRM and wants to see it now.
    if (fresh) searchParams.set("fresh", "1");
    const qs = searchParams.toString();
    const url = `/api/dashboard${qs ? `?${qs}` : ""}`;
```

y el `refresh` expuesto:

```ts
  const refresh = useCallback(
    (opts?: { fresh?: boolean }) => {
      load(startDate, endDate, opts?.fresh ?? true);
    },
    [load, startDate, endDate],
  );
```

**El default es `true`**: el botón "Actualizar" existe justamente para saltarse el caché. Un refresh que devolviera lo mismo que ya estaba en pantalla se sentiría roto.

- [ ] **Step 3: Mostrar la antigüedad, no la hora**

En `components/dashboard/dashboard-app.tsx`, reemplazar la expresión de las líneas 201-202:

```tsx
                : data?.meta?.fetchedAt
                  ? `Actualizado ${new Date(data.meta.fetchedAt).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit" })}`
```

por:

```tsx
                : data?.meta?.fetchedAt
                  ? `Actualizado ${relativeAge(data.meta.fetchedAt, nowTick)}`
```

Agregar al mismo archivo, junto a los demás helpers de módulo:

```tsx
// With a cache, the age of the data matters more than the clock time it was taken:
// "hace 40 minutos" tells you whether to trust it, "14:32" makes you do the
// subtraction yourself. Anything under a minute reads as current.
function relativeAge(fetchedAt: string, _tick: number): string {
  const mins = Math.floor((Date.now() - new Date(fetchedAt).getTime()) / 60000)
  if (mins < 1) return "hace un momento"
  if (mins === 1) return "hace 1 minuto"
  if (mins < 60) return `hace ${mins} minutos`
  const hrs = Math.floor(mins / 60)
  if (hrs === 1) return "hace 1 hora"
  if (hrs < 24) return `hace ${hrs} horas`
  const days = Math.floor(hrs / 24)
  return days === 1 ? "hace 1 día" : `hace ${days} días`
}
```

Y dentro del componente, un tick que re-renderice cada minuto para que el texto no se congele en "hace un momento" mientras la pestaña sigue abierta:

```tsx
  // The label is relative, so it has to re-render on its own; without this it
  // would still read "hace un momento" an hour later.
  const [nowTick, setNowTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setNowTick((t) => t + 1), 60_000)
    return () => clearInterval(id)
  }, [])
```

(`_tick` no se usa dentro de `relativeAge`; existe para que el valor entre en las dependencias del render.)

- [ ] **Step 4: Que la pantalla de carga no parpadee**

Con lectura caliente la respuesta llega en ~1s, y la pantalla de carga alcanza a aparecer y desaparecer — un destello que se siente peor que no tenerla. En `components/dashboard/dashboard-app.tsx`, junto al `useDashboardData`:

```tsx
  // The loading screen is for the cold path, which takes tens of seconds. On a warm
  // cache the response lands in about a second, and a screen that flashes in and out
  // reads as a glitch. Delay it: if the data beats the timer, it never shows.
  const [showLoading, setShowLoading] = useState(false)
  useEffect(() => {
    if (!isLoading) {
      setShowLoading(false)
      return
    }
    const id = setTimeout(() => setShowLoading(true), 300)
    return () => clearTimeout(id)
  }, [isLoading])
```

y usar `showLoading` en lugar de `isLoading` **solo** para decidir si se renderiza `LoadingScreen`. El resto de la lógica que depende de `isLoading` (deshabilitar el botón Actualizar, etc.) no cambia.

- [ ] **Step 5: Verificar**

Run: `npx tsc --noEmit`
Expected: sin errores.

Con `pnpm dev`:
- Recargar un proyecto ya cacheado → **sin destello** de pantalla de carga, y el header dice "Actualizado hace un momento".
- Envejecer la fila 20 minutos (comando del Task 4 Step 4) y recargar → header dice "Actualizado hace 20 minutos".
- Botón **Actualizar** → aparece la pantalla de carga, tarda lo que tarda GHL, y al terminar el header vuelve a "hace un momento".
- Dejar la pestaña abierta 2 minutos → el texto avanza solo a "hace 2 minutos".

- [ ] **Step 6: Commit**

```bash
git add components/dashboard/dashboard-app.tsx hooks/use-dashboard-data.ts
git commit -m "feat(cache): el header muestra la antiguedad del dato y Actualizar fuerza GHL"
```

---

### Task 6: Documentación y verificación de punta a punta

**Files:**
- Modify: `CLAUDE.md` (bloques `Commands`, `Environment Variables`, `Data flow`)

- [ ] **Step 1: Documentar los comandos**

En el bloque ```bash de `## Commands`, después de `pnpm add-client`:

```
pnpm db:migrate # Crea/verifica la tabla project_sync en Neon (idempotente)
```

y en la lista de verificación, después de `verify:clients`:

```
pnpm verify:sync-store   # lib/sync-store.ts — roundtrip gzip + aislamiento por proyecto + candado
```

Con una nota, porque este script es distinto a los demás:

```markdown
`verify:sync-store` es el único que toca una base real: corre sus aserciones puras
siempre, y el roundtrip contra Postgres solo si hay `DATABASE_URL`. Usa ids
sintéticos (`__verify_*`, imposibles en el roster porque `ID_RE` prohíbe guiones
bajos) y los borra al terminar. Como `DATABASE_URL` contiene `&`, córrelo con
`node --env-file=.env.local ./node_modules/.bin/tsx scripts/verify-sync-store.ts`
— `source .env.local` falla en zsh.
```

- [ ] **Step 2: Documentar los env vars**

En `## Environment Variables`, después de `ANTHROPIC_API_KEY`:

```markdown
- `DATABASE_URL` — Neon (Postgres serverless), el caché de sincronización. La
  integración de Vercel la inyecta sola. **Región `us-east-1`: las funciones de
  Vercel deben estar en `iad1`**, o cada lectura del payload paga el viaje entre
  continentes y se come lo que el caché gana.
- `DATABASE_URL_UNPOOLED` — la misma base sin pgbouncer. Solo la usa
  `pnpm db:migrate`: el pooler en modo transaction estorba al DDL.
```

- [ ] **Step 3: Documentar el flujo**

En `### Data flow`, después del diagrama del sync, agregar:

```markdown
### El caché de sincronización

Un sync completo tarda entre 34 y 60 segundos (Yconia, medido dos veces el mismo día
con los mismos datos — GHL varía casi al doble). Por eso `/api/dashboard` **no llama
a GHL en el camino normal**: lee `project_sync`, una fila por proyecto con el payload
en gzip (27.7 MB → 2.49 MB) y su `synced_at`.

```
GET /api/dashboard
    ↓  requireClient()   → proyecto + alcance
    ↓  readSync(client)  → fila de project_sync
    ├─ hay fila → manda el payload YA; si pasó de 15 min, after(() => refrescar)
    └─ no hay   → sync en vivo con pantalla de carga, y lo guarda
```

- `lib/db.ts` es **la costura**: nada aguas abajo sabe que la base es Neon.
- `lib/sync.ts` tiene la orquestación, extraída del route handler para que la ruta y
  el refresco en segundo plano llamen al mismo código.
- **El caché es desechable.** Se sobrescribe cada vez y guarda solo el presente,
  nunca historia: si se borra la tabla, se rellena sola desde GHL. Esa propiedad es
  lo que lo mantiene en una tabla en vez de un esquema, y lo que evita acumular
  datos personales históricos.
- **La base no es una dependencia.** Todo fallo de Postgres se registra y cae al
  sync en vivo. Introducir el caché no debe crear una forma nueva de que el
  dashboard no cargue — hay que probarlo apuntando `DATABASE_URL` a un host
  inválido y confirmar que la app sigue funcionando.
- **`maxDuration = 300` requiere plan Pro.** El techo de 60s de Hobby ya fue
  rebasado por un sync real de 60.3s, y un refresco en segundo plano cortado falla
  en silencio porque corre después de que la respuesta salió.
- El candado (`sync_started_at`) hace que dos personas abriendo el mismo proyecto
  vencido produzcan **una** sincronización. Se auto-sana a los 10 minutos.
- `/api/dashboard-messages` **no está cacheado** — se puede agregar igual después.
```

- [ ] **Step 4: Verificación completa**

Run: `pnpm verify:clients && pnpm verify:scopes && pnpm verify:auth && pnpm verify:limiter && pnpm verify:context && pnpm verify:attachments && pnpm verify:cf-merge && pnpm verify:write-tools`
Expected: los ocho pasan.

Run: `node --env-file=.env.local ./node_modules/.bin/tsx scripts/verify-sync-store.ts`
Expected: pasa, incluido el roundtrip real.

Run: `npx tsc --noEmit`
Expected: sin errores.

Run: `pnpm build`
Expected: build exitoso.

- [ ] **Step 5: El guion completo contra la app real**

Con la tabla vacía y `pnpm dev`:

1. Abrir **Yconia** → pantalla de carga, 34-60s, y queda su fila.
2. Recargar → **sin pantalla de carga**, ~1-2s, header "Actualizado hace un momento". *Éste es el resultado que justifica todo el trabajo.*
3. Cambiar a **Condesa** (nunca sincronizada) → pantalla de carga; luego recargar → instantáneo.
4. Volver a **Yconia** → instantáneo, y con **sus** números, no los de Condesa. El caché no cruza proyectos.
5. Envejecer las filas 20 min y recargar Yconia → rápido con lo viejo, y `synced_at` avanza segundos después.
6. Dos pestañas del mismo proyecto vencido → **una** sola línea `refrescado en segundo plano`.
7. Botón **Actualizar** → sync en vivo, header vuelve a "hace un momento".
8. `DATABASE_URL` inválida → el dashboard **sigue cargando** en vivo, con el error en el log.
9. Abrir la pestaña **Asistente IA** y hacer una pregunta sobre los datos → responde igual que antes. El asistente opera sobre el payload, así que si el roundtrip de gzip hubiera corrompido algo, aquí se nota.

- [ ] **Step 6: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(cache): documenta el cache de sincronizacion en Postgres"
```

---

## Antes de desplegar

1. **Subir el proyecto de Vercel a Pro.** `maxDuration = 300` lo exige, y un sync real ya rebasó el techo de Hobby.
2. **Confirmar que las funciones corren en `iad1`** (Settings → Functions), la misma región que la base.
3. **Correr `pnpm db:migrate` contra la base de producción.** La tabla no se crea sola en el primer deploy.
4. Verificar que Vercel inyectó `DATABASE_URL` en el proyecto (la integración de Neon lo hace, pero conviene mirarlo).
5. **Medir la lectura ya desplegada.** Los ~1.5s medidos son desde México contra `us-east-1`; desde una función en la misma región deberían ser décimas. Si resultara ser el costo dominante, la salida es mover el payload a almacenamiento de objetos dejando Postgres para el historial futuro.
