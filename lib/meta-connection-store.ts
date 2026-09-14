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
