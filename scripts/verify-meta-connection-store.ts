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
