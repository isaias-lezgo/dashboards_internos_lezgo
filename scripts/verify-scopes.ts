// Verification for lib/scopes.ts. Run: pnpm verify:scopes
//
// The point of this script: a scope is a list of project ids typed by hand, and a
// typo there fails SILENTLY — the project simply stops appearing for that team.
// So the roster below mirrors production exactly, and every id a scope names is
// checked against it.
import assert from "node:assert/strict";
import { SCOPES, DOMUS_SCOPE_ID, getScope, scopeAllows } from "../lib/scopes";
import { parseClients } from "../lib/clients";

const ROSTER = JSON.stringify([
  { id: "lezgo-suite", name: "Lezgo Suite", locationId: "loc-1", ghlToken: "pit-1" },
  { id: "condesa", name: "Condesa Cimatario", locationId: "loc-2", ghlToken: "pit-2" },
  { id: "plaza-bosques", name: "Plaza Bosques / Meseta", locationId: "loc-3", ghlToken: "pit-3" },
  { id: "grand-center", name: "Grand Center", locationId: "loc-4", ghlToken: "pit-4" },
  { id: "balvanera", name: "Balvanera", locationId: "loc-5", ghlToken: "pit-5" },
  { id: "yconia", name: "Yconia", locationId: "loc-6", ghlToken: "pit-6" },
]);

// Same constraint as a project id: the scope id rides inside the dot-delimited
// dash_access token, so a dot would split the payload.
const ID_RE = /^[a-z0-9-]+$/;

const rosterIds = new Set(parseClients(ROSTER).map((c) => c.id));

// --- shape: ids cookie-safe and unique, labels and env names present
const seen = new Set<string>();
for (const scope of SCOPES) {
  assert.ok(ID_RE.test(scope.id), `scope id "${scope.id}" must be lowercase letters, digits and hyphens`);
  assert.ok(!scope.id.includes("."), `scope id "${scope.id}" must not contain a dot`);
  assert.ok(!seen.has(scope.id), `duplicate scope id "${scope.id}"`);
  seen.add(scope.id);
  assert.ok(scope.label.trim() !== "", `scope "${scope.id}" needs a label`);
  assert.ok(scope.passwordEnv.trim() !== "", `scope "${scope.id}" needs a passwordEnv`);
}

// --- every project a scope names must exist in the roster
for (const scope of SCOPES) {
  for (const id of scope.projectIds ?? []) {
    assert.ok(rosterIds.has(id), `scope "${scope.id}" names unknown project "${id}"`);
  }
}

// --- the domus scope: exactly three projects, and the other three are refused
const domus = getScope(DOMUS_SCOPE_ID);
if (!domus) throw new Error("the domus scope must exist");
assert.deepEqual(
  [...(domus.projectIds ?? [])].sort(),
  ["condesa", "plaza-bosques", "yconia"],
  "domus must be exactly these three projects",
);
for (const id of ["condesa", "yconia", "plaza-bosques"]) {
  assert.equal(scopeAllows(domus, id), true, `domus must allow ${id}`);
}
for (const id of ["grand-center", "balvanera", "lezgo-suite"]) {
  assert.equal(scopeAllows(domus, id), false, `domus must NOT allow ${id}`);
}

// --- the full scope allows anything, including a project added to the roster later
const all = getScope("all");
if (!all) throw new Error("the all scope must exist");
assert.equal(all.projectIds, null, "the full scope must be null, not a hand-kept copy of the roster");
for (const id of [...rosterIds, "un-proyecto-futuro"]) {
  assert.equal(scopeAllows(all, id), true, `all must allow ${id}`);
}

// --- unknown / missing ids resolve to nothing: getScope fails closed, which is what
// lets middleware treat "no scope" as "not authenticated".
assert.equal(getScope("no-existe"), null);
assert.equal(getScope(""), null);
assert.equal(getScope(null), null);
assert.equal(getScope(undefined), null);

console.log("✅ lib/scopes.ts — all assertions passed");
