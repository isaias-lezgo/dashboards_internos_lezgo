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
