# Meta Ads ① — conexión única, cuentas por proyecto, dataset en el sync y cruce — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un botón "Conectar con Meta" (solo alcance `all`) que guarda el token de la empresa de Lezgo en Neon, un selector de cuenta publicitaria por proyecto, un paso `meta` del sync que trae jerarquía + gasto diario por ad al `DashboardPayload`, y un módulo puro que cruza ese gasto con las oportunidades por ad id.

**Architecture:** Port de la entrega ① de DRT (`/Users/isaiasrios/Software/DASHBOARDS_GRUPO_DRT`, commit `bb92c40`). Lo puro (`meta-oauth`, `meta-normalize`, `meta-client`, tipos) se copia literal; el store, las rutas, el paso del sync, el cruce y la píldora se adaptan a un despliegue interno: una conexión por despliegue (`meta_connection` con PK `product`), cuentas por proyecto (`meta_project_accounts`), compuerta del alcance `all`, y `metaAdsStatus` en el payload en vez de `warnings[]`.

**Tech Stack:** Next.js 16 App Router (Node runtime), Web Crypto (HMAC + AES-GCM + HKDF), `@neondatabase/serverless`, Graph API v23.0 vía `fetch`, `tsx` + `node:assert/strict` para los verify scripts, shadcn `popover`/`dialog`/`checkbox` (ya instalados).

**Spec:** `docs/superpowers/specs/2026-09-14-meta-ads-conexion-y-sync-design.md` (y, para las razones que no cambian, `DASHBOARDS_GRUPO_DRT/docs/superpowers/specs/2026-09-13-meta-ads-conexion-y-sync-design.md`).

## Global Constraints

- Package manager **pnpm**; nunca `npm install`. No se agregan dependencias.
- `npx tsc --noEmit` es la compuerta real (`next build` ignora errores de TS). Cero errores al final de **cada** tarea.
- Los verify scripts son CJS: `async function main()` + `main().catch(...)`, **nunca** top-level `await`.
- `DRT=/Users/isaiasrios/Software/DASHBOARDS_GRUPO_DRT` es la fuente de las copias literales. Después de copiar, `diff` contra el original debe mostrar **solo** lo que la tarea marca.
- Las funciones del store que son por proyecto reciben `ClientConfig`, nunca un string (`lib/sync-store.ts` es el modelo).
- `lib/meta-client.ts` es **server-only**: jamás importado desde un componente.
- El token de Meta nunca sale a un frame, un log ni una respuesta HTTP. Solo `readMetaConnectionWithToken` lo entrega, y solo el sync lo llama.
- El campo existente `DashboardPayload.meta` (`totalContacts`, …) **no se toca**. Lo nuevo es `metaAds` y `metaAdsStatus`.
- `oppAdId()` es la única función que lee el ad id de una oportunidad.
- Nada de Meta puede crear una forma nueva de que el panel no cargue: todo fallo se registra y el sync de GHL sigue.
- Commits en español, estilo `feat(meta): …`, con los trailers de atribución de la sesión.

---

## File Structure

| Archivo | Responsabilidad | Origen |
|---|---|---|
| `lib/meta-oauth.ts` | state firmado, cifrado del token, URL del diálogo (puro) | copia, `clientId`→`scopeId` |
| `lib/meta-normalize.ts` | insight rows → `MetaDailyRow`, jerarquía, chunks por mes, ventana de historia (puro) | copia literal |
| `lib/meta-client.ts` | Graph API con reintentos; `fetchMetaAds` (server-only) | copia literal |
| `lib/types.ts` | `MetaAccount…MetaAdsData`, `MetaAdsStatus`, `metaAds`/`metaAdsStatus` en el payload | copia + nuevo |
| `lib/meta-connection-store.ts` | `meta_connection` (una fila por producto) + `meta_project_accounts` (por proyecto) | adaptado |
| `lib/meta-attribution.ts` | `oppAdId`, índice, `classifyLead`, `buildCostSummary`, `buildCampaignPerformance` (puro) | reescrito |
| `app/api/meta/{connect,callback,connection,accounts}/route.ts` | OAuth, estado, asignación — compuerta `all` | adaptado |
| `lib/sync.ts` | paso `meta` → `metaAds` + `metaAdsStatus` | adaptado |
| `app/api/dashboard/route.ts` | `preserveMetaAds` (rescate del último bueno) | adaptado |
| `hooks/fetch-stream.ts`, `hooks/use-dashboard-data.ts`, `components/dashboard/loading-screen.tsx` | `StepKey` `meta`, estados `partial`/`error`, riel que no cuenta el paso ausente | nuevo |
| `components/dashboard/meta-connection.tsx` | la píldora del header | adaptado |
| `components/dashboard/dashboard-app.tsx` | monta la píldora | nuevo |
| `scripts/db-migrate.ts` | las dos tablas | nuevo |
| `scripts/verify-meta-oauth.ts`, `verify-meta.ts` | copia (oauth: `scopeId`) | copia |
| `scripts/verify-meta-connection-store.ts`, `verify-meta-attribution.ts` | reescritos | nuevo |
| `package.json`, `CLAUDE.md` | scripts y documentación | nuevo |

---

### Task 1: lo puro que se copia — `meta-oauth`, `meta-normalize`, tipos y sus verify

**Files:**
- Create: `lib/meta-oauth.ts` (copia de `$DRT/lib/meta-oauth.ts`, `clientId` → `scopeId`)
- Create: `lib/meta-normalize.ts` (copia literal)
- Create: `scripts/verify-meta-oauth.ts` (copia, `clientId` → `scopeId`)
- Create: `scripts/verify-meta.ts` (copia literal)
- Modify: `lib/types.ts` (bloque Meta + `metaAds`/`metaAdsStatus` en `DashboardPayload`)
- Modify: `package.json` (dos scripts)

**Interfaces:**
- Produces: `signState({ scopeId, product, returnTo })`, `verifyState(value) → MetaState | null` con `MetaState = { scopeId, product, returnTo, nonce, iat }`, `encryptToken`, `decryptToken`, `buildDialogUrl`, `redirectUriFor`, `OAUTH_COOKIE`, `STATE_MAX_AGE_MS`, `GRAPH_VERSION`, `type MetaProduct = "ads" | "whatsapp"`.
- Produces: `historyWindow(opps, today)`, `monthChunks`, `normalizeInsightRow`, `normalizeAds`, `mergeMetaAds`, `MAX_HISTORY_MONTHS`.
- Produces (types): `MetaAccount`, `MetaCampaign`, `MetaAdset`, `MetaAd`, `MetaDailyRow`, `MetaAdsData`, `MetaAdsStatus`, `DashboardPayload.metaAds?: MetaAdsData | null`, `DashboardPayload.metaAdsStatus?: MetaAdsStatus`.

- [ ] **Step 1: Copiar los cuatro archivos**

```bash
DRT=/Users/isaiasrios/Software/DASHBOARDS_GRUPO_DRT
cp $DRT/lib/meta-oauth.ts lib/meta-oauth.ts
cp $DRT/lib/meta-normalize.ts lib/meta-normalize.ts
cp $DRT/scripts/verify-meta-oauth.ts scripts/verify-meta-oauth.ts
cp $DRT/scripts/verify-meta.ts scripts/verify-meta.ts
```

- [ ] **Step 2: Renombrar `clientId` → `scopeId` en `meta-oauth.ts` y su verify**

En `lib/meta-oauth.ts`:

```bash
sed -i '' 's/clientId/scopeId/g' lib/meta-oauth.ts scripts/verify-meta-oauth.ts
```

Y reemplazar el comentario de cabecera de `lib/meta-oauth.ts` (líneas 9-11) por:

```ts
// El `state` lleva el id del ALCANCE dentro del payload firmado. En este
// despliegue la conexión es una por instalación, así que lo que el callback
// exige es que el state venga de una sesión del alcance `all` — la misma que
// puede apretar "Conectar". Un state ajeno bien firmado no debe guardar nada.
```

En `scripts/verify-meta-oauth.ts`, después del `sed` los valores de prueba quedan `scopeId: "drt"`; cámbialos a `"all"` y el forjado a `"domus"`:

```bash
sed -i '' 's/scopeId: "drt"/scopeId: "all"/g; s/assert.equal(back.scopeId, "drt")/assert.equal(back.scopeId, "all")/; s/scopeId: "otro"/scopeId: "domus"/; s/state con scopeId ajeno se rechaza/state con scopeId ajeno (domus) se rechaza/' scripts/verify-meta-oauth.ts
sed -i '' 's#https://drt.lezgosuite.com#https://proyectos.lezgosuite.com#g; s#https://drt-psi.vercel.app#https://dashboards-internos-lezgo.vercel.app#g' scripts/verify-meta-oauth.ts
```

- [ ] **Step 3: Verificar que el diff contra DRT es solo eso**

```bash
diff $DRT/lib/meta-oauth.ts lib/meta-oauth.ts
diff $DRT/lib/meta-normalize.ts lib/meta-normalize.ts   # vacío
diff $DRT/scripts/verify-meta.ts scripts/verify-meta.ts  # vacío
```

Esperado en `meta-oauth.ts`: solo líneas con `clientId`/`scopeId` y el comentario de cabecera.

- [ ] **Step 4: Tipos en `lib/types.ts`**

Antes de `// The whole dashboard dataset:` (línea ~222) insertar el bloque copiado de `$DRT/lib/types.ts` (líneas 216-276, desde `// ── Meta Ads` hasta el cierre de `MetaAdsData`) y a continuación el tipo nuevo:

```ts
/**
 * Cómo le fue al paso `meta` en el último sync. Viaja en el payload (y por tanto
 * en el caché) para que la píldora lo lea también en un load en caliente.
 * `none` = nadie conectó o el proyecto no tiene cuenta asignada: NO es error.
 */
export type MetaAdsStatus =
  | { state: "none" }
  | { state: "ok" }
  | { state: "partial"; failedAccounts: { id: string; reason: string }[] }
  | { state: "error"; reason: "token_revoked" | "token_unreadable" | "failed" }
```

Y en `DashboardPayload`, después de `customFieldDefs: CustomFieldDef[]`:

```ts
  // Opcionales: un frame `data` cacheado por un deploy anterior no los trae.
  // `metaAds` es null sin conexión; el campo existente `meta` NO cambia.
  metaAds?: MetaAdsData | null
  metaAdsStatus?: MetaAdsStatus
```

- [ ] **Step 5: Scripts en `package.json`**

Después de `"verify:drill-export"`:

```json
    "verify:meta-oauth": "tsx scripts/verify-meta-oauth.ts",
    "verify:meta": "tsx scripts/verify-meta.ts",
```

- [ ] **Step 6: Correr los verify y tsc**

```bash
pnpm verify:meta-oauth   # ✅ verify:meta-oauth OK
pnpm verify:meta         # ✅ verify:meta OK
npx tsc --noEmit         # sin salida
```

- [ ] **Step 7: Commit**

```bash
git add lib/meta-oauth.ts lib/meta-normalize.ts lib/types.ts scripts/verify-meta-oauth.ts scripts/verify-meta.ts package.json
git commit -m "feat(meta): state firmado por alcance, cifrado del token, normalización y tipos del dataset (port de DRT)"
```

---

### Task 2: tablas, `meta-connection-store` y el cliente Graph

**Files:**
- Modify: `scripts/db-migrate.ts`
- Create: `lib/meta-connection-store.ts`
- Create: `lib/meta-client.ts` (copia literal de `$DRT/lib/meta-client.ts`)
- Create: `scripts/verify-meta-connection-store.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `encryptToken`, `decryptToken`, `MetaProduct` (Task 1); `getSql`, `isDbConfigured` (`lib/db.ts`); `ClientConfig`.
- Produces: `MetaAccountInfo`, `MetaConnection`, `MetaConnectionWithToken`; `readMetaConnection(product)`, `readMetaConnectionWithToken(product)`, `writeMetaConnection(product, input)`, `deleteMetaConnection(product)`, `readProjectAccounts(client, product): Promise<string[]>`, `writeProjectAccounts(client, product, ids): Promise<boolean>`.
- Produces: `fetchMetaAds({ token, accounts, window, onProgress })`, `exchangeCode`, `debugToken`, `fetchMe`, `listAdAccounts`, `MetaApiError` (con `.isTokenInvalid`).

- [ ] **Step 1: Tablas en `scripts/db-migrate.ts`**

Después del `CREATE TABLE IF NOT EXISTS project_sync (…)` y antes del `SELECT column_name`:

```ts
  // La conexión con Meta: UNA por despliegue (PK = product), no por proyecto.
  // A diferencia de project_sync NO es desechable: si se borra hay que volver
  // a apretar "Conectar con Meta".
  await sql`
    CREATE TABLE IF NOT EXISTS meta_connection (
      product             text        PRIMARY KEY,
      token_encrypted     bytea       NOT NULL,
      token_kind          text        NOT NULL,
      token_expires_at    timestamptz,
      business_id         text,
      connected_by        text,
      available_accounts  jsonb       NOT NULL,
      connected_at        timestamptz NOT NULL,
      updated_at          timestamptz NOT NULL
    )
  `;

  // Qué cuentas publicitarias mira cada proyecto. Sin FK a meta_connection a
  // propósito: reconectar con la misma empresa no debe borrar asignaciones.
  await sql`
    CREATE TABLE IF NOT EXISTS meta_project_accounts (
      project_id   text        NOT NULL,
      product      text        NOT NULL,
      account_ids  jsonb       NOT NULL,
      updated_at   timestamptz NOT NULL,
      PRIMARY KEY (project_id, product)
    )
  `;
```

Y cambiar el reporte final para listar las tres tablas:

```ts
  for (const table of ["project_sync", "meta_connection", "meta_project_accounts"]) {
    const rows = await sql`
      SELECT column_name, data_type
        FROM information_schema.columns
       WHERE table_name = ${table}
       ORDER BY ordinal_position
    `;
    console.log(`✅ ${table} lista:`);
    for (const r of rows) console.log(`   ${r.column_name} ${r.data_type}`);
  }
```

(reemplaza el bloque `const rows = await sql\`SELECT column_name…\`` + su `console.log` existente.)

Actualizar el comentario de cabecera: `// Crea las tablas del caché y de Meta. Idempotente…`.

- [ ] **Step 2: Escribir `lib/meta-connection-store.ts`**

```ts
// lib/meta-connection-store.ts
// La conexión con Meta de ESTE despliegue (una fila por producto) y qué cuentas
// publicitarias mira cada proyecto (una fila por proyecto y producto).
//
// A diferencia de project_sync, ninguna de las dos es desechable: si se borra la
// conexión hay que volver a apretar "Conectar con Meta"; si se borran las
// asignaciones hay que volver a elegir cuentas. Es el único estado del sistema
// que no se rellena solo, y por eso los DELETE piden confirmación en la UI.
//
// Las funciones por proyecto reciben el ClientConfig, nunca un string suelto —
// leer la fila equivocada pintaría el gasto de A en el panel de B, la misma
// clase de fuga que lib/ghl-context.ts existe para evitar.
//
// Sin DATABASE_URL: lecturas devuelven null/[], escrituras no hacen nada y lo
// registran. La base sigue sin ser una dependencia del panel.
import { getSql, isDbConfigured } from "./db";
import { encryptToken, decryptToken, type MetaProduct } from "./meta-oauth";
import type { ClientConfig } from "./clients";

export interface MetaAccountInfo {
  /** Con prefijo, tal como lo da Graph: "act_123". */
  id: string;
  name: string;
  currency: string;
  timezone: string;
  /** account_status de Graph: 1 activa, 2 deshabilitada, 3 sin pagar, … */
  status: number;
}

export interface MetaConnection {
  product: MetaProduct;
  tokenKind: "system_user" | "user";
  /** ISO, o null para un token de usuario del sistema (no caduca). */
  tokenExpiresAt: string | null;
  businessId: string | null;
  connectedBy: string | null;
  availableAccounts: MetaAccountInfo[];
  connectedAt: string;
  updatedAt: string;
}

export interface MetaConnectionWithToken extends MetaConnection {
  /**
   * null cuando la fila existe pero el blob no descifra (DASHBOARD_AUTH_SECRET
   * rotado). Se distingue de "no hay fila" a propósito: el sync lo reporta como
   * error `token_unreadable` en vez de callar como si nadie hubiera conectado.
   */
  token: string | null;
}

interface Row {
  product: string;
  token_encrypted: Uint8Array | Buffer;
  token_kind: string;
  token_expires_at: string | Date | null;
  business_id: string | null;
  connected_by: string | null;
  available_accounts: MetaAccountInfo[];
  connected_at: string | Date;
  updated_at: string | Date;
}

function iso(v: string | Date): string {
  return new Date(v).toISOString();
}

function fromRow(r: Row): MetaConnection {
  return {
    product: r.product as MetaProduct,
    tokenKind: r.token_kind === "user" ? "user" : "system_user",
    tokenExpiresAt: r.token_expires_at ? iso(r.token_expires_at) : null,
    businessId: r.business_id,
    connectedBy: r.connected_by,
    availableAccounts: r.available_accounts ?? [],
    connectedAt: iso(r.connected_at),
    updatedAt: iso(r.updated_at),
  };
}

async function readRow(product: MetaProduct): Promise<Row | null> {
  if (!isDbConfigured()) return null;
  const rows = (await getSql()`
    SELECT product, token_encrypted, token_kind, token_expires_at, business_id,
           connected_by, available_accounts, connected_at, updated_at
      FROM meta_connection
     WHERE product = ${product}
  `) as Row[];
  return rows[0] ?? null;
}

export async function readMetaConnection(product: MetaProduct): Promise<MetaConnection | null> {
  const row = await readRow(product);
  return row ? fromRow(row) : null;
}

// Separada a propósito: el token solo lo pide el sync. La píldora y las rutas de
// estado usan readMetaConnection y no pueden filtrarlo por accidente.
export async function readMetaConnectionWithToken(
  product: MetaProduct
): Promise<MetaConnectionWithToken | null> {
  const row = await readRow(product);
  if (!row) return null;
  const token = await decryptToken(new Uint8Array(row.token_encrypted));
  return { ...fromRow(row), token };
}

export async function writeMetaConnection(
  product: MetaProduct,
  input: {
    token: string;
    tokenKind: "system_user" | "user";
    tokenExpiresAt: string | null;
    businessId: string | null;
    connectedBy: string | null;
    availableAccounts: MetaAccountInfo[];
  }
): Promise<void> {
  if (!isDbConfigured()) {
    console.error("[meta] writeMetaConnection sin DATABASE_URL: no hay dónde guardar el token");
    return;
  }
  const blob = Buffer.from(await encryptToken(input.token));
  await getSql()`
    INSERT INTO meta_connection (
      product, token_encrypted, token_kind, token_expires_at, business_id,
      connected_by, available_accounts, connected_at, updated_at
    ) VALUES (
      ${product}, ${blob}, ${input.tokenKind}, ${input.tokenExpiresAt},
      ${input.businessId}, ${input.connectedBy},
      ${JSON.stringify(input.availableAccounts)}::jsonb,
      now(), now()
    )
    ON CONFLICT (product) DO UPDATE
       SET token_encrypted    = EXCLUDED.token_encrypted,
           token_kind         = EXCLUDED.token_kind,
           token_expires_at   = EXCLUDED.token_expires_at,
           business_id        = EXCLUDED.business_id,
           connected_by       = EXCLUDED.connected_by,
           available_accounts = EXCLUDED.available_accounts,
           updated_at         = now()
  `;
}

// No toca meta_project_accounts: reconectar con la misma empresa debe encontrar
// las asignaciones donde estaban.
export async function deleteMetaConnection(product: MetaProduct): Promise<void> {
  if (!isDbConfigured()) return;
  await getSql()`DELETE FROM meta_connection WHERE product = ${product}`;
}

// ── Por proyecto ────────────────────────────────────────────────────────────

export async function readProjectAccounts(client: ClientConfig, product: MetaProduct): Promise<string[]> {
  if (!isDbConfigured()) return [];
  const rows = (await getSql()`
    SELECT account_ids FROM meta_project_accounts
     WHERE project_id = ${client.id} AND product = ${product}
  `) as { account_ids: string[] }[];
  return rows[0]?.account_ids ?? [];
}

// false si no hay conexión o si algún id no está entre las cuentas que la
// empresa compartió. La validación va contra la fila, no contra lo que mande el
// browser. Una lista VACÍA es válida: es "quitarle Meta a este proyecto".
export async function writeProjectAccounts(
  client: ClientConfig,
  product: MetaProduct,
  ids: string[]
): Promise<boolean> {
  if (!isDbConfigured()) {
    console.error("[meta] writeProjectAccounts sin DATABASE_URL: no hay dónde guardar");
    return false;
  }
  const conn = await readRow(product);
  if (!conn) return false;
  const available = new Set((conn.available_accounts ?? []).map((a) => a.id));
  if (!ids.every((id) => available.has(id))) return false;
  const unique = Array.from(new Set(ids));
  await getSql()`
    INSERT INTO meta_project_accounts (project_id, product, account_ids, updated_at)
    VALUES (${client.id}, ${product}, ${JSON.stringify(unique)}::jsonb, now())
    ON CONFLICT (project_id, product) DO UPDATE
       SET account_ids = EXCLUDED.account_ids, updated_at = now()
  `;
  return true;
}
```

- [ ] **Step 3: Copiar `lib/meta-client.ts` literal**

```bash
cp $DRT/lib/meta-client.ts lib/meta-client.ts
diff $DRT/lib/meta-client.ts lib/meta-client.ts   # vacío
```

Importa `MetaAccountInfo` del store (mismo nombre) y `GRAPH_VERSION` de `meta-oauth`: ambos existen ya.

- [ ] **Step 4: Escribir `scripts/verify-meta-connection-store.ts`**

```ts
// Verificación de lib/meta-connection-store.ts. Correr: pnpm verify:meta-connection-store
//
// La conexión es UNA por despliegue, así que el roundtrip contra la base real
// NO puede tocar la fila 'ads' de producción: usa un producto sintético
// ("__verify_ads") que ningún código de la app pide, y lo borra al terminar.
// Las asignaciones por proyecto usan ids "__verify_*" (ID_RE prohíbe guiones
// bajos, así que no chocan con el roster). Sin DATABASE_URL solo corre la parte
// pura y lo dice.
//
// Envuelto en main() en vez de usar await de nivel superior: este paquete es CJS.
import assert from "node:assert/strict";

if (!process.env.DASHBOARD_AUTH_SECRET) {
  process.env.DASHBOARD_AUTH_SECRET = "test-secret-do-not-use-in-prod";
}

import { isDbConfigured, getSql } from "../lib/db";
import {
  readMetaConnection,
  readMetaConnectionWithToken,
  writeMetaConnection,
  deleteMetaConnection,
  readProjectAccounts,
  writeProjectAccounts,
} from "../lib/meta-connection-store";
import type { MetaProduct } from "../lib/meta-oauth";
import type { ClientConfig } from "../lib/clients";

// Producto sintético: el store no valida el string, la tabla tampoco.
const P = "__verify_ads" as MetaProduct;
const A: ClientConfig = { id: "__verify_meta_a", name: "A", locationId: "loc-a", ghlToken: "pit-a" };
const B: ClientConfig = { id: "__verify_meta_b", name: "B", locationId: "loc-b", ghlToken: "pit-b" };

const accounts = [
  { id: "act_1", name: "Condesa", currency: "MXN", timezone: "America/Mexico_City", status: 1 },
  { id: "act_2", name: "Plaza Bosques", currency: "MXN", timezone: "America/Mexico_City", status: 1 },
];

async function cleanup() {
  const sql = getSql();
  await sql`DELETE FROM meta_connection WHERE product = ${P}`;
  await sql`DELETE FROM meta_project_accounts WHERE project_id IN (${A.id}, ${B.id})`;
}

async function main() {
  if (!isDbConfigured()) {
    console.log("⚠️  Sin DATABASE_URL: se omite el roundtrip contra Postgres.");
    assert.equal(await readMetaConnection(P), null);
    assert.deepEqual(await readProjectAccounts(A, P), []);
    assert.equal(await writeProjectAccounts(A, P, ["act_1"]), false);
    await deleteMetaConnection(P);
    console.log("✅ verify:meta-connection-store OK (solo parte pura)");
    return;
  }

  await cleanup();
  const sql = getSql();

  // --- vacío
  assert.equal(await readMetaConnection(P), null);
  assert.deepEqual(await readProjectAccounts(A, P), []);
  assert.equal(await writeProjectAccounts(A, P, ["act_1"]), false, "sin conexión no hay contra qué validar");

  // --- escribir y leer sin token
  await writeMetaConnection(P, {
    token: "EAAB-secreto-a",
    tokenKind: "system_user",
    tokenExpiresAt: null,
    businessId: "biz-lezgo",
    connectedBy: "Admin Lezgo",
    availableAccounts: accounts,
  });
  const c = await readMetaConnection(P);
  assert.ok(c);
  assert.equal(c.tokenKind, "system_user");
  assert.equal(c.tokenExpiresAt, null);
  assert.equal(c.businessId, "biz-lezgo");
  assert.equal(c.connectedBy, "Admin Lezgo");
  assert.deepEqual(c.availableAccounts, accounts);
  assert.equal("token" in c, false, "la lectura normal NO trae el token");

  // --- el token se cifra en reposo
  const raw = await sql`SELECT token_encrypted FROM meta_connection WHERE product = ${P}`;
  assert.ok(!Buffer.from(raw[0].token_encrypted).toString("utf8").includes("EAAB-secreto-a"));

  // --- y se descifra al pedirlo explícitamente
  assert.equal((await readMetaConnectionWithToken(P))?.token, "EAAB-secreto-a");

  // --- secreto rotado: la fila sigue, el token no descifra → token: null, NO null entero
  const secret = process.env.DASHBOARD_AUTH_SECRET;
  process.env.DASHBOARD_AUTH_SECRET = "otro-secreto";
  const rotated = await readMetaConnectionWithToken(P);
  assert.ok(rotated, "la fila se sigue leyendo");
  assert.equal(rotated.token, null, "el token no descifra con otro secreto");
  process.env.DASHBOARD_AUTH_SECRET = secret;

  // --- otro producto no ve esta fila
  assert.equal(await readMetaConnection("whatsapp"), null);

  // --- asignación por proyecto: solo ids disponibles; vacío es válido
  assert.equal(await writeProjectAccounts(A, P, ["act_2"]), true);
  assert.deepEqual(await readProjectAccounts(A, P), ["act_2"]);
  assert.equal(await writeProjectAccounts(A, P, ["act_2", "act_999"]), false);
  assert.deepEqual(await readProjectAccounts(A, P), ["act_2"], "un id inválido no cambia nada");
  assert.equal(await writeProjectAccounts(A, P, ["act_1", "act_1"]), true);
  assert.deepEqual(await readProjectAccounts(A, P), ["act_1"], "se deduplica");
  assert.equal(await writeProjectAccounts(A, P, []), true, "vacío = quitarle Meta al proyecto");
  assert.deepEqual(await readProjectAccounts(A, P), []);

  // --- AISLAMIENTO: escribir B no toca A; una cuenta puede estar en dos proyectos
  await writeProjectAccounts(A, P, ["act_1"]);
  await writeProjectAccounts(B, P, ["act_1", "act_2"]);
  assert.deepEqual(await readProjectAccounts(A, P), ["act_1"]);
  assert.deepEqual(await readProjectAccounts(B, P), ["act_1", "act_2"]);

  // --- reconectar sobrescribe la conexión y CONSERVA las asignaciones
  await writeMetaConnection(P, {
    token: "EAAB-secreto-2",
    tokenKind: "user",
    tokenExpiresAt: "2026-11-12T00:00:00.000Z",
    businessId: null,
    connectedBy: null,
    availableAccounts: [accounts[0]],
  });
  const c2 = await readMetaConnectionWithToken(P);
  assert.equal(c2?.token, "EAAB-secreto-2");
  assert.equal(c2?.tokenKind, "user");
  assert.equal(c2?.tokenExpiresAt, "2026-11-12T00:00:00.000Z");
  assert.equal(c2?.connectedAt, c.connectedAt, "connected_at se conserva al reconectar");
  assert.deepEqual(await readProjectAccounts(B, P), ["act_1", "act_2"], "las asignaciones sobreviven");

  // --- borrar la conexión NO borra asignaciones
  await deleteMetaConnection(P);
  assert.equal(await readMetaConnection(P), null);
  assert.deepEqual(await readProjectAccounts(B, P), ["act_1", "act_2"]);

  await cleanup();
  console.log("✅ verify:meta-connection-store OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 5: Script en `package.json`**

```json
    "verify:meta-connection-store": "tsx --env-file-if-exists=.env.local scripts/verify-meta-connection-store.ts",
```

- [ ] **Step 6: Migrar y verificar**

```bash
pnpm db:migrate                     # ✅ project_sync / meta_connection / meta_project_accounts listas
pnpm verify:meta-connection-store   # ✅ verify:meta-connection-store OK
npx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add scripts/db-migrate.ts lib/meta-connection-store.ts lib/meta-client.ts scripts/verify-meta-connection-store.ts package.json
git commit -m "feat(meta): tablas meta_connection (una por despliegue) y meta_project_accounts, su store y el cliente Graph"
```

---

### Task 3: `lib/meta-attribution.ts` — el cruce (puro)

**Files:**
- Create: `lib/meta-attribution.ts`
- Create: `scripts/verify-meta-attribution.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: `isDePauta(opp, pautaContacts: HasKey)` (`lib/pauta.ts`), `isWonOpp(opp)` (`lib/opportunity-status.ts`), tipos Meta (Task 1).
- Produces: `PANEL_TIME_ZONE`, `oppAdId(opp)`, `buildMetaIndex(meta) → MetaIndex`, `classifyLead(opp, ctx) → LeadAttribution`, `localDay(iso, tz?)`, `buildCostSummary(input) → CostSummary`, `buildCampaignPerformance(input) → CampaignPerformanceRow[]`, `type DayRange = { since: string; until: string } | null`.

- [ ] **Step 1: Escribir el verify (falla porque el módulo no existe)**

```ts
// Verificación de lib/meta-attribution.ts. Correr: pnpm verify:meta-attribution
//
// Un error aquí es un número equivocado en pantalla: un CPL calculado sobre
// leads que no eran de ese anuncio, o un gasto que se cuenta dos veces. Por eso
// las aserciones fijan la llave (ad id), la cohorte por día LOCAL y las
// divisiones sin denominador.
//
// Envuelto en main() en vez de usar await de nivel superior: este paquete es CJS.
import assert from "node:assert/strict";
import type { MetaAdsData, Opportunity } from "../lib/types";
import {
  oppAdId,
  buildMetaIndex,
  classifyLead,
  localDay,
  buildCostSummary,
  buildCampaignPerformance,
} from "../lib/meta-attribution";

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
    ...over,
  } as Opportunity;
}

const meta: MetaAdsData = {
  accounts: [
    { id: "act_1", name: "Condesa", currency: "MXN", timezone: "America/Mexico_City" },
    { id: "act_2", name: "USD", currency: "USD", timezone: "America/Mexico_City" },
  ],
  campaigns: [
    { id: "camp-a", name: "IW - CC - FF - Demografía", accountId: "act_1" },
    { id: "camp-b", name: "IW - CC - FF - Buyer", accountId: "act_1" },
    { id: "camp-usd", name: "Test USD", accountId: "act_2" },
  ],
  adsets: [
    { id: "set-a", name: "Set A", campaignId: "camp-a" },
    { id: "set-b", name: "Set B", campaignId: "camp-b" },
    { id: "set-usd", name: "Set USD", campaignId: "camp-usd" },
  ],
  ads: [
    { id: "120001", name: "AD 01", adsetId: "set-a" },
    { id: "120002", name: "AD 02", adsetId: "set-a" },
    { id: "120003", name: "AD 03", adsetId: "set-b" },
    { id: "120009", name: "AD USD", adsetId: "set-usd" },
  ],
  daily: [
    { adId: "120001", date: "2026-08-10", spend: 100, impressions: 1000, reach: 900, clicks: 50, linkClicks: 40, leadsForm: 4, leadsMsg: 0 },
    { adId: "120002", date: "2026-08-11", spend: 50, impressions: 500, reach: 450, clicks: 10, linkClicks: 8, leadsForm: 0, leadsMsg: 2 },
    { adId: "120003", date: "2026-08-20", spend: 300, impressions: 3000, reach: 2000, clicks: 90, linkClicks: 80, leadsForm: 0, leadsMsg: 0 },
    { adId: "120001", date: "2026-09-01", spend: 999, impressions: 1, reach: 1, clicks: 0, linkClicks: 0, leadsForm: 0, leadsMsg: 0 },
    { adId: "120009", date: "2026-08-12", spend: 10, impressions: 100, reach: 90, clicks: 1, linkClicks: 1, leadsForm: 0, leadsMsg: 0 },
  ],
  window: { since: "2026-08-01", until: "2026-09-14" },
  failedAccounts: [],
};

async function main() {
  // --- oppAdId: nativo manda; custom field es fallback; se normaliza a dígitos
  assert.equal(oppAdId(opp({ id: "1", adId: "120001" })), "120001");
  assert.equal(oppAdId(opp({ id: "2", adId: " 120001 " })), "120001");
  assert.equal(oppAdId(opp({ id: "3", customFieldsResolved: { "ID de Pauta": "120002" } })), "120002");
  assert.equal(oppAdId(opp({ id: "4", customFieldsResolved: { "ID Pauta": "120002" } })), "120002");
  assert.equal(oppAdId(opp({ id: "5", adId: "120001", customFieldsResolved: { "ID Pauta": "120002" } })), "120001", "la attribution nativa manda");
  assert.equal(oppAdId(opp({ id: "6", customFieldsResolved: { "URL Pauta": "https://fb.me/x" } })), null, "URL Pauta no es ad id");
  assert.equal(oppAdId(opp({ id: "7", adId: "" })), null);
  assert.equal(oppAdId(opp({ id: "8", adId: "abc" })), null, "sin dígitos no hay id");

  // --- índice
  const index = buildMetaIndex(meta);
  assert.equal(index.byAd.get("120001")?.campaign?.id, "camp-a");
  assert.equal(index.byAd.get("120001")?.account?.currency, "MXN");
  assert.equal(index.byAd.get("120003")?.adset?.id, "set-b");
  assert.equal(index.dailyByAd.get("120001")?.length, 2);
  assert.equal(index.byAd.has("999"), false);

  // --- classifyLead: cuatro niveles; csv_import gana incluso con ad id
  const pautaContacts = new Set(["c-p"]);
  const ctx = { index, pautaContacts };
  assert.equal(classifyLead(opp({ id: "e", adId: "120001" }), ctx), "exact");
  assert.equal(classifyLead(opp({ id: "u", adId: "777777", source: "facebook" }), ctx), "unknownAd");
  assert.equal(classifyLead(opp({ id: "p", contactId: "c-p" }), ctx), "noAdId", "de pauta por el objeto Pauta, sin id");
  assert.equal(classifyLead(opp({ id: "n", source: "referido" }), ctx), "notPauta");
  assert.equal(
    classifyLead(opp({ id: "csv", adId: "120001", attributions: [{ medium: "csv_import" }] }), ctx),
    "notPauta",
    "importado por CSV nunca entra al costo"
  );

  // --- localDay: 23:36 del 6 en UTC-6 es el 7 en UTC; el día local manda
  assert.equal(localDay("2026-08-07T05:36:00.000Z"), "2026-08-06");
  assert.equal(localDay("2026-08-07T06:00:00.000Z"), "2026-08-07");

  // --- buildCostSummary sobre agosto
  const range = { since: "2026-08-01", until: "2026-08-31" };
  const opps = [
    opp({ id: "a1", adId: "120001", createdAt: "2026-08-10T16:00:00.000Z", status: "won" }),
    opp({ id: "a2", adId: "120001", createdAt: "2026-08-10T17:00:00.000Z" }),
    opp({ id: "a3", adId: "120002", createdAt: "2026-08-11T17:00:00.000Z", stage: "Negocio Ganado" }),
    opp({ id: "a4", adId: "120003", createdAt: "2026-09-01T05:59:00.000Z" }), // 31 ago 23:59 local → dentro
    opp({ id: "sep", adId: "120001", createdAt: "2026-09-01T06:01:00.000Z" }), // 1 sep local → fuera
    opp({ id: "unk", adId: "555555", source: "facebook", createdAt: "2026-08-15T12:00:00.000Z" }),
    opp({ id: "noid", contactId: "c-p", createdAt: "2026-08-15T12:00:00.000Z" }),
    opp({ id: "org", source: "referido", createdAt: "2026-08-15T12:00:00.000Z" }),
  ];
  const s = buildCostSummary({ opportunities: opps, meta, index, range, pautaContacts });
  assert.equal(s.mixedCurrency, true, "act_2 es USD");
  assert.deepEqual(s.spendByCurrency, { MXN: 450, USD: 10 });
  assert.equal(s.spend, null, "con moneda mixta no hay total consolidado");
  assert.equal(s.cpl, null);
  assert.equal(s.leadsMeta, 6);
  assert.equal(s.leadsCrm, 4, "a1 a2 a3 a4; sep queda fuera por día local");
  assert.equal(s.won, 2, "status won + etapa Negocio Ganado (isWonOpp)");
  assert.equal(s.unknownAdLeads, 1);
  assert.equal(s.noAdIdLeads, 1);

  // --- solo MXN: costos consolidados
  const mxn: MetaAdsData = { ...meta, daily: meta.daily.filter((d) => d.adId !== "120009") };
  const s2 = buildCostSummary({ opportunities: opps, meta: mxn, index: buildMetaIndex(mxn), range, pautaContacts });
  assert.equal(s2.mixedCurrency, false);
  assert.equal(s2.currency, "MXN");
  assert.equal(s2.spend, 450);
  assert.equal(s2.cpl, 112.5);
  assert.equal(s2.cpa, 225);

  // --- sin leads en la ventana → null, nunca 0 ni Infinity
  const s3 = buildCostSummary({ opportunities: [], meta: mxn, index: buildMetaIndex(mxn), range, pautaContacts });
  assert.equal(s3.spend, 450);
  assert.equal(s3.leadsCrm, 0);
  assert.equal(s3.cpl, null);
  assert.equal(s3.cpa, null);

  // --- range null = todo
  const s4 = buildCostSummary({ opportunities: opps, meta: mxn, index: buildMetaIndex(mxn), range: null, pautaContacts });
  assert.equal(s4.spend, 1449);
  assert.equal(s4.leadsCrm, 5);

  // --- por campaña
  const rows = buildCampaignPerformance({ opportunities: opps, meta: mxn, index: buildMetaIndex(mxn), range, pautaContacts });
  const a = rows.find((r) => r.campaignId === "camp-a")!;
  const b = rows.find((r) => r.campaignId === "camp-b")!;
  assert.equal(a.spend, 150);
  assert.equal(a.impressions, 1500);
  assert.equal(a.clicks, 60);
  assert.equal(a.cpm, 100);
  assert.equal(a.ctr, 0.04);
  assert.equal(a.leadsMeta, 6);
  assert.equal(a.leadsCrm, 3);
  assert.equal(a.won, 2);
  assert.equal(a.cpl, 50);
  assert.equal(a.cpa, 75);
  assert.equal(b.spend, 300);
  assert.equal(b.leadsCrm, 1);
  assert.equal(b.won, 0);
  assert.equal(b.cpa, null);
  assert.ok(rows.findIndex((r) => r.campaignId === "camp-b") < rows.findIndex((r) => r.campaignId === "camp-a"), "ordenado por gasto desc");
  assert.equal(rows.some((r) => r.campaignId === "camp-usd"), false, "sin filas en la ventana no aparece");

  console.log("✅ verify:meta-attribution OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

Y en `package.json`:

```json
    "verify:meta-attribution": "tsx scripts/verify-meta-attribution.ts",
```

- [ ] **Step 2: Correr para verlo fallar**

```bash
pnpm verify:meta-attribution
```

Esperado: `Cannot find module '../lib/meta-attribution'`.

- [ ] **Step 3: Escribir `lib/meta-attribution.ts`**

```ts
// lib/meta-attribution.ts
// El cruce entre el gasto de Meta y las oportunidades del CRM. Puro: sin React,
// sin Next, sin base. Lo usan el sync (oppAdId, PANEL_TIME_ZONE) y la entrega
// ② en el panel (índice, cohorte, costo por campaña).
//
// La llave es el AD ID. Nunca se cruza por nombre: campaignName cubre menos que
// adId en los seis proyectos y el objeto Pauta de este despliegue no trae nombre
// de anuncio. Lo que no tiene id se cuenta aparte — es un hallazgo, no residuo.
//
// Lo que NO hace: no reparte gasto entre proyectos, no convierte moneda, no
// toca lib/pauta.ts. isDePauta sigue siendo "es de pauta"; esto es "cuánto costó".
import type {
  MetaAccount,
  MetaAd,
  MetaAdsData,
  MetaAdset,
  MetaCampaign,
  MetaDailyRow,
  Opportunity,
} from "./types";
import { isDePauta, type HasKey } from "./pauta";
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

// La attribution nativa manda: es lo que GHL recibió del click; el custom field
// es una copia que escribe Make y a veces difiere.
export function oppAdId(opp: Opportunity): string | null {
  const own = normalizeAdId(opp.adId);
  if (own) return own;
  const cf = opp.customFieldsResolved;
  if (!cf) return null;
  for (const [name, val] of Object.entries(cf)) {
    if (!AD_ID_FIELD.test(name.trim())) continue;
    const id = normalizeAdId(Array.isArray(val) ? val[0] : val);
    if (id) return id;
  }
  return null;
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

// ── Clasificación ───────────────────────────────────────────────────────────

/**
 * exact     — tiene ad id y ese ad está en el dataset de Meta. Entra al costo.
 * unknownAd — tiene ad id pero Meta no lo trajo: cuenta no asignada, de otra
 *             empresa, o ad borrado. La señal para "Asignar cuenta".
 * noAdId    — es de pauta (isDePauta) pero no trae id. Hueco de captura.
 * notPauta  — orgánico, referido, o importado por CSV (gana incluso con ad id).
 */
export type LeadAttribution = "exact" | "unknownAd" | "noAdId" | "notPauta";

export interface AttributionContext {
  index: MetaIndex;
  pautaContacts: HasKey;
}

function isCsvImport(opp: Opportunity): boolean {
  return (opp.attributions ?? []).some((a) => a.medium === "csv_import");
}

export function classifyLead(opp: Opportunity, ctx: AttributionContext): LeadAttribution {
  if (isCsvImport(opp)) return "notPauta";
  const id = oppAdId(opp);
  if (id && ctx.index.byAd.has(id)) return "exact";
  if (!isDePauta(opp, ctx.pautaContacts)) return "notPauta";
  return id ? "unknownAd" : "noAdId";
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
  /** Historial completo o ya recortado: el rango se aplica aquí de todos modos. */
  opportunities: Opportunity[];
  meta: MetaAdsData;
  index: MetaIndex;
  range: DayRange;
  pautaContacts: HasKey;
}

export interface CostSummary {
  /** Total consolidado; null si las cuentas mezclan monedas. */
  spend: number | null;
  currency: string | null;
  spendByCurrency: Record<string, number>;
  mixedCurrency: boolean;
  /** Σ leadsForm + leadsMsg de los días en la ventana. */
  leadsMeta: number;
  /** Oportunidades creadas en la ventana (día local) con ad en el dataset. */
  leadsCrm: number;
  /** De esas, las ganadas por isWonOpp (status o etapa). */
  won: number;
  cpl: number | null;
  cpa: number | null;
  unknownAdLeads: number;
  noAdIdLeads: number;
}

function currencyOf(index: MetaIndex, adId: string): string {
  return index.byAd.get(adId)?.account?.currency ?? "?";
}

// Cohorte de creación: el gasto de la ventana contra los leads que ESA ventana
// creó. Sin denominador → null; nunca $0 ni ∞.
export function buildCostSummary(p: CostInput): CostSummary {
  const spendByCurrency: Record<string, number> = {};
  let leadsMeta = 0;
  for (const row of p.meta.daily) {
    if (!inRange(row.date, p.range)) continue;
    const cur = currencyOf(p.index, row.adId);
    spendByCurrency[cur] = (spendByCurrency[cur] ?? 0) + row.spend;
    leadsMeta += row.leadsForm + row.leadsMsg;
  }
  const currencies = Object.keys(spendByCurrency);
  const mixedCurrency = currencies.length > 1;
  const currency = currencies.length === 1 ? currencies[0] : null;
  const spend = mixedCurrency ? null : (spendByCurrency[currency ?? ""] ?? 0);

  let leadsCrm = 0;
  let won = 0;
  let unknownAdLeads = 0;
  let noAdIdLeads = 0;
  const ctx = { index: p.index, pautaContacts: p.pautaContacts };
  for (const opp of p.opportunities) {
    if (!inRange(localDay(opp.createdAt), p.range)) continue;
    const kind = classifyLead(opp, ctx);
    if (kind === "exact") {
      leadsCrm += 1;
      if (isWonOpp(opp)) won += 1;
    } else if (kind === "unknownAd") unknownAdLeads += 1;
    else if (kind === "noAdId") noAdIdLeads += 1;
  }

  return {
    spend,
    currency,
    spendByCurrency,
    mixedCurrency,
    leadsMeta,
    leadsCrm,
    won,
    cpl: spend === null ? null : ratio(spend, leadsCrm),
    cpa: spend === null ? null : ratio(spend, won),
    unknownAdLeads,
    noAdIdLeads,
  };
}

// ── Por campaña ─────────────────────────────────────────────────────────────

export interface CampaignPerformanceRow {
  campaignId: string;
  name: string;
  accountId: string;
  currency: string;
  spend: number;
  impressions: number;
  clicks: number;
  /** Gasto por mil impresiones; null sin impresiones. */
  cpm: number | null;
  /** clicks / impressions; null sin impresiones. */
  ctr: number | null;
  leadsMeta: number;
  leadsCrm: number;
  won: number;
  cpl: number | null;
  cpa: number | null;
}

// Filas por campaña de META (su jerarquía, no el UTM), ordenadas por gasto
// desc. Solo campañas con actividad o leads en la ventana. Cada fila va en la
// moneda de su cuenta: no se consolida entre campañas aquí.
export function buildCampaignPerformance(p: CostInput): CampaignPerformanceRow[] {
  const rows = new Map<string, CampaignPerformanceRow>();
  const rowFor = (campaign: MetaCampaign, account?: MetaAccount): CampaignPerformanceRow => {
    let r = rows.get(campaign.id);
    if (!r) {
      r = {
        campaignId: campaign.id,
        name: campaign.name,
        accountId: campaign.accountId,
        currency: account?.currency ?? "?",
        spend: 0,
        impressions: 0,
        clicks: 0,
        cpm: null,
        ctr: null,
        leadsMeta: 0,
        leadsCrm: 0,
        won: 0,
        cpl: null,
        cpa: null,
      };
      rows.set(campaign.id, r);
    }
    return r;
  };

  for (const row of p.meta.daily) {
    if (!inRange(row.date, p.range)) continue;
    const hit = p.index.byAd.get(row.adId);
    if (!hit?.campaign) continue;
    const r = rowFor(hit.campaign, hit.account);
    r.spend += row.spend;
    r.impressions += row.impressions;
    r.clicks += row.clicks;
    r.leadsMeta += row.leadsForm + row.leadsMsg;
  }

  const ctx = { index: p.index, pautaContacts: p.pautaContacts };
  for (const opp of p.opportunities) {
    if (!inRange(localDay(opp.createdAt), p.range)) continue;
    if (classifyLead(opp, ctx) !== "exact") continue;
    const hit = p.index.byAd.get(oppAdId(opp)!);
    if (!hit?.campaign) continue;
    const r = rowFor(hit.campaign, hit.account);
    r.leadsCrm += 1;
    if (isWonOpp(opp)) r.won += 1;
  }

  const out = Array.from(rows.values());
  for (const r of out) {
    r.cpm = r.impressions > 0 ? (r.spend / r.impressions) * 1000 : null;
    r.ctr = ratio(r.clicks, r.impressions);
    r.cpl = ratio(r.spend, r.leadsCrm);
    r.cpa = ratio(r.spend, r.won);
  }
  out.sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name));
  return out;
}
```

- [ ] **Step 4: Correr el verify y tsc**

```bash
pnpm verify:meta-attribution   # ✅ verify:meta-attribution OK
npx tsc --noEmit
```

Si `opp.attributions[].medium` no tipa (`{ [key: string]: unknown }`), `a.medium === "csv_import"` compila igual porque `unknown === string` es válido en TS.

- [ ] **Step 5: Commit**

```bash
git add lib/meta-attribution.ts scripts/verify-meta-attribution.ts package.json
git commit -m "feat(meta): cruce por ad id — índice, clasificación de leads, cohorte por día local y costo por campaña"
```

---

### Task 4: rutas `app/api/meta/*` — OAuth con compuerta del alcance `all`

**Files:**
- Create: `app/api/meta/connect/route.ts`
- Create: `app/api/meta/callback/route.ts`
- Create: `app/api/meta/connection/route.ts`
- Create: `app/api/meta/accounts/route.ts`
- Create: `lib/meta-admin.ts` (la compuerta, para no repetirla en cuatro rutas)

**Interfaces:**
- Consumes: `currentScope()`, `requireClient()`, `unauthorized()` (`lib/session.ts`); `safeEqual` (`lib/auth.ts`); Task 1 y Task 2.
- Produces: `GET /api/meta/connect` (302 al diálogo | 403 | 409 preview | 503), `GET /api/meta/callback` (302 a `/?meta=connected` | `/?meta=error&reason=…`), `GET /api/meta/connection` → `ConnectionStatus`, `DELETE /api/meta/connection` (204), `POST /api/meta/accounts { ids }` (204 | 400 | 403 | 503). `requireMetaAdmin(): Promise<AccessScope | null>`.

- [ ] **Step 1: La compuerta — `lib/meta-admin.ts`**

```ts
// lib/meta-admin.ts
// Quién puede tocar la conexión con Meta: SOLO una sesión del alcance `all`.
// Los alcances de agencia (domus, iw) ven el gasto de sus proyectos, pero no
// conectan, reconectan, desconectan ni asignan cuentas — la conexión es del
// despliegue entero, y reconectar con otra empresa la sobrescribe para todos.
import { currentScope } from "./session";
import type { AccessScope } from "./scopes";

export const META_ADMIN_SCOPE = "all";

export async function requireMetaAdmin(): Promise<AccessScope | null> {
  const scope = await currentScope();
  if (!scope || scope.id !== META_ADMIN_SCOPE) return null;
  return scope;
}

export function forbidden(): Response {
  return Response.json({ error: "forbidden" }, { status: 403 });
}

export function metaConfigured(): boolean {
  return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_LOGIN_CONFIG_ID);
}
```

Confirmar que `lib/scopes.ts` exporta `AccessScope` con `id: string` (`grep -n "export interface AccessScope" lib/scopes.ts`).

- [ ] **Step 2: `app/api/meta/connect/route.ts`**

```ts
// app/api/meta/connect/route.ts
// Arranca el OAuth con Meta: firma un state con el alcance y redirige al diálogo
// de Facebook Login for Business. Solo el alcance `all`: la conexión es del
// despliegue, no de un proyecto.
import { requireMetaAdmin, forbidden, metaConfigured } from "@/lib/meta-admin";
import { isDbConfigured } from "@/lib/db";
import {
  buildDialogUrl,
  redirectUriFor,
  signState,
  verifyState,
  OAUTH_COOKIE,
  STATE_MAX_AGE_MS,
} from "@/lib/meta-oauth";

export const runtime = "nodejs";

export async function GET(req: Request) {
  const scope = await requireMetaAdmin();
  if (!scope) return forbidden();

  // Un preview de Vercel tiene URL aleatoria y no se puede registrar en la app.
  if (process.env.VERCEL_ENV === "preview") {
    return Response.json({ error: "preview" }, { status: 409 });
  }
  if (!metaConfigured()) {
    return Response.json({ error: "not_configured" }, { status: 503 });
  }
  // Sin base no hay dónde guardar el token; mejor decirlo antes de mandar a
  // nadie al diálogo.
  if (!isDbConfigured()) {
    return Response.json({ error: "no_db" }, { status: 503 });
  }

  const state = await signState({ scopeId: scope.id, product: "ads", returnTo: "/" });
  const url = buildDialogUrl({
    appId: process.env.META_APP_ID!,
    configId: process.env.META_LOGIN_CONFIG_ID!,
    redirectUri: redirectUriFor(req.url, process.env.META_PUBLIC_ORIGIN),
    state,
  });
  // La cookie ata el callback a ESTE navegador: el callback exige que el nonce
  // del state coincida con ella. Sin esto, un state válido en manos ajenas
  // bastaría para conectar el panel a una cuenta de Meta que no es de Lezgo.
  const nonce = (await verifyState(state))!.nonce;
  const secure = new URL(req.url).protocol === "https:";
  return new Response(null, {
    status: 302,
    headers: {
      Location: url,
      "Set-Cookie": `${OAUTH_COOKIE}=${nonce}; Path=/api/meta/callback; HttpOnly; SameSite=Lax; Max-Age=${STATE_MAX_AGE_MS / 1000}${secure ? "; Secure" : ""}`,
    },
  });
}
```

- [ ] **Step 3: `app/api/meta/callback/route.ts`**

```ts
// app/api/meta/callback/route.ts
// El regreso del diálogo de Meta. Verifica el state, canjea el code, averigua qué
// clase de token es, lista las cuentas concedidas y guarda LA fila del
// despliegue. Cualquier falla regresa al panel con ?meta=error&reason=… y NO
// deja nada guardado.
import { cookies } from "next/headers";
import { requireMetaAdmin, forbidden } from "@/lib/meta-admin";
import { verifyState, redirectUriFor, OAUTH_COOKIE } from "@/lib/meta-oauth";
import { safeEqual } from "@/lib/auth";
import { exchangeCode, debugToken, fetchMe, listAdAccounts, MetaApiError } from "@/lib/meta-client";
import { writeMetaConnection } from "@/lib/meta-connection-store";

export const runtime = "nodejs";

type Reason = "state_invalid" | "denied" | "token_exchange" | "token_invalid" | "no_accounts" | "db";

// Siempre a "/", nunca a algo que venga en la petición: sin open redirect. Con
// dash_project puesta, "/" es el panel; sin ella, el picker. La cookie del nonce
// se borra en todos los caminos — es de un solo uso.
function back(req: Request, params: Record<string, string>): Response {
  const url = new URL("/", req.url);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return new Response(null, {
    status: 302,
    headers: {
      Location: url.toString(),
      "Set-Cookie": `${OAUTH_COOKIE}=; Path=/api/meta/callback; HttpOnly; SameSite=Lax; Max-Age=0`,
    },
  });
}

export async function GET(req: Request) {
  const scope = await requireMetaAdmin();
  if (!scope) return forbidden();

  const q = new URL(req.url).searchParams;
  const fail = (reason: Reason) => back(req, { meta: "error", reason });

  const state = await verifyState(q.get("state"));
  // El state tiene que ser del alcance logueado (y ese alcance, `all`): un
  // state ajeno, aunque esté bien firmado, no guarda nada.
  if (!state || state.scopeId !== scope.id || state.product !== "ads") return fail("state_invalid");
  // …y del navegador que empezó el flujo: el nonce de la cookie que dejó
  // /connect tiene que ser el mismo del state.
  const nonceCookie = (await cookies()).get(OAUTH_COOKIE)?.value ?? "";
  if (!nonceCookie || !safeEqual(nonceCookie, state.nonce)) return fail("state_invalid");

  if (q.get("error") || !q.get("code")) return fail("denied");

  let token: string;
  try {
    token = (
      await exchangeCode({
        code: q.get("code")!,
        redirectUri: redirectUriFor(req.url, process.env.META_PUBLIC_ORIGIN),
      })
    ).accessToken;
  } catch (err) {
    console.error("[meta] canje del code falló:", err instanceof Error ? err.message : String(err));
    return fail("token_exchange");
  }

  try {
    const info = await debugToken(token);
    if (!info.isValid) return fail("token_invalid");
    const [me, accounts] = await Promise.all([fetchMe(token), listAdAccounts(token)]);
    if (accounts.length === 0) return fail("no_accounts");

    await writeMetaConnection("ads", {
      token,
      tokenKind: info.type === "SYSTEM_USER" || info.expiresAt === null ? "system_user" : "user",
      tokenExpiresAt: info.expiresAt,
      businessId: null,
      connectedBy: me.name || null,
      availableAccounts: accounts,
    });
  } catch (err) {
    console.error("[meta] no se pudo completar la conexión:", err instanceof Error ? err.message : String(err));
    if (err instanceof MetaApiError) return fail(err.isTokenInvalid ? "token_invalid" : "token_exchange");
    return fail("db");
  }

  return back(req, { meta: "connected" });
}
```

- [ ] **Step 4: `app/api/meta/connection/route.ts`**

```ts
// app/api/meta/connection/route.ts
// Estado de la conexión para la píldora del header. Cualquier sesión con
// proyecto abierto lo lee (la píldora se dibuja para todos); `canManage` dice si
// además puede tocarla. Nunca devuelve el token.
import { requireClient, unauthorized } from "@/lib/session";
import { requireMetaAdmin, forbidden, metaConfigured } from "@/lib/meta-admin";
import { isDbConfigured } from "@/lib/db";
import {
  readMetaConnection,
  readProjectAccounts,
  deleteMetaConnection,
} from "@/lib/meta-connection-store";

export const runtime = "nodejs";

export async function GET() {
  const client = await requireClient();
  if (!client) return unauthorized();
  const canManage = (await requireMetaAdmin()) !== null;

  if (!metaConfigured()) return Response.json({ connected: false, canManage, reason: "not_configured" });
  if (!isDbConfigured()) return Response.json({ connected: false, canManage, reason: "no_db" });

  let conn;
  let selected: string[];
  try {
    [conn, selected] = await Promise.all([readMetaConnection("ads"), readProjectAccounts(client, "ads")]);
  } catch (err) {
    console.error("[meta] no se pudo leer la conexión:", err);
    return Response.json({ connected: false, canManage, reason: "no_db" });
  }
  if (!conn) {
    return Response.json({
      connected: false,
      canManage,
      reason: process.env.VERCEL_ENV === "preview" ? "preview" : undefined,
    });
  }
  const sel = new Set(selected);
  return Response.json({
    connected: true,
    canManage,
    connectedBy: conn.connectedBy,
    connectedAt: conn.connectedAt,
    tokenKind: conn.tokenKind,
    tokenExpiresAt: conn.tokenExpiresAt,
    accounts: conn.availableAccounts.map((a) => ({ ...a, selected: sel.has(a.id) })),
  });
}

export async function DELETE() {
  if (!(await requireMetaAdmin())) return forbidden();
  try {
    await deleteMetaConnection("ads");
  } catch (err) {
    console.error("[meta] no se pudo desconectar:", err);
    return Response.json({ error: "db" }, { status: 503 });
  }
  return new Response(null, { status: 204 });
}
```

- [ ] **Step 5: `app/api/meta/accounts/route.ts`**

```ts
// app/api/meta/accounts/route.ts
// Qué cuentas de las concedidas mira EL PROYECTO DE LA SESIÓN. Solo el alcance
// `all`. La validación real (que cada id esté en available_accounts) vive en el
// store, no aquí. Una lista vacía es válida: quita Meta a este proyecto.
import { requireClient, unauthorized } from "@/lib/session";
import { requireMetaAdmin, forbidden } from "@/lib/meta-admin";
import { writeProjectAccounts } from "@/lib/meta-connection-store";

export const runtime = "nodejs";

export async function POST(req: Request) {
  if (!(await requireMetaAdmin())) return forbidden();
  const client = await requireClient();
  if (!client) return unauthorized();

  let ids: unknown;
  try {
    ids = (await req.json())?.ids;
  } catch {
    return Response.json({ error: "invalid_selection" }, { status: 400 });
  }
  if (!Array.isArray(ids) || !ids.every((x) => typeof x === "string")) {
    return Response.json({ error: "invalid_selection" }, { status: 400 });
  }
  let ok: boolean;
  try {
    ok = await writeProjectAccounts(client, "ads", ids as string[]);
  } catch (err) {
    console.error("[meta] no se pudo guardar la asignación:", err);
    return Response.json({ error: "db" }, { status: 503 });
  }
  if (!ok) return Response.json({ error: "invalid_selection" }, { status: 400 });
  return new Response(null, { status: 204 });
}
```

- [ ] **Step 6: tsc y prueba manual de la compuerta**

```bash
npx tsc --noEmit
pnpm dev
```

En otra terminal, con el navegador logueado con la contraseña de **`iw`** y Condesa abierta, copiar las cookies (`dash_access`, `dash_project`) y:

```bash
curl -s -o /dev/null -w "%{http_code}\n" -b "dash_access=…; dash_project=…" http://localhost:3000/api/meta/connect      # 403
curl -s -b "dash_access=…; dash_project=…" http://localhost:3000/api/meta/connection                                      # {"connected":false,"canManage":false,...}
curl -s -o /dev/null -w "%{http_code}\n" -X POST -H 'content-type: application/json' -d '{"ids":[]}' -b "…" http://localhost:3000/api/meta/accounts   # 403
```

Con la contraseña general (`all`): `/connection` → `canManage: true`; `/connect` → `302` con `Location: https://www.facebook.com/v23.0/dialog/oauth?…config_id=1047096268324910…` (no seguir el redirect en local: la app rechaza `http://localhost`).

- [ ] **Step 7: Commit**

```bash
git add lib/meta-admin.ts app/api/meta
git commit -m "feat(meta): rutas OAuth, estado y asignación de cuentas, con compuerta del alcance all"
```

---

### Task 5: el paso `meta` en el sync, el rescate del último bueno, y el riel

**Files:**
- Modify: `lib/sync.ts` (`SyncFrame`, paso `meta`, payload)
- Modify: `app/api/dashboard/route.ts` (`preserveMetaAds`)
- Modify: `hooks/fetch-stream.ts:5`
- Modify: `hooks/use-dashboard-data.ts:7-31`
- Modify: `components/dashboard/loading-screen.tsx:17-34, 84-85, 148`

**Interfaces:**
- Consumes: `readMetaConnectionWithToken("ads")`, `readProjectAccounts(client, "ads")`, `fetchMetaAds`, `MetaApiError`, `historyWindow`, `oppAdId`, `PANEL_TIME_ZONE`, `MetaAdsData`, `MetaAdsStatus`.
- Produces: frames `{ type: "step", key: "meta", status: "loading" | "done" | "partial" | "error", count }`; `payload.metaAds`, `payload.metaAdsStatus`; `StepKey` incluye `"meta"`; `StepState.status` incluye `"partial" | "error"`.

- [ ] **Step 1: `SyncFrame` y `sendStep` en `lib/sync.ts`**

Línea 371:

```ts
  | { type: "step"; key: string; status: "loading" | "done" | "partial" | "error"; count?: number }
```

Y `sendStep` (línea ~388-392):

```ts
    const sendStep = (
      key: string,
      status: "loading" | "done" | "partial" | "error",
      count?: number
    ) => onFrame({ type: "step", key, status, ...(count !== undefined ? { count } : {}) });
```

Imports nuevos al inicio de `lib/sync.ts`:

```ts
import { readMetaConnectionWithToken, readProjectAccounts } from "@/lib/meta-connection-store";
import { fetchMetaAds, MetaApiError } from "@/lib/meta-client";
import { historyWindow } from "@/lib/meta-normalize";
import { oppAdId, PANEL_TIME_ZONE } from "@/lib/meta-attribution";
```

y agregar `MetaAdsData`, `MetaAdsStatus` al `import type { … } from "@/lib/types"`.

- [ ] **Step 2: El paso `meta`, después del bucle que copia atribución contacto→opp (línea ~619) y antes de `const calls: Call[] = []`**

```ts
      // ── Meta Ads ──────────────────────────────────────────────────────────
      // Corre DESPUÉS del transform de opportunities porque la ventana de historia
      // sale de la oportunidad más antigua con ad id. Sin conexión o sin cuentas
      // asignadas a ESTE proyecto el paso no se emite: no es un error, es que
      // nadie conectó o nadie le asignó cuenta al proyecto.
      let metaAds: MetaAdsData | null = null;
      let metaAdsStatus: MetaAdsStatus = { state: "none" };
      // El token solo se descifra aquí y nunca sale de este bloque.
      const [metaConn, metaAccountIds] = await Promise.all([
        readMetaConnectionWithToken("ads").catch((err) => {
          console.error("[meta] no se pudo leer la conexión, se sincroniza sin Meta:", err);
          return null;
        }),
        readProjectAccounts(client, "ads").catch((err) => {
          console.error("[meta] no se pudieron leer las cuentas del proyecto:", err);
          return [] as string[];
        }),
      ]);
      if (metaConn && metaAccountIds.length > 0) {
        if (metaConn.token === null) {
          // Hay fila pero el blob no descifra (DASHBOARD_AUTH_SECRET rotado). Callar
          // aquí dejaría la píldora en "conectado" y el gasto congelado sin aviso.
          sendStep("meta", "error", 0);
          metaAdsStatus = { state: "error", reason: "token_unreadable" };
        } else {
          sendStep("meta", "loading", 0);
          onFrame({ type: "progress", message: "Cargando Meta Ads…" });
          const today = new Intl.DateTimeFormat("en-CA", {
            timeZone: PANEL_TIME_ZONE,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).format(new Date());
          const wanted = new Set(metaAccountIds);
          try {
            metaAds = await fetchMetaAds({
              token: metaConn.token,
              accounts: metaConn.availableAccounts.filter((a) => wanted.has(a.id)),
              window: historyWindow(
                opportunities.map((o) => ({ createdAt: o.createdAt, adId: oppAdId(o) ?? undefined })),
                today
              ),
              onProgress: (n) => {
                sendStep("meta", "loading", n);
                onFrame({ type: "progress", message: `Cargando Meta Ads… ${n.toLocaleString("es-MX")} anuncios` });
              },
            });
            // Una cuenta asignada que la conexión ya no ve (otra empresa, o se
            // dejó de compartir) cuenta como fallida: la píldora la nombra.
            const missing = metaAccountIds
              .filter((id) => !metaConn.availableAccounts.some((a) => a.id === id))
              .map((id) => ({ id, reason: "not_available" }));
            const failed = [...metaAds.failedAccounts, ...missing];
            if (failed.length > 0) {
              metaAds = { ...metaAds, failedAccounts: failed };
              sendStep("meta", "partial", metaAds.ads.length);
              metaAdsStatus = { state: "partial", failedAccounts: failed };
            } else {
              sendStep("meta", "done", metaAds.ads.length);
              metaAdsStatus = { state: "ok" };
            }
          } catch (err) {
            console.error("[meta] el sync de Meta Ads falló:", err instanceof Error ? err.message : String(err));
            sendStep("meta", "error", 0);
            metaAds = null;
            metaAdsStatus = {
              state: "error",
              reason: err instanceof MetaApiError && err.isTokenInvalid ? "token_revoked" : "failed",
            };
          }
        }
      }
```

Y en el `return { … }` del payload, después de `customFieldDefs,`:

```ts
        metaAds,
        metaAdsStatus,
```

- [ ] **Step 3: `preserveMetaAds` en `app/api/dashboard/route.ts`**

Importar `readSync` ya está importado (verificar con `grep -n readSync app/api/dashboard/route.ts`). Agregar la función después de `saveQuietly`:

```ts
// Si el paso meta FALLÓ (token revocado, secreto rotado, Meta caído), conserva el
// metaAds del último caché bueno: un gasto de hace una hora le gana a ningún
// gasto, y metaAdsStatus (que sí se conserva del sync nuevo) ya dice que no se
// actualizó. Un `none` (sin conexión / sin cuentas) NO rescata nada: ahí el
// vacío es real.
async function preserveMetaAds(client: ClientConfig, payload: DashboardPayload): Promise<DashboardPayload> {
  if (payload.metaAdsStatus?.state !== "error" || payload.metaAds || !isDbConfigured()) return payload;
  try {
    const prev = await readSync(client);
    if (prev?.payload.metaAds) return { ...payload, metaAds: prev.payload.metaAds };
  } catch (err) {
    console.error("[meta] no se pudo rescatar el último metaAds:", err);
  }
  return payload;
}
```

Y envolver las dos llamadas a `syncProject`:

- camino frío (línea ~65): `const payload = await preserveMetaAds(client, await syncProject(client, send));`
- `refreshInBackground` (línea ~118): `const payload = await preserveMetaAds(client, await syncProject(client));`

- [ ] **Step 4: `hooks/fetch-stream.ts`**

Línea 5:

```ts
  status: "loading" | "done" | "partial" | "error";
```

- [ ] **Step 5: `hooks/use-dashboard-data.ts`**

```ts
export type StepKey =
  | "config"
  | "contacts"
  | "opportunities"
  | "pautas"
  | "appointments"
  | "tasks"
  // Solo se emite cuando el proyecto tiene Meta conectado y cuenta asignada.
  | "meta";

export interface StepState {
  status: "pending" | "loading" | "done" | "partial" | "error";
  count?: number;
}

export type StepMap = Record<StepKey, StepState>;

const INITIAL_STEPS: StepMap = {
  config: { status: "pending" },
  contacts: { status: "pending" },
  opportunities: { status: "pending" },
  pautas: { status: "pending" },
  appointments: { status: "pending" },
  tasks: { status: "pending" },
  meta: { status: "pending" },
};
```

En el `setSteps` dentro de `fetchStream` (línea ~76-80), el `step.key` viene como `string`; castear: `[step.key as StepKey]: { status: step.status, count: step.count }`.

- [ ] **Step 6: `components/dashboard/loading-screen.tsx`**

Reemplazar `STEP_KEYS` e `IDLE_STEPS` (líneas 17-34):

```ts
// Los datasets de GHL que /api/dashboard trae siempre. No se listan uno por
// fila — la pantalla solo los cuenta, para dimensionar el riel.
const GHL_STEP_KEYS: StepKey[] = [
  "config",
  "contacts",
  "opportunities",
  "pautas",
  "appointments",
  "tasks",
]

const IDLE_STEPS: StepMap = {
  config: { status: "pending" },
  contacts: { status: "pending" },
  opportunities: { status: "pending" },
  pautas: { status: "pending" },
  appointments: { status: "pending" },
  tasks: { status: "pending" },
  meta: { status: "pending" },
}

const FINISHED = new Set<StepState["status"]>(["done", "partial", "error"])
```

(importar `StepState` junto a `StepKey, StepMap`.)

Y las líneas 84-85:

```ts
  const syncing = GHL_STEP_KEYS.some((k) => resolved[k].status !== "pending")
  // El paso `meta` solo existe en proyectos con Meta: si nunca salió de
  // "pending" no entra al denominador, o el riel jamás llegaría al final.
  const keys = resolved.meta.status === "pending" ? GHL_STEP_KEYS : [...GHL_STEP_KEYS, "meta" as StepKey]
  const done = keys.filter((k) => FINISHED.has(resolved[k].status)).length
```

Línea 148: `<Rail ratio={syncing ? done / keys.length : null} />`.

- [ ] **Step 7: tsc y prueba contra realidad (sin conexión todavía)**

```bash
npx tsc --noEmit
pnpm dev
```

Abrir un proyecto con `?fresh=1` (botón Actualizar): el sync corre igual que antes, no aparece ningún frame `meta`, y en la respuesta `metaAds: null`, `metaAdsStatus: { state: "none" }` (verificar con `curl -b … 'http://localhost:3000/api/dashboard?fresh=1' | tail -c 300`).

Probar la regla "la base no es dependencia": con `DATABASE_URL=postgres://invalid` en `.env.local` el panel carga en frío y sin Meta.

- [ ] **Step 8: Commit**

```bash
git add lib/sync.ts app/api/dashboard/route.ts hooks/fetch-stream.ts hooks/use-dashboard-data.ts components/dashboard/loading-screen.tsx
git commit -m "feat(meta): paso meta en el sync con metaAdsStatus, rescate del último gasto bueno y riel que ignora el paso ausente"
```

---

### Task 6: la píldora `meta-connection.tsx` y su montaje en el header

**Files:**
- Create: `components/dashboard/meta-connection.tsx`
- Modify: `components/dashboard/dashboard-app.tsx` (import + montaje junto a "Actualizar")

**Interfaces:**
- Consumes: `GET/DELETE /api/meta/connection`, `POST /api/meta/accounts`, `data.metaAdsStatus`, `refresh()` del hook.
- Produces: `<MetaConnectionPill status={data?.metaAdsStatus} onChanged={() => refresh()} />`.

- [ ] **Step 1: Escribir `components/dashboard/meta-connection.tsx`**

```tsx
// components/dashboard/meta-connection.tsx
// La píldora "Meta" del header: conectar, ver el estado, asignar cuentas al
// proyecto abierto, reconectar o desconectar. Es el ÚNICO lugar de la UI que
// sabe del OAuth; las cards de costo (entrega ②) solo miran data.metaAds.
//
// Todos ven el estado; solo `canManage` (alcance all) ve acciones. Ámbar solo
// en `partial` — DESIGN.md: ámbar marca dónde va la atención.
"use client"

import { useCallback, useEffect, useState } from "react"
import { AlertTriangle, Check, ChevronDown, Loader2, Unplug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import type { MetaAdsStatus } from "@/lib/types"

interface AccountRow {
  id: string
  name: string
  currency: string
  status: number
  selected: boolean
}

type ConnectionState =
  | { connected: false; canManage: boolean; reason?: "not_configured" | "no_db" | "preview" }
  | {
      connected: true
      canManage: boolean
      connectedBy: string | null
      connectedAt: string
      tokenKind: "system_user" | "user"
      tokenExpiresAt: string | null
      accounts: AccountRow[]
    }

const ERROR_COPY: Record<string, string> = {
  state_invalid: "La conexión expiró. Inténtalo de nuevo.",
  denied: "Conexión cancelada.",
  token_exchange: "Meta no aceptó la autorización. Inténtalo de nuevo.",
  token_invalid: "Meta devolvió un token inválido. Inténtalo de nuevo.",
  no_accounts: "Esa empresa no compartió cuentas publicitarias.",
  db: "No se pudo guardar la conexión.",
}

const DISABLED_COPY: Record<NonNullable<Extract<ConnectionState, { connected: false }>["reason"]>, string> = {
  not_configured: "Meta no configurado",
  no_db: "Requiere base de datos",
  preview: "Conecta desde producción",
}

const PILL = "h-8 gap-1.5 rounded-lg border-white/20 bg-white/10 text-xs font-medium text-white hover:bg-white/15"

export function MetaConnectionPill({
  status,
  onChanged,
}: {
  /** metaAdsStatus del último sync (viaja en el payload, también en caliente). */
  status: MetaAdsStatus | undefined
  /** Tras conectar, asignar o desconectar: el panel debe re-sincronizar en fresco. */
  onChanged: () => void
}) {
  const [state, setState] = useState<ConnectionState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [draft, setDraft] = useState<string[]>([])
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/meta/connection")
      if (res.ok) setState((await res.json()) as ConnectionState)
    } catch {
      /* la píldora simplemente no aparece */
    }
  }, [])

  // Al montar, y al regresar del callback (?meta=connected | error).
  useEffect(() => {
    void load()
    const url = new URL(window.location.href)
    const meta = url.searchParams.get("meta")
    if (!meta) return
    const reason = url.searchParams.get("reason") ?? ""
    url.searchParams.delete("meta")
    url.searchParams.delete("reason")
    window.history.replaceState(null, "", url.toString())
    if (meta === "connected") {
      setNotice("Meta conectado")
      onChanged()
    } else {
      setNotice(ERROR_COPY[reason] ?? "No se pudo conectar con Meta.")
    }
    const t = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(t)
    // onChanged cambia de identidad en cada render; solo interesa al montar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load])

  const revoked = status?.state === "error" && status.reason !== "failed"
  const failedIds = status?.state === "partial" ? status.failedAccounts.map((f) => f.id) : []

  const openDialog = () => {
    if (!state?.connected) return
    setDraft(state.accounts.filter((a) => a.selected).map((a) => a.id))
    setDialogOpen(true)
  }

  const saveAccounts = async () => {
    setSaving(true)
    try {
      const res = await fetch("/api/meta/accounts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ids: draft }),
      })
      if (res.ok) {
        setDialogOpen(false)
        await load()
        onChanged()
      } else {
        setNotice("No se pudo guardar la asignación.")
      }
    } finally {
      setSaving(false)
    }
  }

  const disconnect = async () => {
    if (
      !window.confirm(
        "¿Desconectar Meta? El gasto dejará de actualizarse en TODOS los proyectos. Las cuentas asignadas se conservan. Esto no revoca el acceso en Meta; eso se hace desde el Business Manager."
      )
    )
      return
    await fetch("/api/meta/connection", { method: "DELETE" })
    await load()
    onChanged()
  }

  if (!state) return null

  // Sin conexión: los que no administran no ven nada; el admin ve el botón.
  if (!state.connected) {
    if (!state.canManage) return null
    const disabled = state.reason ? DISABLED_COPY[state.reason] : null
    return (
      <div className="flex items-center gap-2">
        {notice && <span className="text-xs text-white/80">{notice}</span>}
        <Button variant="outline" size="sm" className={PILL} disabled={!!disabled} asChild={!disabled}>
          {disabled ? <span>{disabled}</span> : <a href="/api/meta/connect">Conectar con Meta</a>}
        </Button>
      </div>
    )
  }

  const selected = state.accounts.filter((a) => a.selected)
  const tone = revoked
    ? "border-red-400/60 text-red-200"
    : failedIds.length > 0
      ? "border-[#F59B1B]/70 text-[#F59B1B]"
      : selected.length === 0
        ? "text-white/60"
        : ""
  const label = revoked
    ? "Meta desconectado"
    : failedIds.length > 0
      ? `Meta · ${failedIds.length === 1 ? "una cuenta no respondió" : `${failedIds.length} cuentas no respondieron`}`
      : selected.length === 0
        ? "Meta · sin cuenta"
        : `Meta · ${selected.length} ${selected.length === 1 ? "cuenta" : "cuentas"}`

  const pill = (
    <Button variant="outline" size="sm" className={`${PILL} ${tone}`}>
      {revoked || failedIds.length > 0 ? <AlertTriangle className="h-3.5 w-3.5" /> : <Check className="h-3.5 w-3.5" />}
      {label}
      {state.canManage && <ChevronDown className="h-3 w-3 opacity-70" />}
    </Button>
  )

  // Los alcances de agencia solo ven el estado.
  if (!state.canManage) return <div className="flex items-center gap-2">{pill}</div>

  return (
    <div className="flex items-center gap-2">
      {notice && <span className="text-xs text-white/80">{notice}</span>}
      <Popover>
        <PopoverTrigger asChild>{pill}</PopoverTrigger>
        <PopoverContent align="end" className="w-72 p-2 text-sm">
          <p className="px-2 py-1 text-xs text-muted-foreground">
            {state.connectedBy ? `Conectado por ${state.connectedBy}` : "Conectado"} ·{" "}
            {new Date(state.connectedAt).toLocaleDateString("es-MX")}
          </p>
          {revoked && (
            <p className="px-2 py-1 text-xs text-red-600 dark:text-red-400">
              {status?.state === "error" && status.reason === "token_unreadable"
                ? "El token ya no se puede leer (cambió el secreto). Vuelve a conectar."
                : "Meta revocó el acceso o el token dejó de ser válido. Vuelve a conectar."}
            </p>
          )}
          {failedIds.length > 0 && (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              Sin respuesta: {failedIds.join(", ")}. Si la cuenta es de otra empresa, hay que compartirla en el Business Manager.
            </p>
          )}
          {state.tokenExpiresAt && (
            <p className="px-2 py-1 text-xs text-muted-foreground">
              Token de usuario: caduca el {new Date(state.tokenExpiresAt).toLocaleDateString("es-MX")}.
            </p>
          )}
          {revoked ? (
            <Button variant="default" size="sm" className="w-full justify-start" asChild>
              <a href="/api/meta/connect">Reconectar</a>
            </Button>
          ) : (
            <>
              <Button variant="ghost" size="sm" className="w-full justify-start" onClick={openDialog}>
                {selected.length === 0 ? "Asignar cuenta a este proyecto" : "Cambiar cuentas de este proyecto"}
              </Button>
              <Button variant="ghost" size="sm" className="w-full justify-start" asChild>
                <a href="/api/meta/connect">Reconectar</a>
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" className="w-full justify-start text-red-600" onClick={disconnect}>
            <Unplug className="mr-1.5 h-3.5 w-3.5" /> Desconectar
          </Button>
        </PopoverContent>
      </Popover>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Cuentas publicitarias de este proyecto</DialogTitle>
            <DialogDescription>
              De las cuentas que la empresa compartió, elige cuáles alimentan a este proyecto. Una cuenta
              puede estar en varios proyectos. Sin ninguna, el proyecto no muestra gasto. Para compartir más
              cuentas, vuelve a conectar.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-80 space-y-2 overflow-y-auto">
            {state.accounts.map((a) => (
              <label key={a.id} className="flex items-center gap-3 text-sm">
                <Checkbox
                  checked={draft.includes(a.id)}
                  onCheckedChange={(v) => setDraft((d) => (v ? [...d, a.id] : d.filter((x) => x !== a.id)))}
                />
                <span className="flex-1 truncate">{a.name}</span>
                <span className="text-xs text-muted-foreground">
                  {a.id} · {a.currency}
                  {a.status !== 1 ? " · inactiva" : ""}
                </span>
              </label>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancelar
            </Button>
            <Button onClick={saveAccounts} disabled={saving}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Guardar y sincronizar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
```

- [ ] **Step 2: Montar en `components/dashboard/dashboard-app.tsx`**

Import:

```tsx
import { MetaConnectionPill } from "@/components/dashboard/meta-connection"
```

Justo **antes** del `<Button … onClick={() => refresh()}>` de "Actualizar" (línea ~316):

```tsx
            <MetaConnectionPill status={data?.metaAdsStatus} onChanged={() => refresh()} />
```

- [ ] **Step 3: tsc y prueba visual local**

```bash
npx tsc --noEmit
pnpm dev
```

- Con la contraseña general: aparece **Conectar con Meta** (habilitado — hay env y base). Al hacer clic redirige a Facebook, que rechaza `http://localhost` con "URL bloqueada": esperado; el flujo real se prueba en producción.
- Con la contraseña de `iw`: ninguna píldora (sin conexión y sin `canManage`).
- Ancho móvil (~400 px): el header no se desborda; la píldora cabe junto a "Actualizar".

- [ ] **Step 4: Commit**

```bash
git add components/dashboard/meta-connection.tsx components/dashboard/dashboard-app.tsx
git commit -m "feat(meta): píldora de conexión en el header — estado para todos, acciones solo para el alcance all"
```

---

### Task 7: documentación en CLAUDE.md y verificación completa

**Files:**
- Modify: `CLAUDE.md` (comandos, variables, sección "Meta Ads")

- [ ] **Step 1: Comandos**

En el bloque `## Commands`, después de `pnpm verify:drill-export … `:

```
pnpm verify:meta-oauth   # lib/meta-oauth.ts — state firmado por alcance, cifrado del token, URL del diálogo
pnpm verify:meta-connection-store # lib/meta-connection-store.ts — fila única por producto + cuentas por proyecto;
                         #   usa la base si hay DATABASE_URL, con producto sintético (no toca 'ads')
pnpm verify:meta         # lib/meta-normalize.ts — actions, chunks por mes, ventana de historia
pnpm verify:meta-attribution # lib/meta-attribution.ts — llave por ad id, cohorte por día local, costo por campaña
```

Y en la línea de `pnpm db:migrate`: `# Crea/verifica project_sync, meta_connection y meta_project_accounts en Neon. Idempotente.`

- [ ] **Step 2: Variables de entorno**

Después de `GHL_API_TOKEN / GHL_LOCATION_ID`:

```
- `META_APP_ID` / `META_APP_SECRET` / `META_LOGIN_CONFIG_ID` — la app de Meta de Lezgo
  (`Paneles Lezgo Suite`, app id `1432292882099074`, config de Login for Business
  `1047096268324910`, la MISMA que usa DRT). **De Lezgo, no de ningún proyecto** —
  nunca en `DASHBOARD_CLIENTS`. Sin ellas la píldora dice "Meta no configurado" y el
  sync se comporta como sin conexión.
- `META_PUBLIC_ORIGIN` — `https://proyectos.lezgosuite.com`, solo producción; fija el
  `redirect_uri` del OAuth. Sin él se usa el origen de la petición (localhost).
```

- [ ] **Step 3: Sección "### Meta Ads" en Architecture, después de "### Pauta (paid-advertising) classification"**

```markdown
### Meta Ads

Spec: `docs/superpowers/specs/2026-09-14-meta-ads-conexion-y-sync-design.md` (port de la
entrega ① de DRT; las razones que no cambian viven en el spec de DRT). Entrega ① —
conexión, dataset en el sync y cruce — implementada; ② (KPIs y tabla por campaña en
Marketing) tiene spec pendiente.

- **Una conexión por despliegue, cuentas por proyecto.** `meta_connection` tiene PK
  `product` (sin `client_id`): un admin de Lezgo conecta UNA vez con la empresa de
  Lezgo. `meta_project_accounts (project_id, product, account_ids)` dice qué `act_`
  mira cada proyecto; una cuenta puede servir a dos proyectos (Plaza Bosques y Meseta
  comparten anuncios). **Ninguna de las dos es desechable**: borrar la conexión
  obliga a reconectar; el DELETE no borra asignaciones.
- **Solo el alcance `all` administra** (`lib/meta-admin.ts`, `requireMetaAdmin()`):
  `connect`, `callback`, `DELETE /connection` y `POST /accounts` responden 403 a
  `domus`/`iw`, que ven la píldora como estado sin menú. El `state` del OAuth lleva el
  `scopeId` firmado y el callback exige que sea `all` y el de la sesión — más la
  cookie de nonce `meta_oauth`, un solo uso, que ata el callback al navegador que
  empezó el flujo.
- **Por qué funciona sin App Review** (verificado 2026-09-14 con el MCP de Meta):
  `ads_read`/`business_management` están en acceso Standard, que solo se concede a
  usuarios con rol en la app o en el portafolio que la reclamó. Quien conecta es admin
  de la app, así que basta. Un "Conectar" por proyecto con el admin del BM de una
  agencia NO funcionaría hoy. El *Marketing API Access Tier* empieza en Limited (rate
  limit agresivo por cuenta) y sube a Full solo tras 500 llamadas exitosas en 15 días:
  throttling la primera semana es esperado, se ve como paso `meta` lento o `partial`.
- **La llave es el ad id.** `opp.adId` (utmAdId) cubre 38-63 % de las oportunidades
  según el proyecto; `campaignName` cubre menos en los seis, y el objeto Pauta de aquí
  no trae nombre de anuncio, así que **no hay cruce por nombre**. `oppAdId()` en
  `lib/meta-attribution.ts` es la única función que lo lee (nativo manda; custom field
  `ID Pauta`/`ID de Pauta` es fallback). `classifyLead` → `exact | unknownAd | noAdId |
  notPauta`; `csv_import` es `notPauta` incluso con ad id. Solo `exact` entra al costo.
- **`metaAds` es un dataset más del sync** (`lib/sync.ts`, paso `meta`, DESPUÉS del
  transform de `opportunities` porque la ventana sale de la opp más antigua con ad id).
  **Sin conexión o sin cuentas asignadas al proyecto el paso no se emite**, `metaAds`
  es `null` y `metaAdsStatus` es `{ state: "none" }`: no es error. Con token revocado
  (190) o secreto rotado (`token_unreadable`) el estado es `error` y
  `preserveMetaAds()` en la ruta rescata el `metaAds` del último caché bueno para no
  borrar el gasto en pantalla; la píldora se pone en rojo con "Reconectar". Este
  despliegue no tiene `warnings[]`: `metaAdsStatus` es su equivalente, y viaja en el
  payload para que un load en caliente muestre el estado correcto.
- **Cada sync re-trae la ventana completa** (mes de la opp más vieja con ad id, tope 24
  meses, por meses calendario). De `actions` solo salen `lead` y
  `onsite_conversion.messaging_conversation_started_7d`.
- **La cohorte es por día LOCAL** (`localDay`, `America/Mexico_City`) contra
  `daily.date`, la misma regla que `drill-export`. Sin denominador → `null`, nunca
  `$0`; `mixedCurrency` apaga los totales consolidados.
- `lib/meta-client.ts` es **server-only** como `ghl-client.ts`. Lo puro está en
  `meta-oauth`, `meta-normalize` y `meta-attribution`.
- **Localhost no completa el OAuth** (la app publicada rechaza `http://localhost`): se
  conecta desde producción y el dev local lee la misma fila de Neon. Previews tampoco.
- El riel de la pantalla de carga cuenta `meta` solo si el paso se emitió
  (`loading-screen.tsx`); si no, un proyecto sin Meta nunca llegaría al 100 %.
```

- [ ] **Step 4: Verificación completa**

```bash
pnpm verify:meta-oauth && pnpm verify:meta && pnpm verify:meta-connection-store && pnpm verify:meta-attribution
pnpm verify:sync-store && pnpm verify:scopes && pnpm verify:auth
npx tsc --noEmit
```

Todo verde, sin salida de tsc.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(meta): sección Meta Ads en CLAUDE.md, comandos y variables"
```

---

### Task 8: contra realidad — deploy, conectar, asignar, cuadrar

Sin código. Es la parte que ningún verify cubre y la que decide si ① está terminada.

- [ ] **Step 1: Migrar producción y desplegar**

```bash
pnpm db:migrate        # contra la DATABASE_URL_UNPOOLED de producción (la de .env.local)
git push origin main   # Vercel despliega
```

- [ ] **Step 2: Conectar desde producción**

En `https://proyectos.lezgosuite.com` con la contraseña general, abrir Condesa → **Conectar con Meta** → autorizar con la cuenta que es admin de la app → elegir las cuentas publicitarias → vuelve con "Meta conectado". La píldora dice "Meta · sin cuenta".

Si Meta responde con error en el diálogo, anotar el texto exacto: es el primer OAuth de esta app de punta a punta.

- [ ] **Step 3: Asignar y sincronizar**

Píldora → **Asignar cuenta a este proyecto** → marcar la cuenta de Condesa (los ad ids de Condesa terminan en `…0104`; el nombre de la cuenta debe corresponder a IW/Condesa) → **Guardar y sincronizar**. El sync en fresco muestra el paso "Cargando Meta Ads… N anuncios". Al terminar:

```bash
curl -s -b "dash_access=…; dash_project=…" 'https://proyectos.lezgosuite.com/api/dashboard' | python3 -c "
import sys, json
d = json.loads(sys.stdin.read().strip().splitlines()[-1])
m = d['metaAds']; print(d['metaAdsStatus']); print(len(m['campaigns']), 'campañas', len(m['ads']), 'ads', len(m['daily']), 'filas diarias', m['window'])"
```

- [ ] **Step 4: Cuadrar con el Administrador de anuncios**

Elegir una campaña de Condesa y un mes cerrado (agosto 2026). Sumar `spend` de las filas `daily` de sus ads en ese mes y compararlo con el gasto que muestra el Administrador de anuncios para esa campaña y ese mes. Deben coincidir al peso (Meta reporta en la moneda de la cuenta, sin IVA). Si difieren, revisar primero la zona horaria de la cuenta (`accounts[].timezone`) y la ventana de atribución — no el código.

- [ ] **Step 5: Aislamiento por alcance**

Abrir Condesa con la contraseña de `iw`: la píldora se ve ("Meta · 1 cuenta"), sin flecha ni menú. `POST /api/meta/accounts` con esas cookies → 403.

- [ ] **Step 6: Un proyecto sin cuenta**

Abrir Yconia con la contraseña general: "Meta · sin cuenta", sin paso `meta` en el sync, `metaAdsStatus: { state: "none" }`. El panel se comporta exactamente como antes.

- [ ] **Step 7: Registrar el resultado**

Agregar al final de la sección "Meta Ads" de CLAUDE.md una línea `Conectado en producción el <fecha>; gasto de <campaña>/<mes> cuadrado contra el Administrador de anuncios: <sí/diferencia>.` y commitear.
