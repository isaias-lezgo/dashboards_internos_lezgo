// Verificación de lib/meta-oauth.ts. Correr: pnpm verify:meta-oauth
//
// El `state` del OAuth lleva el id del cliente; si se pudiera manipular, el
// callback guardaría el token de la empresa de A en la fila de B. Por eso este
// script ejercita el rechazo de un state manipulado igual que verify:auth
// ejercita la cookie.
//
// Envuelto en main() en vez de usar await de nivel superior: este paquete es CJS.
import assert from "node:assert/strict";

process.env.DASHBOARD_AUTH_SECRET = "test-secret-do-not-use-in-prod";

import {
  signState,
  verifyState,
  encryptToken,
  decryptToken,
  buildDialogUrl,
  redirectUriFor,
  STATE_MAX_AGE_MS,
  OAUTH_COOKIE,
} from "../lib/meta-oauth";

async function main() {
  const now = 1_800_000_000_000;

  // --- state: ida y vuelta
  const state = await signState({ scopeId: "all", product: "ads", returnTo: "/" }, now);
  const back = await verifyState(state, now + 1000);
  assert.ok(back, "un state recién firmado verifica");
  assert.equal(back.scopeId, "all");
  assert.equal(back.product, "ads");
  assert.equal(back.returnTo, "/");
  assert.equal(back.iat, now);
  assert.equal(typeof back.nonce, "string");
  assert.ok(back.nonce.length >= 16, "el nonce tiene entropía");

  // --- dos firmas del mismo input difieren (nonce), y ambas verifican
  const state2 = await signState({ scopeId: "all", product: "ads", returnTo: "/" }, now);
  assert.notEqual(state, state2);
  assert.ok(await verifyState(state2, now));

  // --- LA GARANTÍA DE AISLAMIENTO: cambiar el scopeId dentro del payload invalida la firma
  const [payloadB64, sig] = state.split(".");
  const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  const forged = Buffer.from(JSON.stringify({ ...payload, scopeId: "domus" }), "utf8").toString("base64url");
  assert.equal(await verifyState(`${forged}.${sig}`, now), null, "state con scopeId ajeno (domus) se rechaza");

  // --- firma alterada
  assert.equal(await verifyState(`${payloadB64}.deadbeef`, now), null);
  // --- formatos rotos
  assert.equal(await verifyState(undefined, now), null);
  assert.equal(await verifyState("", now), null);
  assert.equal(await verifyState("sin.punto.extra.x", now), null);
  assert.equal(await verifyState("no-es-base64.sig", now), null);
  // --- expirado
  assert.equal(await verifyState(state, now + STATE_MAX_AGE_MS + 1), null, "state viejo se rechaza");
  assert.ok(await verifyState(state, now + STATE_MAX_AGE_MS - 1), "justo antes del límite sigue válido");
  // --- del futuro (reloj adelantado del emisor): se rechaza también
  assert.equal(await verifyState(state, now - 60_000), null);

  // --- token: ida y vuelta con bytes
  const blob = await encryptToken("EAAB-token-de-prueba-ñ");
  assert.ok(blob instanceof Uint8Array);
  assert.ok(blob.length > 12 + 16, "iv + tag + cuerpo");
  assert.equal(await decryptToken(blob), "EAAB-token-de-prueba-ñ");
  // --- dos cifrados del mismo texto difieren (iv aleatorio)
  const blob2 = await encryptToken("EAAB-token-de-prueba-ñ");
  assert.notDeepEqual(Buffer.from(blob), Buffer.from(blob2));
  // --- un bit alterado no descifra (GCM autentica)
  const tampered = new Uint8Array(blob);
  tampered[tampered.length - 1] ^= 0x01;
  assert.equal(await decryptToken(tampered), null);
  // --- blob corto
  assert.equal(await decryptToken(new Uint8Array(5)), null);
  // --- otra llave no descifra
  process.env.DASHBOARD_AUTH_SECRET = "otra-llave";
  assert.equal(await decryptToken(blob), null);
  process.env.DASHBOARD_AUTH_SECRET = "test-secret-do-not-use-in-prod";

  // --- URL del diálogo: config_id, sin scope
  const url = new URL(
    buildDialogUrl({
      appId: "123",
      configId: "456",
      redirectUri: "https://proyectos.lezgosuite.com/api/meta/callback",
      state: "abc.def",
    })
  );
  assert.equal(url.origin + url.pathname, "https://www.facebook.com/v23.0/dialog/oauth");
  assert.equal(url.searchParams.get("client_id"), "123");
  assert.equal(url.searchParams.get("config_id"), "456");
  assert.equal(url.searchParams.get("redirect_uri"), "https://proyectos.lezgosuite.com/api/meta/callback");
  assert.equal(url.searchParams.get("state"), "abc.def");
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), null, "con Login for Business el scope lo define la configuración");

  // --- redirect_uri: el origen público manda; si no hay, el de la petición
  assert.equal(
    redirectUriFor("http://localhost:3000/api/meta/connect?x=1", "https://proyectos.lezgosuite.com"),
    "https://proyectos.lezgosuite.com/api/meta/callback"
  );
  assert.equal(
    redirectUriFor("http://localhost:3000/api/meta/connect", undefined),
    "http://localhost:3000/api/meta/callback"
  );
  assert.equal(
    redirectUriFor("https://dashboards-internos-lezgo.vercel.app/api/meta/callback?code=1", ""),
    "https://dashboards-internos-lezgo.vercel.app/api/meta/callback"
  );

  // --- el nombre de la cookie del nonce es un contrato entre connect y callback
  assert.equal(OAUTH_COOKIE, "meta_oauth");

  console.log("✅ verify:meta-oauth OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
