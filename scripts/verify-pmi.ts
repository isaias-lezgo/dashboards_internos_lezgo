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
import type { Opportunity, Pipeline, Contact, Appointment } from "../lib/types";
import {
  monthWeeks, monthDays, semaphore, conversions, collectEvents, emptyCounts, addEvent, sumCounts,
  PMI_OBJECTIVES, scaleObjectives, UNASSIGNED,
} from "../lib/pmi";

const pad = (n: number) => String(n).padStart(2, "0");

function contact(p: Partial<Contact>): Contact {
  return { id: "c1", name: "", email: "", phone: "", tags: [], dateAdded: "2026-09-01T12:00:00.000Z",
    createdAt: "2026-09-01T12:00:00.000Z", ...p };
}
function appt(p: Partial<Appointment>): Appointment {
  return { id: "ap1", contactId: "c1", startTime: "2026-09-08T16:00:00-06:00", endTime: "2026-09-08T17:00:00-06:00",
    status: "showed", ...p };
}

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
  has("11. Entregado", "perfilado", "apartado", "cierre"); // entregado = cerrado y escriturado
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

function engineMain() {
  // Semanas del PMI: lunes a domingo recortadas al mes; un pedazo de menos de
  // 4 días se pega a la semana vecina. Los tres meses reales de los archivos.
  const labels = (m: string) => monthWeeks(m).map((w) => w.label);
  assert.deepEqual(labels("2026-09"), ["1 - 6", "7 - 13", "14 - 20", "21 - 30"]);
  assert.deepEqual(labels("2026-08"), ["1 - 9", "10 - 16", "17 - 23", "24 - 31"]);
  assert.deepEqual(labels("2026-07"), ["1 - 5", "6 - 12", "13 - 19", "20 - 26", "27 - 31"]);
  const sep = monthWeeks("2026-09");
  assert.equal(sep[3].start, "2026-09-21");
  assert.equal(sep[3].end, "2026-09-30");
  assert.equal(sep[3].days.length, 10);
  assert.equal(sep.reduce((n, w) => n + w.days.length, 0), 30, "cada día en exactamente una semana");
  assert.equal(monthDays("2026-02").length, 28);
  // 1 de febrero de 2026 es domingo: pedazo de 1 día → se pega a la siguiente.
  assert.deepEqual(labels("2026-02"), ["1 - 8", "9 - 15", "16 - 22", "23 - 28"]);

  // Semáforo, bordes exactos de las fórmulas del Excel (180 % / 100 % / 75 %).
  assert.equal(semaphore(18, 10), "alto");
  assert.equal(semaphore(17.9, 10), "medio");
  assert.equal(semaphore(10, 10), "medio");
  assert.equal(semaphore(7.5, 10), "bajo");
  assert.equal(semaphore(7.4, 10), null);
  assert.equal(semaphore(5, 0), null, "sin objetivo no hay color");

  // Objetivos: semanal = mes ÷ 4, diario = semanal ÷ 7; equipo = × asesores.
  assert.equal(scaleObjectives(PMI_OBJECTIVES, 1 / 4).leads, 10);
  assert.equal(scaleObjectives(PMI_OBJECTIVES, 3).montoApartados, 9_000_000);

  // Conversiones: null con denominador 0, nunca 0 %.
  const c = emptyCounts();
  assert.deepEqual(conversions(c), { leadPerfil: null, perfilCita: null, citaApartado: null, apartadoCierre: null });
  c.leads = 31; c.perfilamientos = 11; c.citas = 4;
  const conv = conversions(c);
  assert.ok(Math.abs((conv.leadPerfil ?? 0) - 11 / 31) < 1e-9);
  assert.equal(conv.citaApartado, 0, "4 citas y 0 apartados es 0 %, no null");
  assert.equal(conv.apartadoCierre, null);

  // Eventos: cada indicador con su registro, fecha LOCAL y asesor.
  const input = {
    contacts: [
      contact({ id: "c1", createdAt: "2026-09-01T05:30:00.000Z", assignedTo: "Arely" }),   // 31 ago 23:30 local → fuera
      contact({ id: "c2", createdAt: "2026-09-01T06:30:00.000Z", assignedTo: "Arely" }),   // 1 sep 00:30 local → dentro
      contact({ id: "c3", createdAt: "2026-09-10T12:00:00.000Z" }),                          // sin asesor
    ],
    opportunities: [
      opp({ id: "o1", contactId: "c2", assignedTo: "Arely", stage: "06. Apartado", value: 3_988_119.69,
        milestones: { perfilado: "2026-09-03T15:00:00.000Z", apartado: "2026-09-03T16:00:00.000Z" } }),
      opp({ id: "o2", contactId: "c3", stage: "02. Cliente Calificado",
        milestones: { perfilado: "2026-08-30T15:00:00.000Z", estimated: true } }),           // agosto: fuera
      opp({ id: "o3", contactId: "c9", assignedTo: "Eder", stage: "Lead Recibido" }),        // sin milestones (payload viejo)
      opp({ id: "o4", contactId: "c2", assignedTo: "Arely", stage: "Lead Recibido",
        source: "facebook", adType: "paid_social" }),                                        // marca c2 como de pauta
    ],
    appointments: [
      appt({ id: "ap1", assignedTo: "Arely", status: "showed" }),
      appt({ id: "ap2", assignedTo: "Arely", status: "noshow" }),
      appt({ id: "ap3", assignedTo: "Arely", status: "confirmed" }),
    ],
    pautas: [],
  };
  const events = collectEvents(input, "2026-09-01", "2026-09-30");
  const kinds = events.map((e) => `${e.kind}:${e.id}:${e.advisor}:${e.day}`).sort();
  assert.deepEqual(kinds, [
    "apartados:o1:Arely:2026-09-03",
    "citas:ap1:Arely:2026-09-08",
    "leads:c2:Arely:2026-09-01",
    `leads:c3:${UNASSIGNED}:2026-09-10`,
    "perfilamientos:o1:Arely:2026-09-03",
  ]);
  assert.equal(events.find((e) => e.id === "c2")?.pauta, true, "de pauta por la opp con tráfico pagado");
  assert.equal(events.find((e) => e.id === "c3")?.pauta, false);
  assert.equal(events.find((e) => e.kind === "apartados")?.monto, 3_988_119.69);

  // Acumulación
  const acc = emptyCounts();
  for (const e of events) addEvent(acc, e);
  assert.equal(acc.leads, 2); assert.equal(acc.leadsPauta, 1); assert.equal(acc.apartados, 1);
  assert.equal(acc.montoApartados, 3_988_119.69); assert.deepEqual(acc.ids.apartados, ["o1"]);
  const total = sumCounts([acc, acc]);
  assert.equal(total.leads, 4); assert.deepEqual(total.ids.leads, ["c2", "c3", "c2", "c3"]);
  void pad;
}

async function main() {
  stagesMain();
  console.log("✅ verify:pmi — etapas");
  engineMain();
  console.log("✅ verify:pmi — motor");
}

main().catch((err) => { console.error(err); process.exit(1); });
