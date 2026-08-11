// Verification for lib/auth.ts. Run: npm run verify:auth
//
// Wrapped in main() rather than using top-level await: this package is CJS
// ("type" is not "module"), so tsx compiles to CJS where TLA is unavailable.
import assert from "node:assert/strict";

process.env.DASHBOARD_AUTH_SECRET = "test-secret-do-not-use-in-prod";

import { signToken, verifyToken, ACCESS_COOKIE, PROJECT_COOKIE } from "../lib/auth";

const HOUR = 60 * 60 * 1000;

async function main() {
  // --- round trip: an arbitrary payload survives sign → verify.
  // The payload is a project id on dash_project and an ACCESS SCOPE id on dash_access.
  const token = await signToken("yconia", Date.now() + HOUR);
  assert.equal(await verifyToken(token), "yconia");

  const access = await signToken("all", Date.now() + HOUR);
  assert.equal(await verifyToken(access), "all");

  // --- the token is dot-delimited: payload.expiry.signature
  assert.equal(token.split(".").length, 3, "token must have exactly 3 segments");
  assert.ok(token.startsWith("yconia."), "payload must be the first segment");

  // --- THE ISOLATION GUARANTEE: swapping the payload invalidates the signature.
  // On dash_project this is what stops a hand-edited cookie from pointing at
  // another project; on dash_access it stops a forged scope from being minted.
  const [, expiry, sig] = token.split(".");
  assert.equal(await verifyToken(`condesa.${expiry}.${sig}`), null, "tampered project id must be rejected");
  assert.equal(await verifyToken(`all.${expiry}.${sig}`), null, "project token must not pass as an access token");

  const [, aExpiry, aSig] = access.split(".");
  assert.equal(await verifyToken(`yconia.${aExpiry}.${aSig}`), null, "access token must not pass as a project token");

  // --- other tampering
  assert.equal(await verifyToken(`yconia.${expiry}.deadbeef`), null, "bad signature rejected");
  assert.equal(await verifyToken(`yconia.${Number(expiry) + 1}.${sig}`), null, "tampered expiry rejected");

  // --- expiry is enforced
  const expired = await signToken("yconia", Date.now() - 1000);
  assert.equal(await verifyToken(expired), null, "expired token rejected");
  const expiredAccess = await signToken("all", Date.now() - 1000);
  assert.equal(await verifyToken(expiredAccess), null, "expired access token rejected");

  // --- malformed input
  assert.equal(await verifyToken(undefined), null);
  assert.equal(await verifyToken(""), null);
  assert.equal(await verifyToken("garbage"), null);
  assert.equal(await verifyToken("only.two"), null);
  assert.equal(await verifyToken("a.b.c.d"), null);
  assert.equal(await verifyToken(`.${expiry}.${sig}`), null, "empty payload rejected");

  // --- two projects get distinguishable tokens
  const a = await signToken("yconia", Date.now() + HOUR);
  const b = await signToken("condesa", Date.now() + HOUR);
  assert.equal(await verifyToken(a), "yconia");
  assert.equal(await verifyToken(b), "condesa");

  // --- the cookie names are distinct, so an access cookie can never be read as a project cookie
  assert.notEqual(ACCESS_COOKIE, PROJECT_COOKIE);

  // --- THE SCOPE GUARANTEE: a narrow access cookie cannot be widened by hand.
  // This is what stops someone holding a Domus session from editing their cookie to
  // "all" and seeing every project.
  const domusAccess = await signToken("domus", Date.now() + HOUR);
  assert.equal(await verifyToken(domusAccess), "domus");
  const [, dExpiry, dSig] = domusAccess.split(".");
  assert.equal(await verifyToken(`all.${dExpiry}.${dSig}`), null, "widening domus → all must be rejected");

  console.log("✅ lib/auth.ts — all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
