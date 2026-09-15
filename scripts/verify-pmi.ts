// Verification for lib/pmi-stages.ts and lib/pmi.ts. Run: pnpm verify:pmi
//
// Wrapped in main() rather than using top-level await: this package is CJS
// ("type" is not "module"), so tsx compiles to CJS where TLA is unavailable.
import assert from "node:assert/strict";
import {
  effectiveStage,
  milestonesOfStage,
  projectHasMilestoneStages,
} from "../lib/pmi-stages";
import type { Opportunity, Pipeline } from "../lib/types";

function opp(p: Partial<Opportunity>): Opportunity {
  return {
    id: "o1", name: "", pipelineId: "p", pipelineStageId: "s", status: "open",
    createdAt: "2026-09-01T12:00:00.000Z", contactId: "c1", value: 0,
    stage: "Lead Recibido", pipelineName: "Ventas", ...p,
  };
}

function stagesMain() {
  const has = (name: string, ...ms: string[]) =>
    assert.deepEqual([...milestonesOfStage(name)].sort(), [...ms].sort(), name);

  // Los cinco pipelines reales (cache 2026-09-15). "10." es Ganado en Yconia e
  // Inversión Futura en los demás: por eso se compara por NOMBRE.
  has("02. Cliente Calificado", "perfilado");
  has("03. Cita Agendada", "perfilado");
  has("04. Visita Al Desarrollo", "perfilado");        // Plaza Bosques, mayúscula
  has("04. Visita al Desarrollo", "perfilado");        // Yconia
  has("12. Inversión Futura", "perfilado");
  has("10. Inversión Futura", "perfilado");            // NO es cierre
  has("05. Cotización / Negociación", "perfilado");
  has("06. Apartado", "perfilado", "apartado");
  has("07. Pago de Mensualidades", "perfilado", "apartado");
  has("08. Proceso de Escritura", "perfilado", "apartado", "cierre");
  has("09. Siguiente Escritura", "perfilado", "apartado", "cierre");
  has("09. Negocio Ganado", "perfilado", "apartado", "cierre");
  has("10. Negocio Ganado", "perfilado", "apartado", "cierre");
  has("11. Entregado");                                // fuera del vocabulario, sin hitos
  has("Lead Recibido (Ventas)");
  has("1er Contacto");
  has("01. Contacto En Seguimiento");
  has("Last Call");
  has("Renta");
  has("Negocio Perdido");
  has("Primera Cita", "perfilado");                    // Lezgo Suite cae en "cita" — la
                                                       // pestaña se apaga por pipelines, abajo
  assert.equal(milestonesOfStage(null).size, 0);

  // effectiveStage: abierta → su etapa; perdida → "Última Etapa en el Pipeline"
  assert.equal(effectiveStage(opp({ stage: "06. Apartado" })), "06. Apartado");
  assert.equal(
    effectiveStage(opp({ status: "lost", stage: "Negocio Perdido",
      customFieldsResolved: { "Última Etapa en el Pipeline": "04. Visita al Desarrollo" } })),
    "04. Visita al Desarrollo",
  );
  assert.equal(
    effectiveStage(opp({ status: "lost", stage: "Negocio Perdido",
      customFieldsResolved: { "Última Etapa en el Pipeline": "Negocio Perdido" } })),
    null, "última etapa 'Negocio Perdido' no es una etapa",
  );
  assert.equal(effectiveStage(opp({ status: "lost", stage: "Negocio Perdido" })), null);
  // Etapa "Negocio Perdido" con status open (cuentas que no ponen status): también perdida
  assert.equal(
    effectiveStage(opp({ stage: "Negocio Perdido",
      customFieldsResolved: { "Última Etapa en el Pipeline": "02. Cliente Calificado" } })),
    "02. Cliente Calificado",
  );

  // projectHasMilestoneStages: Yconia sí, Lezgo Suite no
  const yconia: Pipeline[] = [{ id: "a", name: "Ventas", stages: ["Lead Recibido", "02. Cliente Calificado", "06. Apartado"] }];
  const lezgo: Pipeline[] = [{ id: "b", name: "Ventas", stages: ["Primera Cita", "Envío de propuesta", "Cliente Activo"] }];
  assert.equal(projectHasMilestoneStages(yconia), true);
  assert.equal(projectHasMilestoneStages(lezgo), false, "sin etapa de apartado no hay PMI");
  assert.equal(projectHasMilestoneStages([]), false);
}

async function main() {
  stagesMain();
  console.log("✅ verify:pmi — etapas");
}

main().catch((err) => { console.error(err); process.exit(1); });
