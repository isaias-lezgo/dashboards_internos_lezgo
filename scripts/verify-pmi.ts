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
  PMI_OBJECTIVES, scaleObjectives, UNASSIGNED, buildPmiMonth, monthLabel, shiftMonth, buildPmiYear,
  buildPmiQuarter, quarterOf, quarterMonths, quarterLabel,
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
}

function monthMain() {
  assert.equal(monthLabel("2026-09"), "Septiembre 2026");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");

  const input = {
    contacts: [
      ...Array.from({ length: 29 }, (_, i) => contact({ id: `a${i}`, assignedTo: "Arely", createdAt: `2026-09-${pad(1 + (i % 20))}T15:00:00.000Z` })),
      ...Array.from({ length: 31 }, (_, i) => contact({ id: `m${i}`, assignedTo: "Monica", createdAt: `2026-09-${pad(1 + (i % 12))}T15:00:00.000Z` })),
      contact({ id: "x1", createdAt: "2026-09-05T15:00:00.000Z" }), // sin asesor
    ],
    opportunities: [
      opp({ id: "o1", contactId: "a0", assignedTo: "Arely", stage: "06. Apartado", value: 3_988_119.69,
        milestones: { perfilado: "2026-09-02T15:00:00.000Z", apartado: "2026-09-03T15:00:00.000Z" } }),
      opp({ id: "o2", contactId: "a1", assignedTo: "Arely", stage: "02. Cliente Calificado",
        milestones: { perfilado: "2026-09-09T15:00:00.000Z", estimated: true } }),
      opp({ id: "o3", contactId: "m0", assignedTo: "Monica", stage: "08. Proceso de Escritura", value: 3_265_823.51,
        milestones: { perfilado: "2026-08-10T15:00:00.000Z", apartado: "2026-08-12T15:00:00.000Z", cierre: "2026-09-16T15:00:00.000Z" } }),
    ],
    appointments: [
      appt({ id: "ap1", assignedTo: "Arely", startTime: "2026-09-08T16:00:00-06:00" }),
      appt({ id: "ap2", assignedTo: "Arely", startTime: "2026-09-22T16:00:00-06:00" }),
    ],
    pautas: [],
  };
  const pmi = buildPmiMonth(input, "2026-09", new Date("2026-09-15T18:00:00.000Z"));

  assert.equal(pmi.weeks.length, 4);
  assert.equal(pmi.today, "2026-09-15", "hoy en día local, para marcar lo que no ha ocurrido");
  assert.deepEqual(pmi.advisors.map((a) => a.name), ["Arely", "Monica"], "orden alfabético, activos del mes");
  assert.equal(pmi.activeAdvisors, 2);
  assert.equal(pmi.unassigned?.total.leads, 1, "'Sin asignar' aparece porque no es cero");

  const arely = pmi.advisors[0];
  assert.equal(arely.total.leads, 29);
  assert.equal(arely.total.perfilamientos, 2);
  assert.equal(arely.total.citas, 2);
  assert.equal(arely.total.apartados, 1);
  assert.equal(arely.total.montoApartados, 3_988_119.69);
  assert.equal(arely.byWeek[0].apartados, 1, "3 de sept cae en la semana 1 - 6");
  assert.equal(arely.byWeek[3].citas, 1, "22 de sept cae en 21 - 30");
  assert.equal(arely.byDay[2].apartados, 1, "byDay[2] es el día 3");
  assert.equal(arely.byDay.length, 30);
  assert.equal(arely.objectives.month.leads, 40);
  assert.equal(arely.objectives.week.leads, 10);
  assert.ok(Math.abs(arely.objectives.day.leads - 10 / 7) < 1e-9);
  assert.ok(Math.abs((arely.conversions.leadPerfil ?? 0) - 2 / 29) < 1e-9);

  // Equipo = todos los asesores (sin "Sin asignar"), objetivo × activos.
  assert.equal(pmi.team.total.leads, 60);
  assert.equal(pmi.team.total.cierres, 1);
  assert.equal(pmi.team.objectives.month.leads, 80);
  assert.equal(pmi.team.objectives.month.montoApartados, 6_000_000);

  // Rankings por monto, con avance contra $3M.
  assert.deepEqual(pmi.rankingApartados.map((r) => [r.name, r.count]), [["Arely", 1], ["Monica", 0]]);
  assert.ok(Math.abs((pmi.rankingApartados[0].avance ?? 0) - 3_988_119.69 / 3_000_000) < 1e-9);
  assert.equal(pmi.rankingCierres[0].name, "Monica");

  // Un hito estimado en el mes se reporta.
  assert.equal(pmi.estimatedCount, 1);

  // Un mes vacío no explota.
  const empty = buildPmiMonth({ contacts: [], opportunities: [], appointments: [], pautas: [] }, "2026-02");
  assert.equal(empty.advisors.length, 0);
  assert.equal(empty.activeAdvisors, 0);
  assert.equal(empty.unassigned, null);
  assert.equal(empty.team.objectives.month.leads, 0);
}

function yearMain() {
  const input = {
    contacts: [
      contact({ id: "a1", assignedTo: "Arely", createdAt: "2026-03-05T15:00:00.000Z" }),
      contact({ id: "a2", assignedTo: "Arely", createdAt: "2026-09-05T15:00:00.000Z" }),
      contact({ id: "m1", assignedTo: "Monica", createdAt: "2026-01-05T15:00:00.000Z" }),
    ],
    opportunities: [
      opp({ id: "o1", assignedTo: "Arely", value: 5_967_052.46, stage: "08. Proceso de Escritura",
        milestones: { perfilado: "2026-05-01T15:00:00.000Z", apartado: "2026-05-10T15:00:00.000Z", cierre: "2026-07-10T15:00:00.000Z" } }),
      opp({ id: "o2", assignedTo: "Arely", value: 6_497_283.09, stage: "06. Apartado",
        milestones: { perfilado: "2026-06-01T15:00:00.000Z", apartado: "2026-06-10T15:00:00.000Z" } }),
      opp({ id: "o3", assignedTo: "Monica", value: 3_145_022.6, stage: "10. Negocio Ganado",
        milestones: { perfilado: "2025-12-01T15:00:00.000Z", apartado: "2025-12-10T15:00:00.000Z", cierre: "2026-01-20T15:00:00.000Z" } }),
    ],
    appointments: [],
    pautas: [],
  };
  const y = buildPmiYear(input, 2026, new Date("2026-09-15T18:00:00.000Z"));
  assert.equal(y.today, "2026-09-15");
  const arely = y.advisors.find((a) => a.name === "Arely")!;
  assert.equal(arely.byMonth.length, 12);
  assert.equal(arely.byMonth[4].apartados, 1, "mayo");
  assert.equal(arely.byMonth[5].apartados, 1, "junio");
  assert.equal(arely.byQuarter[1].apartados, 2, "2do trimestre");
  assert.equal(arely.byQuarter[2].cierres, 1, "3er trimestre");
  assert.equal(arely.total.montoApartados, 5_967_052.46 + 6_497_283.09);
  assert.equal(arely.mesesActivo, 5, "mar, may, jun, jul, sep");
  assert.ok(Math.abs((arely.promedio?.montoApartados ?? 0) - (5_967_052.46 + 6_497_283.09) / 5) < 1e-6);
  assert.equal(arely.ticketPromedio, 5_967_052.46);

  const monica = y.advisors.find((a) => a.name === "Monica")!;
  assert.equal(monica.total.apartados, 0, "el apartado fue en diciembre 2025: fuera del año");
  assert.equal(monica.total.cierres, 1);
  assert.equal(monica.mesesActivo, 1);

  assert.equal(y.team.byMonth[0].leads, 1);
  assert.deepEqual(y.team.activeByMonth.slice(0, 3), [1, 0, 1]);
  assert.equal(y.team.pctMeta[1], null, "febrero sin asesores activos: sin % de meta");
  assert.ok(Math.abs((y.team.pctMeta[0]?.leads ?? 0) - 1 / 40) < 1e-9);
  assert.equal(y.team.byQuarter[2].cierres, 1);

  const r = y.rankingApartados[0];
  assert.equal(r.name, "Arely");
  assert.ok(Math.abs((r.avance ?? 0) - r.monto / (3_000_000 * 5)) < 1e-9, "meta = $3M × meses activo");
  assert.equal(r.paraLlegar, Math.max(0, 3_000_000 * 5 - r.monto));
  assert.equal(y.rankingCierres[0].name, "Arely");
  assert.equal(y.rankingCierres[1].name, "Monica");
  assert.equal(y.estimatedCount, 0);

  // Trimestres: cuatro, con etiqueta, ranking propio y meta = Σ (activos del mes × meta mensual).
  assert.equal(y.quarters.length, 4);
  assert.deepEqual(y.quarters.map((q) => q.label), ["Ene – Mar", "Abr – Jun", "Jul – Sep", "Oct – Dic"]);
  const q2 = y.quarters[1];
  assert.equal(q2.team.apartados, 2);
  assert.equal(q2.team.montoApartados, 5_967_052.46 + 6_497_283.09);
  // Arely activa en mayo y junio (abril no): la meta del trimestre es 2 meses × $3M.
  assert.equal(q2.objectives?.montoApartados, 6_000_000);
  assert.deepEqual(q2.rankingApartados.map((r) => [r.name, r.count]), [["Arely", 2]]);
  assert.ok(Math.abs((q2.rankingApartados[0].avance ?? 0) - (5_967_052.46 + 6_497_283.09) / 6_000_000) < 1e-9);
  // Q1: Arely (lead en marzo) y Monica (lead y cierre en enero) activas; ninguna apartó.
  const q1 = y.quarters[0];
  assert.equal(q1.objectives?.montoApartados, 6_000_000, "un mes activo cada una");
  assert.deepEqual(q1.rankingApartados.map((r) => [r.name, r.monto]), [["Arely", 0], ["Monica", 0]]);
  assert.deepEqual(q1.rankingCierres.map((r) => r.name), ["Monica", "Arely"]);
  assert.equal(q1.rankingCierres[0].avance, 3_145_022.6 / 3_000_000, "meta = 1 mes activo × $3M");
  // Q4 sin actividad: sin meta y sin ranking, nunca 0 %.
  const q4 = y.quarters[3];
  assert.equal(q4.objectives, null);
  assert.equal(q4.rankingApartados.length, 0);
}

function quarterMain() {
  // El mismo fixture que el año: el trimestre debe dar EXACTAMENTE lo que la
  // hoja anual ya dice de él, o el mismo trimestre tendría dos números.
  const input = {
    contacts: [
      contact({ id: "a1", assignedTo: "Arely", createdAt: "2026-03-05T15:00:00.000Z" }),
      contact({ id: "a2", assignedTo: "Arely", createdAt: "2026-09-05T15:00:00.000Z" }),
      contact({ id: "m1", assignedTo: "Monica", createdAt: "2026-01-05T15:00:00.000Z" }),
      contact({ id: "x1", assignedTo: undefined, createdAt: "2026-08-05T15:00:00.000Z" }),
    ],
    opportunities: [
      opp({ id: "o1", assignedTo: "Arely", value: 5_967_052.46, stage: "08. Proceso de Escritura",
        milestones: { perfilado: "2026-05-01T15:00:00.000Z", apartado: "2026-05-10T15:00:00.000Z", cierre: "2026-07-10T15:00:00.000Z" } }),
      opp({ id: "o2", assignedTo: "Arely", value: 6_497_283.09, stage: "06. Apartado",
        milestones: { perfilado: "2026-06-01T15:00:00.000Z", apartado: "2026-06-10T15:00:00.000Z" } }),
      opp({ id: "o3", assignedTo: "Monica", value: 3_145_022.6, stage: "10. Negocio Ganado",
        milestones: { perfilado: "2025-12-01T15:00:00.000Z", apartado: "2025-12-10T15:00:00.000Z", cierre: "2026-01-20T15:00:00.000Z" } }),
    ],
    appointments: [],
    pautas: [],
  };
  const now = new Date("2026-09-15T18:00:00.000Z");
  const y = buildPmiYear(input, 2026, now);

  // Calendario del trimestre.
  assert.deepEqual(quarterOf("2026-09"), { year: 2026, q: 2 });
  assert.deepEqual(quarterOf("2026-01"), { year: 2026, q: 0 });
  assert.deepEqual(quarterMonths(2026, 2), ["2026-07", "2026-08", "2026-09"]);
  assert.equal(quarterLabel(2026, 2), "T3 2026 · Jul – Sep");
  // Navegar ±3 meses cambia de trimestre y cruza el año.
  assert.deepEqual(quarterOf(shiftMonth("2026-01", -3)), { year: 2025, q: 3 });

  // Q2 2026: Arely apartó en mayo y junio.
  const q2 = buildPmiQuarter(input, 2026, 1, now);
  assert.equal(q2.label, "Abr – Jun");
  assert.deepEqual(q2.months, ["2026-04", "2026-05", "2026-06"]);
  assert.equal(q2.today, "2026-09-15");
  const arely = q2.advisors.find((a) => a.name === "Arely")!;
  assert.equal(arely.byMonth.length, 3);
  assert.deepEqual(arely.byMonth.map((c) => c.apartados), [0, 1, 1]);
  assert.equal(arely.total.apartados, 2);
  assert.equal(arely.total.montoApartados, y.advisors.find((a) => a.name === "Arely")!.byQuarter[1].montoApartados);
  // Objetivo del asesor = mensual × meses con actividad (abril no cuenta), la regla del año.
  assert.equal(arely.objectives.quarter.montoApartados, 6_000_000);
  assert.equal(arely.objectives.quarter.leads, 80);
  assert.deepEqual(arely.objectives.byMonth.map((o) => o.leads), [40, 40, 40], "cada mes se mide contra la meta mensual");
  assert.equal(q2.advisors.length, 1, "Monica no tuvo actividad en Q2: no aparece");

  // Equipo = lo que la hoja anual dice del trimestre, número por número.
  assert.equal(q2.team.total.apartados, y.team.byQuarter[1].apartados);
  assert.equal(q2.team.total.montoApartados, y.team.byQuarter[1].montoApartados);
  assert.deepEqual(q2.team.objectives.quarter, y.quarters[1].objectives);
  assert.deepEqual(q2.team.objectives.byMonth.map((o) => o.leads), [0, 40, 40], "activos por mes × meta mensual");
  assert.deepEqual(q2.rankingApartados, y.quarters[1].rankingApartados);
  assert.deepEqual(q2.rankingCierres, y.quarters[1].rankingCierres);
  assert.equal(q2.activeAdvisors, 1);
  assert.equal(q2.unassigned, null);

  // Q3 2026 en curso: un lead sin asignar en agosto va a "Sin asignar", no al equipo.
  const q3 = buildPmiQuarter(input, 2026, 2, now);
  assert.equal(q3.team.total.leads, 1, "solo el de Arely en septiembre");
  assert.equal(q3.unassigned?.total.leads, 1);
  assert.deepEqual(q3.team.byMonth.map((c) => c.cierres), [1, 0, 0]);
  assert.equal(q3.team.total.cierres, y.team.byQuarter[2].cierres);
  assert.deepEqual(q3.rankingCierres, y.quarters[2].rankingCierres);

  // Q4 sin actividad: sin asesores, objetivos en cero (la UI dice "—"), sin ranking.
  const q4 = buildPmiQuarter(input, 2026, 3, now);
  assert.equal(q4.advisors.length, 0);
  assert.equal(q4.team.objectives.quarter.leads, 0);
  assert.equal(q4.rankingApartados.length, 0);
  assert.equal(q4.team.conversions.leadPerfil, null);
}

async function main() {
  stagesMain();
  console.log("✅ verify:pmi — etapas");
  engineMain();
  console.log("✅ verify:pmi — motor");
  monthMain();
  console.log("✅ verify:pmi — mes");
  yearMain();
  console.log("✅ verify:pmi — año");
  quarterMain();
  console.log("✅ verify:pmi — trimestre");
}

main().catch((err) => { console.error(err); process.exit(1); });
