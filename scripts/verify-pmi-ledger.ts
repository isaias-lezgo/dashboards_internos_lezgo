// Verification for lib/pmi-ledger.ts (+ store). Run: pnpm verify:pmi-ledger
//
// La bitácora es la única tabla del panel con historia que no se reconstruye
// desde GHL: un bug aquí borra o inventa la fecha de un apartado. Las
// aserciones puras corren siempre; el roundtrip contra Postgres solo con
// DATABASE_URL, con ids __verify_* que el roster no puede producir.
//
// Wrapped in main() rather than using top-level await: this package is CJS
// ("type" is not "module"), so tsx compiles to CJS where TLA is unavailable.
import assert from "node:assert/strict";
import { reconcileMilestones, type MilestoneRow } from "../lib/pmi-ledger";
import type { Opportunity } from "../lib/types";
import { readMilestones, insertMilestones, deleteMilestonesForVerify } from "../lib/pmi-ledger-store";
import type { ClientConfig } from "../lib/clients";

// Ids que el roster no puede producir: ID_RE prohíbe guiones bajos.
const A: ClientConfig = { id: "__verify_pmi_a", name: "A", locationId: "loc-a", ghlToken: "pit-a" };
const B: ClientConfig = { id: "__verify_pmi_b", name: "B", locationId: "loc-b", ghlToken: "pit-b" };

function opp(p: Partial<Opportunity>): Opportunity {
  return {
    id: "o1", name: "", pipelineId: "p", pipelineStageId: "s", status: "open",
    createdAt: "2026-08-01T12:00:00.000Z", updatedAt: "2026-08-20T12:00:00.000Z",
    contactId: "c1", value: 0, stage: "Lead Recibido", pipelineName: "Ventas", ...p,
  };
}

const NOW = new Date("2026-09-15T18:00:00.000Z");
const NOW_ISO = NOW.toISOString();

function pureMain() {
  // 1. Bitácora vacía = primera vez: todo hito vale updatedAt y va estimado.
  {
    const { inserts, byOpportunity } = reconcileMilestones(
      [],
      [opp({ id: "a", stage: "08. Proceso de Escritura" }), opp({ id: "b", stage: "Lead Recibido" })],
      NOW,
    );
    assert.deepEqual(
      inserts.map((r) => [r.opportunityId, r.milestone, r.reachedAt, r.estimated]).sort(),
      [
        ["a", "apartado", "2026-08-20T12:00:00.000Z", true],
        ["a", "cierre", "2026-08-20T12:00:00.000Z", true],
        ["a", "perfilado", "2026-08-20T12:00:00.000Z", true],
      ],
    );
    assert.deepEqual(byOpportunity.get("a"), {
      perfilado: "2026-08-20T12:00:00.000Z", apartado: "2026-08-20T12:00:00.000Z",
      cierre: "2026-08-20T12:00:00.000Z", estimated: true,
    });
    assert.equal(byOpportunity.has("b"), false, "sin hitos no hay entrada");
  }

  // 1b. Sin updatedAt cae a createdAt.
  {
    const { inserts } = reconcileMilestones([], [opp({ id: "a", stage: "06. Apartado", updatedAt: undefined })], NOW);
    assert.ok(inserts.every((r) => r.reachedAt === "2026-08-01T12:00:00.000Z" && r.estimated));
  }

  // 2. Con filas existentes solo se insertan los hitos nuevos, fechados en `now`.
  {
    const existing: MilestoneRow[] = [
      { opportunityId: "a", milestone: "perfilado", reachedAt: "2026-09-02T10:00:00.000Z", estimated: false },
    ];
    const { inserts, byOpportunity } = reconcileMilestones(
      existing, [opp({ id: "a", stage: "06. Apartado" })], NOW,
    );
    assert.deepEqual(inserts, [{ opportunityId: "a", milestone: "apartado", reachedAt: NOW_ISO, estimated: false }]);
    assert.deepEqual(byOpportunity.get("a"), { perfilado: "2026-09-02T10:00:00.000Z", apartado: NOW_ISO });
  }

  // 3. Un hito nunca se retira: retrocedió a seguimiento, el apartado sigue.
  {
    const existing: MilestoneRow[] = [
      { opportunityId: "a", milestone: "perfilado", reachedAt: "2026-09-02T10:00:00.000Z", estimated: false },
      { opportunityId: "a", milestone: "apartado", reachedAt: "2026-09-05T10:00:00.000Z", estimated: false },
    ];
    const { inserts, byOpportunity } = reconcileMilestones(
      existing, [opp({ id: "a", stage: "01. Contacto En Seguimiento" })], NOW,
    );
    assert.equal(inserts.length, 0);
    assert.equal(byOpportunity.get("a")?.apartado, "2026-09-05T10:00:00.000Z");
  }

  // 4. Perdida con última etapa cualificada: hitos por esa etapa.
  {
    const { inserts } = reconcileMilestones(
      [{ opportunityId: "z", milestone: "perfilado", reachedAt: "2026-01-01T00:00:00.000Z", estimated: false }],
      [opp({ id: "a", status: "lost", stage: "Negocio Perdido",
        customFieldsResolved: { "Última Etapa en el Pipeline": "06. Apartado" } })],
      NOW,
    );
    assert.deepEqual(inserts.map((r) => r.milestone).sort(), ["apartado", "perfilado"]);
    assert.ok(inserts.every((r) => r.reachedAt === NOW_ISO && !r.estimated));
  }

  // 5. Filas de oportunidades que ya no existen en el payload no rompen nada ni
  //    aparecen en byOpportunity (la bitácora guarda historia, el payload el presente).
  {
    const { inserts, byOpportunity } = reconcileMilestones(
      [{ opportunityId: "gone", milestone: "cierre", reachedAt: "2026-01-01T00:00:00.000Z", estimated: false }],
      [opp({ id: "a", stage: "Lead Recibido" })],
      NOW,
    );
    assert.equal(inserts.length, 0);
    assert.equal(byOpportunity.size, 0);
  }

  // 6. `estimated` en byOpportunity solo si ALGÚN hito lo es.
  {
    const { byOpportunity } = reconcileMilestones(
      [{ opportunityId: "a", milestone: "perfilado", reachedAt: "2026-06-01T00:00:00.000Z", estimated: true }],
      [opp({ id: "a", stage: "06. Apartado" })],
      NOW,
    );
    assert.equal(byOpportunity.get("a")?.estimated, true);
  }
}

async function dbMain() {
  if (!process.env.DATABASE_URL) {
    console.log("ℹ️  DATABASE_URL no está: se omite el roundtrip contra Postgres");
    return;
  }
  await deleteMilestonesForVerify(A.id);
  await deleteMilestonesForVerify(B.id);
  try {
    assert.deepEqual(await readMilestones(A), [], "proyecto sin filas");

    const rows: MilestoneRow[] = [
      { opportunityId: "o1", milestone: "perfilado", reachedAt: "2026-09-02T10:00:00.000Z", estimated: false },
      { opportunityId: "o1", milestone: "apartado", reachedAt: "2026-09-05T10:00:00.000Z", estimated: true },
    ];
    await insertMilestones(A, rows);
    await insertMilestones(B, [{ opportunityId: "o1", milestone: "cierre", reachedAt: "2026-09-09T10:00:00.000Z", estimated: false }]);

    const a = (await readMilestones(A)).sort((x, y) => x.milestone.localeCompare(y.milestone));
    assert.deepEqual(a, [rows[1], rows[0]], "roundtrip A, por proyecto");
    assert.deepEqual((await readMilestones(B)).map((r) => r.milestone), ["cierre"], "B no ve las filas de A");

    // Reinsertar la misma llave con otra fecha NO cambia nada: la primera vez manda.
    await insertMilestones(A, [{ opportunityId: "o1", milestone: "perfilado", reachedAt: "2026-09-14T00:00:00.000Z", estimated: false }]);
    const again = (await readMilestones(A)).find((r) => r.milestone === "perfilado");
    assert.equal(again?.reachedAt, "2026-09-02T10:00:00.000Z", "ON CONFLICT DO NOTHING");

    await insertMilestones(A, []); // vacío no falla
  } finally {
    await deleteMilestonesForVerify(A.id);
    await deleteMilestonesForVerify(B.id);
  }
  console.log("✅ verify:pmi-ledger — roundtrip Postgres");
}

async function main() {
  pureMain();
  console.log("✅ verify:pmi-ledger — reconciliación pura");
  await dbMain();
}

main().catch((err) => { console.error(err); process.exit(1); });
