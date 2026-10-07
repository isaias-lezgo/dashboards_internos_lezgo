# Meta: conexión por proyecto — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que cada proyecto tenga su propia conexión con Meta (token + cuentas), en lugar de una conexión por despliegue que obliga a compartir cuentas al portafolio de Lezgo.

**Architecture:** Tabla nueva `meta_project_connection` con PK `(project_id, product)` que guarda token cifrado, cuentas disponibles y cuentas elegidas en una sola fila. El store pasa a recibir `ClientConfig` en todas sus funciones; el `state` del OAuth firma el `projectId` y el callback lo exige igual al proyecto de la sesión. La conexión vieja se copia a los proyectos que tenían cuentas asignadas, sin borrar las tablas viejas.

**Tech Stack:** Next.js 16 App Router, Neon (`@neondatabase/serverless`), Web Crypto, scripts `tsx` con `node:assert/strict` (no hay framework de tests).

**Spec:** `docs/superpowers/specs/2026-10-07-meta-conexion-por-proyecto-design.md`

## Global Constraints

- Package manager: **pnpm** (nunca `npm install`).
- El paquete es CommonJS: en scripts `tsx`, **nada de top-level await**; envolver en `main()` + `main().catch(...)`.
- `next build` ignora errores de TS: **`npx tsc --noEmit` es obligatorio** al final de cada tarea que toque `.ts/.tsx` (excepto donde se indica que se espera un rojo temporal).
- Ids sintéticos en verificaciones contra la base: `__verify_*` (el roster prohíbe guiones bajos). Producto sintético `__verify_ads` para no tocar la fila `ads` real.
- Funciones del store por proyecto reciben `ClientConfig`, **nunca** un id suelto.
- Administrar Meta (connect, callback, DELETE, POST accounts): **solo el alcance `all`** (`requireMetaAdmin()`).
- La base no es una dependencia: sin `DATABASE_URL` las lecturas devuelven `null`, las escrituras no hacen nada y lo registran.
- `meta_connection` y `meta_project_accounts` **no se borran ni se alteran**.
- Ámbar `#F59B1B` solo donde va la atención (estado `partial` y token por caducar).
- Commits terminan con `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **OAuth iniciado en un proyecto y cerrado con otro proyecto abierto** (otra pestaña cambió `dash_project`): el callback debe responder `state_invalid` y no guardar nada en ningún proyecto. Lo cubre la Task 1 (un `projectId` falsificado no pasa la firma) y el chequeo explícito en el callback (Task 3).
2. **Reconectar con un Facebook que ya no ve una cuenta elegida**: `account_ids` se conserva y el sync la marca `not_available` (píldora ámbar), no desaparece en silencio. Task 2, aserción "reconexión conserva aunque no esté disponible".
3. **Asignar a B una cuenta que solo ve la conexión de A**: debe dar `false`. La validación es contra la fila del propio proyecto. Task 2, aserción de aislamiento.
4. **Correr `db:migrate` dos veces, o después de que un proyecto ya se conectó por su cuenta**: la copia no pisa nada (`ON CONFLICT DO NOTHING`). Task 2, aserciones de backfill.
5. **Token de usuario caducado o token de sistema sin fecha**: `tokenExpiryDays` devuelve `null` para `null`, y un número ≤ 0 para uno caducado. La píldora no debe decir "caduca en -3 días". Task 4.

---

## File Structure

| Archivo | Cambio | Responsabilidad |
|---|---|---|
| `lib/meta-oauth.ts` | Modificar | `MetaState` gana `projectId`; `verifyState` lo exige. |
| `scripts/verify-meta-oauth.ts` | Modificar | Aserciones de `projectId`. |
| `lib/meta-connection-store.ts` | Reescribir | Store por proyecto + `backfillProjectConnections`. |
| `scripts/db-migrate.ts` | Modificar | Crea `meta_project_connection` y corre el backfill. |
| `scripts/verify-meta-connection-store.ts` | Reescribir | Aislamiento, autoselección, reconexión, backfill. |
| `app/api/meta/connect/route.ts` | Modificar | Firma `projectId`. |
| `app/api/meta/callback/route.ts` | Modificar | Exige `projectId === client.id`, guarda por proyecto. |
| `app/api/meta/connection/route.ts` | Modificar | GET/DELETE del proyecto de la sesión. |
| `app/api/meta/accounts/route.ts` | Sin cambio de lógica | (la firma de `writeProjectAccounts` no cambia). |
| `lib/sync.ts` | Modificar | Una lectura por proyecto. |
| `lib/meta-admin.ts` | Modificar | Solo el comentario. |
| `lib/meta-expiry.ts` | Crear | `tokenExpiryDays`, `EXPIRY_WARNING_DAYS` (puro, apto para el navegador). |
| `components/dashboard/meta-connection.tsx` | Modificar | Textos por proyecto + aviso de caducidad. |
| `CLAUDE.md` | Modificar | Documentación del nuevo modelo. |

---

### Task 1: `projectId` firmado en el state del OAuth

**Files:**
- Modify: `lib/meta-oauth.ts` (interface `MetaState` ~línea 17; `verifyState` ~línea 98; comentario de cabecera líneas 8-11)
- Test: `scripts/verify-meta-oauth.ts`

**Interfaces:**
- Produces: `MetaState { scopeId: string; projectId: string; product: MetaProduct; returnTo: string; nonce: string; iat: number }`. `signState(s: Omit<MetaState,"nonce"|"iat">, now?)` ahora exige `projectId`. `verifyState` devuelve `null` si falta o está vacío.

- [ ] **Step 1: Write the failing test**

En `scripts/verify-meta-oauth.ts`, cambiar las dos llamadas a `signState` (líneas ~28 y ~39) para incluir `projectId: "condesa"`, y agregar después de la aserción `assert.equal(back.scopeId, "all");`:

```ts
  assert.equal(back.projectId, "condesa", "el proyecto viaja firmado");
```

Y después del bloque del `forged` con `scopeId: "domus"` (línea ~47):

```ts
  // --- cambiar el proyecto dentro del payload también invalida la firma: un OAuth
  // iniciado en Condesa no puede guardarse en Yconia
  const forgedProject = Buffer.from(JSON.stringify({ ...payload, projectId: "yconia" }), "utf8").toString("base64url");
  assert.equal(await verifyState(`${forgedProject}.${sig}`, now), null, "state con projectId ajeno se rechaza");

  // --- un state bien firmado SIN projectId (formato viejo) se rechaza
  const legacy = await signState({ scopeId: "all", product: "ads", returnTo: "/" } as never, now);
  assert.equal(await verifyState(legacy, now), null, "state sin projectId se rechaza");
```

(Los nombres `payload` y `sig` ya existen en ese bloque del script; usarlos tal cual.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm verify:meta-oauth`
Expected: FAIL — `back.projectId` es `undefined` en lugar de `"condesa"` (o el legacy no se rechaza).

- [ ] **Step 3: Write minimal implementation**

En `lib/meta-oauth.ts`:

```ts
export interface MetaState {
  scopeId: string;
  /** El proyecto cuya conexión se está creando. El callback exige que sea el de la sesión. */
  projectId: string;
  product: MetaProduct;
  /** Ruta relativa a la que regresar tras el callback (siempre empieza con "/"). */
  returnTo: string;
  nonce: string;
  iat: number;
}
```

En `verifyState`, justo después de la línea del `scopeId`:

```ts
  if (typeof s.projectId !== "string" || !s.projectId) return null;
```

Reemplazar el párrafo de cabecera (líneas 8-11) por:

```ts
// El `state` lleva el id del ALCANCE y el del PROYECTO dentro del payload firmado.
// La conexión es una por proyecto: el callback exige que el state venga de una
// sesión del alcance `all` y que su proyecto sea el que la sesión tiene abierto.
// Un state ajeno bien firmado no debe guardar nada.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm verify:meta-oauth`
Expected: PASS (`✅`).
`npx tsc --noEmit` va a marcar `app/api/meta/connect/route.ts` (falta `projectId`): **esperado**, lo arregla la Task 3.

- [ ] **Step 5: Commit**

```bash
git add lib/meta-oauth.ts scripts/verify-meta-oauth.ts
git commit -m "feat(meta): el state del OAuth firma el proyecto

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Store por proyecto, tabla nueva y backfill

**Files:**
- Rewrite: `lib/meta-connection-store.ts`
- Modify: `scripts/db-migrate.ts`
- Rewrite: `scripts/verify-meta-connection-store.ts`

**Interfaces:**
- Consumes: `encryptToken`, `decryptToken`, `MetaProduct` de `lib/meta-oauth.ts`; `getSql`, `isDbConfigured` de `lib/db.ts`; `ClientConfig` de `lib/clients.ts`.
- Produces (todas exportadas desde `lib/meta-connection-store.ts`):
  - `interface MetaAccountInfo { id; name; currency; timezone; status }` (sin cambios)
  - `interface MetaConnection { projectId: string; product: MetaProduct; tokenKind: "system_user" | "user"; tokenExpiresAt: string | null; connectedBy: string | null; availableAccounts: MetaAccountInfo[]; accountIds: string[]; connectedAt: string; updatedAt: string }`
  - `interface MetaConnectionWithToken extends MetaConnection { token: string | null }`
  - `readMetaConnection(client: ClientConfig, product: MetaProduct): Promise<MetaConnection | null>`
  - `readMetaConnectionWithToken(client: ClientConfig, product: MetaProduct): Promise<MetaConnectionWithToken | null>`
  - `writeMetaConnection(client: ClientConfig, product: MetaProduct, input: { token: string; tokenKind: "system_user" | "user"; tokenExpiresAt: string | null; connectedBy: string | null; availableAccounts: MetaAccountInfo[] }): Promise<void>`
  - `writeProjectAccounts(client: ClientConfig, product: MetaProduct, ids: string[]): Promise<boolean>`
  - `deleteMetaConnection(client: ClientConfig, product: MetaProduct): Promise<void>`
  - `backfillProjectConnections(product: MetaProduct): Promise<string[]>`: ids de proyecto copiados.
  - `readProjectAccounts` **desaparece** (lo reemplaza `conn.accountIds`).

Después de esta tarea `tsc` marca los consumidores (rutas y sync): **esperado**, lo arregla la Task 3.

- [ ] **Step 1: Agregar la tabla a la migración**

En `scripts/db-migrate.ts`, después del `CREATE TABLE IF NOT EXISTS meta_project_accounts (...)` y antes de `opportunity_milestones`, insertar:

```ts
  // La conexión con Meta POR PROYECTO (reemplaza a meta_connection +
  // meta_project_accounts, que se quedan como respaldo y ya nadie lee). Token,
  // cuentas que ese token ve y cuentas que el proyecto mira, en una fila. NO es
  // desechable: si se borra, ese proyecto vuelve a apretar "Conectar con Meta".
  await sql`
    CREATE TABLE IF NOT EXISTS meta_project_connection (
      project_id          text        NOT NULL,
      product             text        NOT NULL,
      token_encrypted     bytea       NOT NULL,
      token_kind          text        NOT NULL,
      token_expires_at    timestamptz,
      connected_by        text,
      available_accounts  jsonb       NOT NULL,
      account_ids         jsonb       NOT NULL DEFAULT '[]'::jsonb,
      connected_at        timestamptz NOT NULL,
      updated_at          timestamptz NOT NULL,
      PRIMARY KEY (project_id, product)
    )
  `;
```

Agregar `"meta_project_connection"` al arreglo del `for (const table of [...])`. Después de ese `for`, antes de cerrar `main()`:

```ts
  // Copia la conexión del despliegue a cada proyecto que tenía cuentas
  // asignadas. Idempotente: nunca pisa una conexión por proyecto ya hecha.
  // Usa getSql() (DATABASE_URL); sin ella se salta.
  if (process.env.DATABASE_URL) {
    const copied = await backfillProjectConnections("ads");
    console.log(
      copied.length > 0
        ? `✅ conexión de Meta copiada a: ${copied.join(", ")}`
        : "✅ nada que copiar de meta_connection (ya copiado o sin asignaciones)"
    );
  } else {
    console.log("⚠️  Sin DATABASE_URL: se omite la copia de la conexión de Meta.");
  }
```

Con el import arriba: `import { backfillProjectConnections } from "../lib/meta-connection-store";`.
Actualizar la primera línea del archivo: `// Crea las tablas del caché, de Meta (por proyecto) y de la bitácora del PMI. Idempotent — safe to run on every deploy or by hand.`

- [ ] **Step 2: Write the failing test**

Reemplazar `scripts/verify-meta-connection-store.ts` completo por:

```ts
// Verificación de lib/meta-connection-store.ts. Correr: pnpm verify:meta-connection-store
//
// La conexión es UNA POR PROYECTO. El roundtrip contra la base real usa un
// producto sintético ("__verify_ads") y proyectos "__verify_*" (ID_RE prohíbe
// guiones bajos, así que no chocan con el roster), y borra todo al terminar.
// Para el backfill escribe filas sintéticas en las tablas VIEJAS con SQL directo:
// el store ya no tiene funciones que las escriban. Sin DATABASE_URL solo corre la
// parte pura y lo dice.
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
  writeProjectAccounts,
  backfillProjectConnections,
} from "../lib/meta-connection-store";
import { encryptToken, type MetaProduct } from "../lib/meta-oauth";
import type { ClientConfig } from "../lib/clients";

const P = "__verify_ads" as MetaProduct;
const A: ClientConfig = { id: "__verify_meta_a", name: "A", locationId: "loc-a", ghlToken: "pit-a" };
const B: ClientConfig = { id: "__verify_meta_b", name: "B", locationId: "loc-b", ghlToken: "pit-b" };
const C: ClientConfig = { id: "__verify_meta_c", name: "C", locationId: "loc-c", ghlToken: "pit-c" };
const D: ClientConfig = { id: "__verify_meta_d", name: "D", locationId: "loc-d", ghlToken: "pit-d" };

const acc = (id: string, name: string) => ({
  id,
  name,
  currency: "MXN",
  timezone: "America/Mexico_City",
  status: 1,
});
const accounts = [acc("act_1", "Condesa"), acc("act_2", "Plaza Bosques")];

const conn = (token: string, availableAccounts = accounts) => ({
  token,
  tokenKind: "system_user" as const,
  tokenExpiresAt: null,
  connectedBy: "Admin Lezgo",
  availableAccounts,
});

async function cleanup() {
  const sql = getSql();
  await sql`DELETE FROM meta_project_connection WHERE product = ${P}`;
  await sql`DELETE FROM meta_connection WHERE product = ${P}`;
  await sql`DELETE FROM meta_project_accounts WHERE product = ${P}`;
}

async function main() {
  if (!isDbConfigured()) {
    console.log("⚠️  Sin DATABASE_URL: se omite el roundtrip contra Postgres.");
    assert.equal(await readMetaConnection(A, P), null);
    assert.equal(await writeProjectAccounts(A, P, ["act_1"]), false);
    assert.deepEqual(await backfillProjectConnections(P), []);
    await deleteMetaConnection(A, P);
    console.log("✅ verify:meta-connection-store OK (solo parte pura)");
    return;
  }

  await cleanup();
  const sql = getSql();

  // --- vacío
  assert.equal(await readMetaConnection(A, P), null);
  assert.equal(await writeProjectAccounts(A, P, ["act_1"]), false, "sin conexión no hay contra qué validar");

  // --- conectar A con dos cuentas: nada se autoselecciona
  await writeMetaConnection(A, P, conn("EAAB-secreto-a"));
  const a = await readMetaConnection(A, P);
  assert.ok(a);
  assert.equal(a.projectId, A.id);
  assert.equal(a.tokenKind, "system_user");
  assert.equal(a.connectedBy, "Admin Lezgo");
  assert.deepEqual(a.availableAccounts, accounts);
  assert.deepEqual(a.accountIds, [], "con dos cuentas nadie elige por la persona");
  assert.equal("token" in a, false, "la lectura normal NO trae el token");

  // --- AISLAMIENTO: B no ve la conexión de A
  assert.equal(await readMetaConnection(B, P), null, "B no lee la fila de A");
  assert.equal(await writeProjectAccounts(B, P, ["act_1"]), false, "B no puede asignar cuentas que solo ve A");

  // --- cifrado en reposo y descifrado explícito
  const raw = await sql`SELECT token_encrypted FROM meta_project_connection WHERE project_id = ${A.id} AND product = ${P}`;
  assert.ok(!Buffer.from(raw[0].token_encrypted).toString("utf8").includes("EAAB-secreto-a"));
  assert.equal((await readMetaConnectionWithToken(A, P))?.token, "EAAB-secreto-a");

  // --- secreto rotado: la fila sigue, token: null
  const secret = process.env.DASHBOARD_AUTH_SECRET;
  process.env.DASHBOARD_AUTH_SECRET = "otro-secreto";
  const rotated = await readMetaConnectionWithToken(A, P);
  assert.ok(rotated, "la fila se sigue leyendo");
  assert.equal(rotated.token, null);
  process.env.DASHBOARD_AUTH_SECRET = secret;

  // --- asignar: solo ids de la propia fila; dedup; vacío válido
  assert.equal(await writeProjectAccounts(A, P, ["act_2"]), true);
  assert.deepEqual((await readMetaConnection(A, P))?.accountIds, ["act_2"]);
  assert.equal(await writeProjectAccounts(A, P, ["act_2", "act_999"]), false);
  assert.deepEqual((await readMetaConnection(A, P))?.accountIds, ["act_2"], "un id inválido no cambia nada");
  assert.equal(await writeProjectAccounts(A, P, ["act_1", "act_1"]), true);
  assert.deepEqual((await readMetaConnection(A, P))?.accountIds, ["act_1"], "se deduplica");
  assert.equal(await writeProjectAccounts(A, P, []), true, "vacío = quitarle Meta al proyecto");
  assert.deepEqual((await readMetaConnection(A, P))?.accountIds, []);

  // --- conectar B con UNA cuenta: se autoselecciona
  await writeMetaConnection(B, P, conn("EAAB-secreto-b", [accounts[1]]));
  assert.deepEqual((await readMetaConnection(B, P))?.accountIds, ["act_2"], "una sola cuenta queda elegida sola");

  // --- reconectar A conserva connected_at y account_ids, AUNQUE la cuenta ya no esté disponible
  await writeProjectAccounts(A, P, ["act_1"]);
  await writeMetaConnection(A, P, {
    token: "EAAB-secreto-a2",
    tokenKind: "user",
    tokenExpiresAt: "2026-12-01T00:00:00.000Z",
    connectedBy: "Otra persona",
    availableAccounts: [accounts[1]],
  });
  const a2 = await readMetaConnectionWithToken(A, P);
  assert.equal(a2?.token, "EAAB-secreto-a2");
  assert.equal(a2?.tokenKind, "user");
  assert.equal(a2?.tokenExpiresAt, "2026-12-01T00:00:00.000Z");
  assert.equal(a2?.connectedBy, "Otra persona");
  assert.equal(a2?.connectedAt, a.connectedAt, "connected_at se conserva al reconectar");
  assert.deepEqual(a2?.accountIds, ["act_1"], "la selección sobrevive; el sync la marca not_available");

  // --- reconectar con selección VACÍA y una sola cuenta: se autoselecciona
  await writeProjectAccounts(A, P, []);
  await writeMetaConnection(A, P, conn("EAAB-secreto-a3", [accounts[0]]));
  assert.deepEqual((await readMetaConnection(A, P))?.accountIds, ["act_1"]);

  // --- borrar A no toca B
  await deleteMetaConnection(A, P);
  assert.equal(await readMetaConnection(A, P), null);
  assert.deepEqual((await readMetaConnection(B, P))?.accountIds, ["act_2"], "B intacto");

  // --- BACKFILL desde las tablas viejas
  const oldBlob = Buffer.from(await encryptToken("EAAB-viejo"));
  await sql`
    INSERT INTO meta_connection (product, token_encrypted, token_kind, token_expires_at, business_id,
                                 connected_by, available_accounts, connected_at, updated_at)
    VALUES (${P}, ${oldBlob}, 'system_user', NULL, NULL, 'Lezgo', ${JSON.stringify(accounts)}::jsonb,
            '2026-09-14T00:00:00Z', now())
  `;
  // C tenía cuentas → se copia. D tenía lista vacía → no. B ya tiene conexión propia → no se pisa.
  for (const [id, ids] of [[C.id, ["act_1"]], [D.id, []], [B.id, ["act_1", "act_2"]]] as const) {
    await sql`
      INSERT INTO meta_project_accounts (project_id, product, account_ids, updated_at)
      VALUES (${id}, ${P}, ${JSON.stringify(ids)}::jsonb, now())
    `;
  }
  assert.deepEqual(await backfillProjectConnections(P), [C.id], "solo C: con asignación y sin conexión propia");
  const c = await readMetaConnectionWithToken(C, P);
  assert.equal(c?.token, "EAAB-viejo", "el blob se copia tal cual y descifra");
  assert.deepEqual(c?.accountIds, ["act_1"]);
  assert.deepEqual(c?.availableAccounts, accounts);
  assert.equal(c?.connectedAt, "2026-09-14T00:00:00.000Z");
  assert.equal(await readMetaConnection(D, P), null, "D (lista vacía) no se copia");
  assert.equal((await readMetaConnectionWithToken(B, P))?.token, "EAAB-secreto-b", "B no se pisa");
  assert.deepEqual(await backfillProjectConnections(P), [], "segunda corrida: nada");

  await cleanup();
  console.log("✅ verify:meta-connection-store OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm verify:meta-connection-store`
Expected: FAIL. Error de import/tipo (`backfillProjectConnections` no existe) o, si `tsx` lo deja pasar, de la tabla `meta_project_connection` inexistente.

- [ ] **Step 4: Write the implementation**

Reemplazar `lib/meta-connection-store.ts` completo por:

```ts
// lib/meta-connection-store.ts
// La conexión con Meta de CADA PROYECTO: token cifrado, las cuentas que ese token
// ve y las que el proyecto mira, en una fila por (proyecto, producto).
//
// A diferencia de project_sync, no es desechable: si se borra la fila, ese
// proyecto vuelve a apretar "Conectar con Meta". Es estado que no se rellena
// solo, y por eso el DELETE pide confirmación en la UI.
//
// Toda función recibe el ClientConfig, nunca un string suelto: leer la fila
// equivocada pintaría el gasto de A en el panel de B, la misma clase de fuga que
// lib/ghl-context.ts existe para evitar.
//
// meta_connection y meta_project_accounts (el modelo anterior, una conexión por
// despliegue) solo las lee backfillProjectConnections, una vez, desde db:migrate.
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
  projectId: string;
  product: MetaProduct;
  tokenKind: "system_user" | "user";
  /** ISO, o null para un token de usuario del sistema (no caduca). */
  tokenExpiresAt: string | null;
  connectedBy: string | null;
  /** Lo que el token de este proyecto ve. */
  availableAccounts: MetaAccountInfo[];
  /** Lo que el proyecto mira. Puede incluir una cuenta que el token ya no ve: el sync la marca not_available. */
  accountIds: string[];
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
  project_id: string;
  product: string;
  token_encrypted: Uint8Array | Buffer;
  token_kind: string;
  token_expires_at: string | Date | null;
  connected_by: string | null;
  available_accounts: MetaAccountInfo[];
  account_ids: string[];
  connected_at: string | Date;
  updated_at: string | Date;
}

function iso(v: string | Date): string {
  return new Date(v).toISOString();
}

function fromRow(r: Row): MetaConnection {
  return {
    projectId: r.project_id,
    product: r.product as MetaProduct,
    tokenKind: r.token_kind === "user" ? "user" : "system_user",
    tokenExpiresAt: r.token_expires_at ? iso(r.token_expires_at) : null,
    connectedBy: r.connected_by,
    availableAccounts: r.available_accounts ?? [],
    accountIds: r.account_ids ?? [],
    connectedAt: iso(r.connected_at),
    updatedAt: iso(r.updated_at),
  };
}

async function readRow(client: ClientConfig, product: MetaProduct): Promise<Row | null> {
  if (!isDbConfigured()) return null;
  const rows = (await getSql()`
    SELECT project_id, product, token_encrypted, token_kind, token_expires_at,
           connected_by, available_accounts, account_ids, connected_at, updated_at
      FROM meta_project_connection
     WHERE project_id = ${client.id} AND product = ${product}
  `) as Row[];
  return rows[0] ?? null;
}

export async function readMetaConnection(
  client: ClientConfig,
  product: MetaProduct
): Promise<MetaConnection | null> {
  const row = await readRow(client, product);
  return row ? fromRow(row) : null;
}

// Separada a propósito: el token solo lo pide el sync. La píldora y las rutas de
// estado usan readMetaConnection y no pueden filtrarlo por accidente.
export async function readMetaConnectionWithToken(
  client: ClientConfig,
  product: MetaProduct
): Promise<MetaConnectionWithToken | null> {
  const row = await readRow(client, product);
  if (!row) return null;
  const token = await decryptToken(new Uint8Array(row.token_encrypted));
  return { ...fromRow(row), token };
}

// Upsert. Al reconectar se conservan connected_at y la selección de cuentas:
// reconectar con otra persona no debe obligar a volver a elegir. Si la selección
// está vacía y el token ve exactamente una cuenta, esa queda elegida sola.
export async function writeMetaConnection(
  client: ClientConfig,
  product: MetaProduct,
  input: {
    token: string;
    tokenKind: "system_user" | "user";
    tokenExpiresAt: string | null;
    connectedBy: string | null;
    availableAccounts: MetaAccountInfo[];
  }
): Promise<void> {
  if (!isDbConfigured()) {
    console.error("[meta] writeMetaConnection sin DATABASE_URL: no hay dónde guardar el token");
    return;
  }
  const blob = Buffer.from(await encryptToken(input.token));
  const initial = input.availableAccounts.length === 1 ? [input.availableAccounts[0].id] : [];
  await getSql()`
    INSERT INTO meta_project_connection (
      project_id, product, token_encrypted, token_kind, token_expires_at,
      connected_by, available_accounts, account_ids, connected_at, updated_at
    ) VALUES (
      ${client.id}, ${product}, ${blob}, ${input.tokenKind}, ${input.tokenExpiresAt},
      ${input.connectedBy}, ${JSON.stringify(input.availableAccounts)}::jsonb,
      ${JSON.stringify(initial)}::jsonb, now(), now()
    )
    ON CONFLICT (project_id, product) DO UPDATE
       SET token_encrypted    = EXCLUDED.token_encrypted,
           token_kind         = EXCLUDED.token_kind,
           token_expires_at   = EXCLUDED.token_expires_at,
           connected_by       = EXCLUDED.connected_by,
           available_accounts = EXCLUDED.available_accounts,
           account_ids        = CASE WHEN meta_project_connection.account_ids = '[]'::jsonb
                                     THEN EXCLUDED.account_ids
                                     ELSE meta_project_connection.account_ids END,
           updated_at         = now()
  `;
}

// false si este proyecto no tiene conexión o si algún id no está entre las
// cuentas que SU token ve. La validación va contra la fila, no contra lo que
// mande el browser. Una lista VACÍA es válida: es "quitarle Meta a este proyecto".
export async function writeProjectAccounts(
  client: ClientConfig,
  product: MetaProduct,
  ids: string[]
): Promise<boolean> {
  if (!isDbConfigured()) {
    console.error("[meta] writeProjectAccounts sin DATABASE_URL: no hay dónde guardar");
    return false;
  }
  const row = await readRow(client, product);
  if (!row) return false;
  const available = new Set((row.available_accounts ?? []).map((a) => a.id));
  if (!ids.every((id) => available.has(id))) return false;
  const unique = Array.from(new Set(ids));
  await getSql()`
    UPDATE meta_project_connection
       SET account_ids = ${JSON.stringify(unique)}::jsonb, updated_at = now()
     WHERE project_id = ${client.id} AND product = ${product}
  `;
  return true;
}

// Borra la conexión de ESTE proyecto (con su selección). Los demás no cambian.
export async function deleteMetaConnection(client: ClientConfig, product: MetaProduct): Promise<void> {
  if (!isDbConfigured()) return;
  await getSql()`
    DELETE FROM meta_project_connection WHERE project_id = ${client.id} AND product = ${product}
  `;
}

// Migración desde el modelo de una conexión por despliegue: copia esa conexión a
// cada proyecto con cuentas asignadas. Nunca pisa una conexión por proyecto ya
// hecha, así que correrla dos veces no hace nada. Devuelve los proyectos copiados.
export async function backfillProjectConnections(product: MetaProduct): Promise<string[]> {
  if (!isDbConfigured()) return [];
  const rows = (await getSql()`
    INSERT INTO meta_project_connection (
      project_id, product, token_encrypted, token_kind, token_expires_at,
      connected_by, available_accounts, account_ids, connected_at, updated_at
    )
    SELECT a.project_id, c.product, c.token_encrypted, c.token_kind, c.token_expires_at,
           c.connected_by, c.available_accounts, a.account_ids, c.connected_at, now()
      FROM meta_connection c
      JOIN meta_project_accounts a ON a.product = c.product
     WHERE c.product = ${product} AND jsonb_array_length(a.account_ids) > 0
    ON CONFLICT (project_id, product) DO NOTHING
    RETURNING project_id
  `) as { project_id: string }[];
  return rows.map((r) => r.project_id).sort();
}
```

- [ ] **Step 5: Crear la tabla y correr la verificación**

Run: `pnpm db:migrate`
Expected: `✅ meta_project_connection lista:` con sus 10 columnas, y la línea de copia. **En la base real esto copia la conexión `ads` a Lezgo Suite.** Es aditivo y el código desplegado no lee esa tabla, así que es seguro correrlo antes del deploy (y conviene hacerlo antes: si el código nuevo sale primero, Lezgo Suite se quedaría sin gasto hasta que corra la migración). Anotar los proyectos impresos.

Run: `pnpm verify:meta-connection-store`
Expected: PASS (`✅ verify:meta-connection-store OK`).

- [ ] **Step 6: Commit**

```bash
git add lib/meta-connection-store.ts scripts/db-migrate.ts scripts/verify-meta-connection-store.ts
git commit -m "feat(meta): conexión por proyecto en el store + migración

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Rutas y sync leen la conexión del proyecto

**Files:**
- Modify: `app/api/meta/connect/route.ts`
- Modify: `app/api/meta/callback/route.ts`
- Modify: `app/api/meta/connection/route.ts`
- Modify: `lib/sync.ts:29` (import) y `lib/sync.ts:~672-688` (lectura Meta)
- Modify: `lib/meta-admin.ts` (comentario)

**Interfaces:**
- Consumes: todo lo de "Produces" de las Tasks 1 y 2; `requireClient()` / `unauthorized()` de `@/lib/session`.

- [ ] **Step 1: `connect` firma el proyecto**

En `app/api/meta/connect/route.ts`: agregar `import { requireClient, unauthorized } from "@/lib/session";`, y justo después de `if (!scope) return forbidden();`:

```ts
  const client = await requireClient();
  if (!client) return unauthorized();
```

Cambiar la firma del state:

```ts
  const state = await signState({ scopeId: scope.id, projectId: client.id, product: "ads", returnTo: "/" });
```

Comentario de cabecera, líneas 2-4:

```ts
// Arranca el OAuth con Meta para EL PROYECTO DE LA SESIÓN: firma un state con el
// alcance y el proyecto y redirige al diálogo de Facebook Login for Business.
// Solo el alcance `all`.
```

- [ ] **Step 2: `callback` exige el proyecto y guarda en él**

En `app/api/meta/callback/route.ts`: agregar `import { requireClient, unauthorized } from "@/lib/session";`. Después de `if (!scope) return forbidden();`:

```ts
  const client = await requireClient();
  if (!client) return unauthorized();
```

Reemplazar la condición del state:

```ts
  // El state tiene que ser del alcance logueado (y ese alcance, `all`) y del
  // proyecto que la sesión tiene abierto AHORA: si en otra pestaña se cambió de
  // proyecto a mitad del diálogo, no se guarda nada en ninguno.
  if (
    !state ||
    state.scopeId !== scope.id ||
    state.projectId !== client.id ||
    state.product !== "ads"
  )
    return fail("state_invalid");
```

Reemplazar la escritura:

```ts
    await writeMetaConnection(client, "ads", {
      token,
      tokenKind: info.type === "SYSTEM_USER" || info.expiresAt === null ? "system_user" : "user",
      tokenExpiresAt: info.expiresAt,
      connectedBy: me.name || null,
      availableAccounts: accounts,
    });
```

Cabecera, líneas 2-5:

```ts
// El regreso del diálogo de Meta. Verifica el state (alcance + proyecto), canjea
// el code, averigua qué clase de token es, lista las cuentas concedidas y guarda
// la fila DEL PROYECTO DE LA SESIÓN. Cualquier falla regresa al panel con
// ?meta=error&reason=… y NO deja nada guardado.
```

- [ ] **Step 3: `connection` GET/DELETE por proyecto**

En `app/api/meta/connection/route.ts`, el import queda:

```ts
import { readMetaConnection, deleteMetaConnection } from "@/lib/meta-connection-store";
```

En `GET`, reemplazar el bloque `let conn; let selected; try {...}` por:

```ts
  let conn;
  try {
    conn = await readMetaConnection(client, "ads");
  } catch (err) {
    console.error("[meta] no se pudo leer la conexión:", err);
    return Response.json({ connected: false, canManage, reason: "no_db" });
  }
```

y `const sel = new Set(selected);` por `const sel = new Set(conn.accountIds);`.

`DELETE` completo:

```ts
export async function DELETE() {
  if (!(await requireMetaAdmin())) return forbidden();
  const client = await requireClient();
  if (!client) return unauthorized();
  try {
    await deleteMetaConnection(client, "ads");
  } catch (err) {
    console.error("[meta] no se pudo desconectar:", err);
    return Response.json({ error: "db" }, { status: 503 });
  }
  return new Response(null, { status: 204 });
}
```

Cabecera: agregar al final del comentario `// Todo es del proyecto de la sesión: cada proyecto tiene su propia conexión.`

`app/api/meta/accounts/route.ts` no cambia de lógica (`writeProjectAccounts(client, "ads", ids)` ya tiene la firma correcta). Solo cambiar en su comentario "de las concedidas" por "de las que ve la conexión de este proyecto".

- [ ] **Step 4: El sync hace una lectura**

En `lib/sync.ts`, línea 29:

```ts
import { readMetaConnectionWithToken } from "@/lib/meta-connection-store";
```

Reemplazar el `const [metaConn, metaAccountIds] = await Promise.all([...]);` por:

```ts
      const metaConn = await readMetaConnectionWithToken(client, "ads").catch((err) => {
        console.error("[meta] no se pudo leer la conexión, se sincroniza sin Meta:", err);
        return null;
      });
      const metaAccountIds = metaConn?.accountIds ?? [];
```

En el comentario de la línea "Una cuenta asignada que la conexión ya no ve (otra empresa, o se dejó de compartir)", cambiar a: `// Una cuenta elegida que el token de este proyecto ya no ve (quien conectó perdió acceso) cuenta como fallida: la píldora la nombra.`

- [ ] **Step 5: Comentario de `meta-admin.ts`**

Reemplazar las líneas 2-5:

```ts
// Quién puede tocar la conexión con Meta de un proyecto: SOLO una sesión del
// alcance `all`. Los alcances de agencia (domus, iw) ven el gasto de sus
// proyectos, pero no conectan, reconectan, desconectan ni asignan cuentas:
// conectar ata el Facebook de una persona de Lezgo al proyecto.
```

- [ ] **Step 6: Typecheck y verificaciones**

Run: `npx tsc --noEmit`
Expected: sin errores. Si queda alguno en otro consumidor de `readProjectAccounts` o `businessId`, corregirlo con la misma regla (`conn.accountIds`, sin `businessId`).

Run: `pnpm verify:meta-oauth && pnpm verify:meta-connection-store && pnpm verify:meta && pnpm verify:meta-attribution && pnpm verify:paid-performance`
Expected: todos `✅`.

- [ ] **Step 7: Probar con la app real**

Run: `pnpm dev`. Entrar con la contraseña de `all`, abrir **Lezgo Suite** y pulsar **Actualizar** (`?fresh=1`).
Expected: la píldora dice "Meta · 1 cuenta" y la sección "Inversión en pauta" muestra gasto. Esa fila llegó por el backfill de la Task 2. Abrir **Condesa**: la píldora dice "Conectar con Meta" (localhost no completa el OAuth, eso es esperado). Detener el dev server.

- [ ] **Step 8: Commit**

```bash
git add app/api/meta lib/sync.ts lib/meta-admin.ts
git commit -m "feat(meta): rutas y sync usan la conexión del proyecto

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Píldora por proyecto y aviso de caducidad

**Files:**
- Create: `lib/meta-expiry.ts`
- Modify: `scripts/verify-meta-oauth.ts` (agrega aserciones de caducidad)
- Modify: `components/dashboard/meta-connection.tsx`

**Interfaces:**
- Produces: `EXPIRY_WARNING_DAYS = 14`; `tokenExpiryDays(expiresAt: string | null, now?: number): number | null`, días enteros hacia arriba hasta la caducidad (≤ 0 si ya caducó, `null` sin fecha o fecha inválida).

- [ ] **Step 1: Write the failing test**

Al final de `main()` en `scripts/verify-meta-oauth.ts`, antes del `console.log("✅ …")`:

```ts
  // --- caducidad de un token de usuario (plan B)
  const t0 = Date.parse("2026-10-07T12:00:00Z");
  assert.equal(tokenExpiryDays(null, t0), null, "usuario del sistema: no caduca");
  assert.equal(tokenExpiryDays("no-es-fecha", t0), null);
  assert.equal(tokenExpiryDays("2026-10-21T12:00:00Z", t0), 14);
  assert.equal(tokenExpiryDays("2026-10-21T11:00:00Z", t0), 14, "redondea hacia arriba");
  assert.equal(tokenExpiryDays("2026-10-07T13:00:00Z", t0), 1, "caduca hoy más tarde = 1");
  assert.ok((tokenExpiryDays("2026-10-04T12:00:00Z", t0) ?? 1) <= 0, "caducado → ≤ 0");
  assert.equal(EXPIRY_WARNING_DAYS, 14);
```

E importar arriba: `import { tokenExpiryDays, EXPIRY_WARNING_DAYS } from "../lib/meta-expiry";`

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm verify:meta-oauth`
Expected: FAIL — `Cannot find module '../lib/meta-expiry'`.

- [ ] **Step 3: Write minimal implementation**

`lib/meta-expiry.ts`:

```ts
// lib/meta-expiry.ts
// Cuándo caduca el token de Meta de un proyecto. Puro y sin imports: lo usa la
// píldora en el navegador, que no debe arrastrar lib/meta-oauth (y con él
// lib/auth) al bundle. Un token de usuario del sistema no caduca (null); uno de
// usuario dura ~60 días y la píldora avisa a partir de EXPIRY_WARNING_DAYS.

export const EXPIRY_WARNING_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Días enteros (hacia arriba) hasta la caducidad; ≤ 0 si ya caducó; null sin fecha. */
export function tokenExpiryDays(expiresAt: string | null, now: number = Date.now()): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  if (Number.isNaN(t)) return null;
  return Math.ceil((t - now) / DAY_MS);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm verify:meta-oauth`
Expected: PASS.

- [ ] **Step 5: Textos por proyecto en la píldora**

En `components/dashboard/meta-connection.tsx`:

Import: `import { EXPIRY_WARNING_DAYS, tokenExpiryDays } from "@/lib/meta-expiry"`

`ERROR_COPY`, dos entradas:

```ts
  state_invalid: "La conexión expiró o cambiaste de proyecto. Inténtalo de nuevo.",
  no_accounts: "Ese Facebook no ve ninguna cuenta publicitaria.",
```

Confirmación de `disconnect`:

```ts
        "¿Desconectar Meta de este proyecto? Su gasto dejará de actualizarse y se olvidan sus cuentas elegidas. Los demás proyectos no cambian. Esto no revoca el acceso en Meta; eso se hace desde el Business Manager."
```

Texto de cuentas fallidas:

```tsx
              Sin respuesta: {failedIds.join(", ")}. Quien conectó ya no ve esa cuenta: reconecta con alguien que sí tenga acceso.
```

`DialogDescription`:

```tsx
              De las cuentas que ve quien conectó este proyecto, elige cuáles alimentan su gasto. Sin
              ninguna, el proyecto no muestra gasto. Para ver otras cuentas, reconecta con un Facebook que
              tenga acceso a ellas.
```

Comentario de cabecera (línea 2-3): `// La píldora "Meta" del header: conectar ESTE proyecto, ver el estado, elegir sus cuentas, reconectar o desconectar.`

- [ ] **Step 6: Aviso de caducidad**

Debajo de `const failedIds = …`:

```ts
  const expiryDays = state?.connected ? tokenExpiryDays(state.tokenExpiresAt) : null
  const expiring = !revoked && expiryDays !== null && expiryDays <= EXPIRY_WARNING_DAYS
```

`tone`: insertar `expiring` como segunda condición, con el mismo ámbar:

```ts
  const tone = revoked
    ? "border-red-400/60 text-red-200"
    : failedIds.length > 0 || expiring
      ? "border-[#F59B1B]/70 text-[#F59B1B]"
      : selected.length === 0
        ? "text-white/60"
        : ""
```

`label`: después de la rama `revoked`:

```ts
    : expiring
      ? expiryDays! <= 0
        ? "Meta · token caducado"
        : `Meta · caduca en ${expiryDays} ${expiryDays === 1 ? "día" : "días"}`
```

(dejando las ramas de `failedIds` / `selected` como siguen). El ícono: `{revoked || failedIds.length > 0 || expiring ? <AlertTriangle …/> : <Check …/>}`.

Reemplazar el párrafo `{state.tokenExpiresAt && (…)}` por:

```tsx
          {state.tokenExpiresAt && (
            <p className={`px-2 py-1 text-xs ${expiring ? "text-[#B86E0A] dark:text-[#F59B1B]" : "text-muted-foreground"}`}>
              Token de usuario: {expiryDays !== null && expiryDays <= 0 ? "caducó" : "caduca"} el{" "}
              {new Date(state.tokenExpiresAt).toLocaleDateString("es-MX")}.
              {expiring ? " Reconecta para que el gasto siga actualizándose." : ""}
            </p>
          )}
```

Y el botón: cuando `revoked || expiring`, "Reconectar" va como botón primario arriba. Cambiar la condición `{revoked ? (` por `{revoked || expiring ? (`, y en esa rama dejar también el botón de cuentas cuando no está revocado:

```tsx
          {revoked || expiring ? (
            <>
              <Button variant="default" size="sm" className="w-full justify-start" asChild>
                <a href="/api/meta/connect">Reconectar</a>
              </Button>
              {!revoked && (
                <Button variant="ghost" size="sm" className="w-full justify-start" onClick={openDialog}>
                  {selected.length === 0 ? "Elegir cuenta de este proyecto" : "Cambiar cuentas de este proyecto"}
                </Button>
              )}
            </>
          ) : (
```

y en la rama normal cambiar "Asignar cuenta a este proyecto" por "Elegir cuenta de este proyecto".

- [ ] **Step 7: Typecheck y prueba visual**

Run: `npx tsc --noEmit`
Expected: sin errores.

Run: `pnpm dev`, abrir Lezgo Suite y abrir la píldora.
Expected: "Conectado por …", "Cambiar cuentas de este proyecto", "Reconectar" y "Desconectar". La confirmación de Desconectar habla de "este proyecto". **Pulsar Cancelar.** Para ver el aviso de caducidad sin tocar datos, en DevTools → Network → override de `/api/meta/connection` con `tokenKind: "user"` y `tokenExpiresAt` a 5 días: la píldora queda ámbar con "Meta · caduca en 5 días" y Reconectar primario. Detener el dev server.

- [ ] **Step 8: Commit**

```bash
git add lib/meta-expiry.ts scripts/verify-meta-oauth.ts components/dashboard/meta-connection.tsx
git commit -m "feat(meta): la píldora habla del proyecto y avisa antes de que caduque el token

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Documentación y verificación final

**Files:**
- Modify: `CLAUDE.md` (líneas ~17, ~36-38, ~106-110 y bloque "### Meta Ads" ~468-486 y la viñeta "Conectado en producción…")
- Modify: `package.json` no hace falta (los scripts ya existen).

- [ ] **Step 1: `CLAUDE.md`, comandos**

Línea de `pnpm db:migrate`:

```
pnpm db:migrate # Crea/verifica project_sync, meta_connection, meta_project_accounts, meta_project_connection
                #   y opportunity_milestones en Neon, y copia la conexión vieja de Meta a los proyectos
                #   con cuentas asignadas. Idempotente.
```

Líneas de `verify:meta-oauth` y `verify:meta-connection-store`:

```
pnpm verify:meta-oauth   # lib/meta-oauth.ts + lib/meta-expiry.ts — state firmado por alcance Y proyecto,
                         #   cifrado del token, URL del diálogo, días para caducar
pnpm verify:meta-connection-store # lib/meta-connection-store.ts — una conexión por proyecto (aislamiento,
                         #   autoselección, reconexión conserva cuentas, backfill); producto sintético
```

- [ ] **Step 2: `CLAUDE.md`, sección Meta Ads**

Agregar a la línea de specs: `Conexión por proyecto: docs/superpowers/specs/2026-10-07-meta-conexion-por-proyecto-design.md.`

Reemplazar la viñeta **"Una conexión por despliegue, cuentas por proyecto."** completa por:

```markdown
- **Una conexión por proyecto** (2026-10-07). `meta_project_connection`, PK
  `(project_id, product)`: token cifrado, `available_accounts` (lo que ese token ve) y
  `account_ids` (lo que el proyecto mira) en una fila. Conecta **una persona de Lezgo que
  ya entra a la cuenta publicitaria del cliente con su propio Facebook**, desde ese
  proyecto: nada de compartir cuentas al portafolio de Lezgo ni asignarlas a un usuario
  del sistema. Con una sola cuenta visible se elige sola; reconectar conserva la
  selección. **No es desechable.** `meta_connection` / `meta_project_accounts` son el
  modelo anterior: ya nadie las lee, y `db:migrate` copió su conexión a los proyectos con
  asignación (`backfillProjectConnections`).
```

En **"Solo el alcance `all` administra"**: después de "El `state` del OAuth lleva el `scopeId` firmado" insertar "y el `projectId`", y después de "y el de la sesión" insertar ", y su proyecto el que la sesión tiene abierto (un OAuth iniciado en Condesa no se guarda en Yconia)".

En **"Por qué funciona sin App Review"**, reemplazar "Quien conecta es admin de la app, así que basta. Un "Conectar" por proyecto con el admin del BM de una agencia NO funcionaría hoy." por:

```markdown
  Por eso **quien conecta cada proyecto necesita rol en la app** (admin/developer/tester;
  a una persona nueva de Lezgo se le agrega una vez). Que el cliente o su agencia conecte
  con su propio Facebook NO funciona hasta pasar App Review por Advanced `ads_read`
  (revisado otra vez el 2026-10-07: el envío sigue `UNSUBMITTED`).
```

En la viñeta **"Conectado en producción el 2026-09-14"**, reemplazar desde "Al conectar, la empresa solo compartió esa cuenta:" hasta el final de la viñeta por:

```markdown
  Esa conexión se copió a Lezgo Suite al migrar a conexión por proyecto. Los demás
  proyectos se conectan desde su propia píldora.
- **Tipo de token por probar.** La config de Login (`META_LOGIN_CONFIG_ID`) emite tokens
  de usuario del sistema; con un proyecto de cliente, el usuario del sistema se crearía en
  el portafolio del cliente, y no está verificado que Meta lo permita con acceso Standard.
  Si el diálogo regresa sin cuentas, el plan B es una segunda config con **token de
  usuario** (`ads_read`) y cambiar `META_LOGIN_CONFIG_ID` en Vercel: dura ~60 días y la
  píldora avisa desde 14 días antes (`lib/meta-expiry.ts`).
```

- [ ] **Step 3: Verificación completa**

Run:

```bash
npx tsc --noEmit && pnpm verify:meta-oauth && pnpm verify:meta-connection-store && pnpm verify:meta && pnpm verify:meta-attribution && pnpm verify:paid-performance && pnpm verify:scopes && pnpm verify:auth
```

Expected: sin errores de TS y todos `✅`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(meta): conexión por proyecto en CLAUDE.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Después del deploy (lo hace el usuario o con su OK)**

1. Confirmar que `pnpm db:migrate` ya corrió contra producción (Task 2, Step 5). Si no, correrlo **antes** de que el deploy quede activo.
2. En `proyectos.lezgosuite.com`, abrir Lezgo Suite → Actualizar → el gasto sigue ahí.
3. Abrir Condesa → "Conectar con Meta" con un Facebook de Lezgo que vea la cuenta de Condesa (y que tenga rol en la app).
   - **Regresa con cuentas:** elegirlas y comprobar el gasto. El riesgo del tipo de token queda resuelto, plan A.
   - **Regresa con "Ese Facebook no ve ninguna cuenta publicitaria" o error:** plan B (crear config con token de usuario en developers.facebook.com, cambiar `META_LOGIN_CONFIG_ID` en Vercel, redeploy, repetir).
