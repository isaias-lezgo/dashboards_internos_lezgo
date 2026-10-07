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
  await sql`CREATE TABLE IF NOT EXISTS meta_backfill (product text PRIMARY KEY, done_at timestamptz NOT NULL)`;
  await sql`DELETE FROM meta_backfill WHERE product = ${P}`;
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

  // --- un "Desconectar" posterior NO se deshace al volver a correr db:migrate:
  // la copia corre una sola vez por producto
  await deleteMetaConnection(C, P);
  assert.deepEqual(await backfillProjectConnections(P), [], "tras desconectar C, la copia no lo resucita");
  assert.equal(await readMetaConnection(C, P), null);

  await cleanup();
  console.log("✅ verify:meta-connection-store OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
