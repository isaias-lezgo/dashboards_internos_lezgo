// lib/pmi-report.ts
// El PMI → ReportInput, sobre los mismos lib/pdf/* que Marketing y Ventas.
// Tres variantes según lo que esté en pantalla; el análisis de Haiku va por
// analyze-report como en los otros dos.
import type { ReportInput, ReportSection } from "./report";
import {
  PMI_CONVERSION_TARGETS, PMI_OBJECTIVES, monthLabel, quarterLabel, semaphore,
  type PmiAdvisor, type PmiConversions, type PmiCounts, type PmiIndicator, type PmiMonth, type PmiObjectives,
  type PmiQuarterAdvisor, type PmiQuarterDetail, type PmiQuarterSlice, type PmiSlice, type PmiTone, type PmiYear,
} from "./pmi";

export type PmiReportVariant =
  | { kind: "month-team"; pmi: PmiMonth }
  | { kind: "month-advisor"; pmi: PmiMonth; advisor: PmiAdvisor }
  | { kind: "quarter-team"; quarter: PmiQuarterDetail }
  | { kind: "quarter-advisor"; quarter: PmiQuarterDetail; advisor: PmiQuarterAdvisor }
  | { kind: "year"; year: PmiYear };

const mxn = (v: number) => v.toLocaleString("es-MX", { style: "currency", currency: "MXN", maximumFractionDigits: 0 });
const int = (v: number) => v.toLocaleString("es-MX", { maximumFractionDigits: 0 });
const pct = (r: number | null) => (r === null ? "—" : `${(r * 100).toFixed(0)} %`);
const toneWord = (t: PmiTone) =>
  t === "alto" ? "Superó" : t === "medio" ? "Alcanzó" : t === "bajo" ? "Se acercó" : "Debajo";
const avance = (v: number, o: number) => pct(o > 0 ? v / o : null);

const COUNT_ROWS: [string, PmiIndicator][] = [
  ["Leads", "leads"], ["Perfilamientos", "perfilamientos"], ["Citas efectivas", "citas"],
  ["Apartados", "apartados"], ["Cierres", "cierres"],
];
const MONTHS = ["Ene", "Feb", "Mar", "Abr", "May", "Jun", "Jul", "Ago", "Sep", "Oct", "Nov", "Dic"];

function kpisOf(total: PmiCounts, o: PmiObjectives) {
  return [
    { label: "Leads", value: `${int(total.leads)} / ${int(o.leads)}` },
    { label: "Perfilamientos", value: `${int(total.perfilamientos)} / ${int(o.perfilamientos)}` },
    { label: "Citas efectivas", value: `${int(total.citas)} / ${int(o.citas)}` },
    { label: "Apartados", value: `${int(total.apartados)} · ${mxn(total.montoApartados)}` },
    { label: "Cierres", value: `${int(total.cierres)} · ${mxn(total.montoCierres)}` },
  ];
}

// El mes en curso: el día de hoy dentro del mes, o null si el mes ya cerró.
// Sin esto el modelo lee las semanas que no han ocurrido como "caída abrupta".
function cutoffDay(pmi: PmiMonth): number | null {
  if (pmi.today.slice(0, 7) !== pmi.month) return null;
  return Number(pmi.today.slice(8));
}

function weekSection(s: PmiSlice, pmi: PmiMonth): ReportSection {
  const o = s.objectives.month;
  const cutoff = cutoffDay(pmi);
  const isFuture = (i: number) => pmi.weeks[i].start > pmi.today;
  const cell = (i: number, v: string) => (isFuture(i) ? "—" : v);
  return {
    id: "semanas",
    title: "Indicadores por semana",
    explanation:
      "Cada indicador por semana del mes contra su objetivo semanal (mes ÷ 4), con el total del mes, el objetivo y el avance. Superó ≥ 180 %, Alcanzó ≥ 100 %, Se acercó ≥ 75 %." +
      (cutoff !== null
        ? ` El mes está en curso (datos al día ${cutoff}): las semanas marcadas con — no han ocurrido y el objetivo del mes todavía no es exigible completo.`
        : ""),
    blocks: [{
      t: "table",
      headers: ["Indicador", ...pmi.weeks.map((w) => `Sem ${w.index + 1} (${w.label})`), "Total", "Objetivo", "Avance", "Semáforo"],
      rows: [
        ...COUNT_ROWS.map(([label, k]) => [
          label, ...s.byWeek.map((c, i) => cell(i, int(c[k]))), int(s.total[k]), int(o[k]), avance(s.total[k], o[k]), toneWord(semaphore(s.total[k], o[k])),
        ]),
        ["Monto de apartados", ...s.byWeek.map((c, i) => cell(i, mxn(c.montoApartados))), mxn(s.total.montoApartados), mxn(o.montoApartados), avance(s.total.montoApartados, o.montoApartados), toneWord(semaphore(s.total.montoApartados, o.montoApartados))],
        ["Monto de cierres", ...s.byWeek.map((c, i) => cell(i, mxn(c.montoCierres))), mxn(s.total.montoCierres), mxn(o.montoCierres), avance(s.total.montoCierres, o.montoCierres), toneWord(semaphore(s.total.montoCierres, o.montoCierres))],
      ],
    }],
  };
}

function conversionsSection(c: PmiConversions): ReportSection {
  return {
    id: "conversiones",
    title: "Conversiones del embudo",
    explanation: "Conversión entre etapas consecutivas del PMI contra la meta de cada paso (40 / 60 / 75 / 100 %). Sin denominador no hay conversión que reportar.",
    blocks: [{
      t: "table",
      headers: ["Paso", "Resultado", "Meta"],
      rows: [
        ["Leads → Perfilamientos", pct(c.leadPerfil), pct(PMI_CONVERSION_TARGETS.leadPerfil)],
        ["Perfilamientos → Citas efectivas", pct(c.perfilCita), pct(PMI_CONVERSION_TARGETS.perfilCita)],
        ["Citas efectivas → Apartados", pct(c.citaApartado), pct(PMI_CONVERSION_TARGETS.citaApartado)],
        ["Apartados → Cierres", pct(c.apartadoCierre), pct(PMI_CONVERSION_TARGETS.apartadoCierre)],
      ],
    }],
  };
}

function trendSection(s: PmiSlice, pmi: PmiMonth): ReportSection {
  // Solo las semanas que ya empezaron: una línea que cae a cero en semanas
  // futuras cuenta una historia falsa.
  const weeks = pmi.weeks.filter((w) => w.start <= pmi.today);
  return {
    id: "tendencia",
    title: "Perfilamientos y citas efectivas por semana",
    explanation:
      "Actividad de productividad semana a semana: cuántos perfilamientos y cuántas citas efectivas hubo en cada una." +
      (weeks.length < pmi.weeks.length ? " Solo se grafican las semanas que ya empezaron." : ""),
    blocks: [{
      t: "chart", type: "line", valueLabel: "Registros",
      categories: weeks.map((w) => `Semana ${w.index + 1}`),
      series: [
        { name: "Perfilamientos", values: weeks.map((w) => s.byWeek[w.index].perfilamientos) },
        { name: "Citas efectivas", values: weeks.map((w) => s.byWeek[w.index].citas) },
      ],
    }],
  };
}

function estimatedCallout(count: number): ReportSection[] {
  if (count === 0) return [];
  return [{
    id: "estimados",
    title: "Nota sobre las fechas",
    explanation: "Aviso metodológico, no un resultado.",
    ai: false,
    blocks: [{ t: "callout", style: "info", text: `${count} hitos del período tienen fecha estimada: son anteriores al arranque de la bitácora y llevan la fecha de su última edición en el CRM.` }],
  }];
}

function yearReport(y: PmiYear, locationName?: string): ReportInput {
  const inProgress = y.today.slice(0, 4) === String(y.year);
  const futureMonth = (i: number) => `${y.year}-${String(i + 1).padStart(2, "0")}-01` > y.today;
  const monthCell = (i: number, v: string) => (futureMonth(i) ? "—" : v);
  const montoTable = (key: "montoApartados" | "montoCierres") => ({
    t: "table" as const,
    headers: ["Asesor", ...MONTHS, "Total"],
    rows: [
      ...y.advisors.map((a) => [a.name, ...a.byMonth.map((c, i) => monthCell(i, mxn(c[key]))), mxn(a.total[key])]),
      ["Equipo", ...y.team.byMonth.map((c, i) => monthCell(i, mxn(c[key]))), mxn(y.team.total[key])],
    ],
  });
  const inProgressNote = inProgress
    ? ` El año está en curso (datos al ${Number(y.today.slice(8))} de ${MONTHS[Number(y.today.slice(5, 7)) - 1]}): los meses marcados con — no han ocurrido.`
    : "";
  const sections: ReportSection[] = [
    {
      id: "apartados-mes",
      title: "Apartados por asesor y mes",
      explanation: "Monto apartado por asesor en cada mes del año, con el total anual." + inProgressNote,
      blocks: [montoTable("montoApartados")],
    },
    {
      id: "cierres-mes",
      title: "Cierres por asesor y mes",
      explanation: "Monto cerrado por asesor en cada mes del año, con el total anual." + inProgressNote,
      blocks: [montoTable("montoCierres")],
    },
    {
      id: "actividad-trimestre",
      title: "Actividad por trimestre",
      explanation: "Leads, perfilamientos, citas efectivas, apartados y cierres del equipo por trimestre." + inProgressNote,
      blocks: [{
        t: "chart", type: "bar", valueLabel: "Registros",
        categories: ["T1", "T2", "T3", "T4"],
        series: COUNT_ROWS.map(([name, k]) => ({ name, values: y.team.byQuarter.map((c) => c[k]) })),
      }],
    },
    {
      id: "ranking-anual",
      title: "Ranking anual de apartados",
      explanation: `Monto apartado en el año por asesor contra la meta de ${mxn(PMI_OBJECTIVES.montoApartados)} por mes activo, con el promedio mensual y lo que falta para llegar.`,
      blocks: [{
        t: "table",
        headers: ["Asesor", "Total", "Apartados", "Meses activo", "Promedio", "Avance", "$ para llegar"],
        rows: y.rankingApartados.map((r) => [r.name, mxn(r.monto), int(r.count), String(r.mesesActivo), r.promedio === null ? "—" : mxn(r.promedio), pct(r.avance), mxn(r.paraLlegar)]),
      }],
    },
    {
      id: "ticket",
      title: "Ticket promedio",
      explanation: "Monto cerrado entre número de cierres, por asesor.",
      blocks: [{ t: "table", headers: ["Asesor", "Cierres", "Ticket promedio"], rows: y.advisors.map((a) => [a.name, int(a.total.cierres), a.ticketPromedio === null ? "—" : mxn(a.ticketPromedio)]) }],
    },
    ...estimatedCallout(y.estimatedCount),
  ];
  return {
    reportType: "pmi",
    title: `Desempeño ${y.year}`,
    locationName,
    periodLabel: inProgress ? `${y.year} (en curso, al ${Number(y.today.slice(8))} de ${MONTHS[Number(y.today.slice(5, 7)) - 1]})` : String(y.year),
    kpis: [
      { label: "Leads", value: int(y.team.total.leads) },
      { label: "Apartados", value: `${int(y.team.total.apartados)} · ${mxn(y.team.total.montoApartados)}` },
      { label: "Cierres", value: `${int(y.team.total.cierres)} · ${mxn(y.team.total.montoCierres)}` },
    ],
    sections,
  };
}

export function buildPmiReport(v: PmiReportVariant, locationName?: string): ReportInput {
  if (v.kind === "year") return yearReport(v.year, locationName);
  if (v.kind === "quarter-team" || v.kind === "quarter-advisor") return quarterReport(v, locationName);

  const { pmi } = v;
  const slice: PmiSlice = v.kind === "month-advisor" ? v.advisor : pmi.team;
  const scope = v.kind === "month-advisor" ? v.advisor.name : "Equipo";
  const sections: ReportSection[] = [weekSection(slice, pmi), conversionsSection(slice.conversions)];

  if (v.kind === "month-team") {
    sections.push({
      id: "por-asesor",
      title: "Resultados por asesor",
      explanation: "Los cinco indicadores y los montos de cada asesor en el mes, con sus conversiones.",
      blocks: [{
        t: "table",
        headers: ["Asesor", "Leads", "Perfil.", "Citas", "Apartados", "$ Apartados", "Cierres", "$ Cierres", "L→P", "P→C", "C→A", "A→Ci"],
        rows: pmi.advisors.map((a) => [
          a.name, int(a.total.leads), int(a.total.perfilamientos), int(a.total.citas), int(a.total.apartados), mxn(a.total.montoApartados),
          int(a.total.cierres), mxn(a.total.montoCierres), pct(a.conversions.leadPerfil), pct(a.conversions.perfilCita), pct(a.conversions.citaApartado), pct(a.conversions.apartadoCierre),
        ]),
      }],
    });
    sections.push({
      id: "ranking",
      title: "Ranking de apartados",
      explanation: `Monto apartado por asesor en el mes contra la meta de ${mxn(PMI_OBJECTIVES.montoApartados)}.`,
      blocks: [{ t: "chart", type: "bar", valueLabel: "Monto (MXN)", series: pmi.rankingApartados.map((r) => ({ label: r.name, value: r.monto })) }],
    });
  } else {
    // Ficha del asesor: la cuadrícula diaria como tabla, una fila por indicador.
    sections.push({
      id: "dia-a-dia",
      title: "Día a día",
      explanation: "Registros por día del mes para cada indicador. El objetivo diario es el semanal entre 7.",
      blocks: [{
        t: "table",
        headers: ["Indicador", ...pmi.days.map((d) => String(Number(d.slice(8))))],
        rows: COUNT_ROWS.map(([label, k]) => [label, ...slice.byDay.map((c, i) => (pmi.days[i] > pmi.today ? "·" : String(c[k])))]),
      }],
    });
  }
  sections.push(trendSection(slice, pmi), ...estimatedCallout(pmi.estimatedCount));

  const cutoff = cutoffDay(pmi);
  return {
    reportType: "pmi",
    title: `Desempeño · ${scope} · ${monthLabel(pmi.month)}`,
    locationName,
    periodLabel: cutoff === null ? monthLabel(pmi.month) : `${monthLabel(pmi.month)} (al día ${cutoff}, mes en curso)`,
    filtersLabel: v.kind === "month-advisor" ? `Asesor: ${v.advisor.name}` : undefined,
    kpis: kpisOf(slice.total, slice.objectives.month),
    sections,
  };
}

// ── Trimestre ───────────────────────────────────────────────────────────────
// El espejo del reporte mensual con meses en lugar de semanas.

function quarterCutoff(qd: PmiQuarterDetail): string | null {
  if (!qd.months.includes(qd.today.slice(0, 7))) return null;
  return `${Number(qd.today.slice(8))} de ${MONTHS[Number(qd.today.slice(5, 7)) - 1]}`;
}

function monthSection(s: PmiQuarterSlice, qd: PmiQuarterDetail, advisor: boolean): ReportSection {
  const o = s.objectives.quarter;
  const cutoff = quarterCutoff(qd);
  const isFuture = (i: number) => `${qd.months[i]}-01` > qd.today;
  const cell = (i: number, v: string) => (isFuture(i) ? "—" : v);
  const labels = qd.months.map((m) => MONTHS[Number(m.slice(5, 7)) - 1]);
  return {
    id: "meses",
    title: "Indicadores por mes",
    explanation:
      "Cada indicador por mes del trimestre, con el total, el objetivo del trimestre y el avance. " +
      (advisor
        ? "El objetivo del trimestre es el mensual por cada mes con actividad del asesor."
        : "El objetivo del trimestre suma, por cada mes, un objetivo mensual por asesor con actividad.") +
      " Superó ≥ 180 %, Alcanzó ≥ 100 %, Se acercó ≥ 75 %." +
      (cutoff !== null
        ? ` El trimestre está en curso (datos al ${cutoff}): los meses marcados con — no han ocurrido y el objetivo del trimestre todavía no es exigible completo.`
        : ""),
    blocks: [{
      t: "table",
      headers: ["Indicador", ...labels, "Total", "Objetivo", "Avance", "Semáforo"],
      rows: [
        ...COUNT_ROWS.map(([label, k]) => [
          label, ...s.byMonth.map((c, i) => cell(i, int(c[k]))), int(s.total[k]), int(o[k]), avance(s.total[k], o[k]), toneWord(semaphore(s.total[k], o[k])),
        ]),
        ["Monto de apartados", ...s.byMonth.map((c, i) => cell(i, mxn(c.montoApartados))), mxn(s.total.montoApartados), mxn(o.montoApartados), avance(s.total.montoApartados, o.montoApartados), toneWord(semaphore(s.total.montoApartados, o.montoApartados))],
        ["Monto de cierres", ...s.byMonth.map((c, i) => cell(i, mxn(c.montoCierres))), mxn(s.total.montoCierres), mxn(o.montoCierres), avance(s.total.montoCierres, o.montoCierres), toneWord(semaphore(s.total.montoCierres, o.montoCierres))],
      ],
    }],
  };
}

function monthTrendSection(s: PmiQuarterSlice, qd: PmiQuarterDetail): ReportSection {
  const started = qd.months.map((_, i) => i).filter((i) => `${qd.months[i]}-01` <= qd.today);
  return {
    id: "tendencia",
    title: "Perfilamientos y citas efectivas por mes",
    explanation:
      "Actividad de productividad mes a mes: cuántos perfilamientos y cuántas citas efectivas hubo en cada uno." +
      (started.length < qd.months.length ? " Solo se grafican los meses que ya empezaron." : ""),
    blocks: [{
      t: "chart", type: "line", valueLabel: "Registros",
      categories: started.map((i) => MONTHS[Number(qd.months[i].slice(5, 7)) - 1]),
      series: [
        { name: "Perfilamientos", values: started.map((i) => s.byMonth[i].perfilamientos) },
        { name: "Citas efectivas", values: started.map((i) => s.byMonth[i].citas) },
      ],
    }],
  };
}

function quarterReport(v: Extract<PmiReportVariant, { kind: "quarter-team" | "quarter-advisor" }>, locationName?: string): ReportInput {
  const qd = v.quarter;
  const slice: PmiQuarterSlice = v.kind === "quarter-advisor" ? v.advisor : qd.team;
  const scope = v.kind === "quarter-advisor" ? v.advisor.name : "Equipo";
  const label = quarterLabel(qd.year, qd.q);
  const sections: ReportSection[] = [monthSection(slice, qd, v.kind === "quarter-advisor"), conversionsSection(slice.conversions)];

  if (v.kind === "quarter-team") {
    sections.push({
      id: "por-asesor",
      title: "Resultados por asesor",
      explanation: "Los cinco indicadores y los montos de cada asesor en el trimestre, con sus conversiones.",
      blocks: [{
        t: "table",
        headers: ["Asesor", "Leads", "Perfil.", "Citas", "Apartados", "$ Apartados", "Cierres", "$ Cierres", "L→P", "P→C", "C→A", "A→Ci"],
        rows: qd.advisors.map((a) => [
          a.name, int(a.total.leads), int(a.total.perfilamientos), int(a.total.citas), int(a.total.apartados), mxn(a.total.montoApartados),
          int(a.total.cierres), mxn(a.total.montoCierres), pct(a.conversions.leadPerfil), pct(a.conversions.perfilCita), pct(a.conversions.citaApartado), pct(a.conversions.apartadoCierre),
        ]),
      }],
    });
    sections.push({
      id: "ranking",
      title: "Ranking de apartados",
      explanation: `Monto apartado por asesor en el trimestre contra la meta de ${mxn(PMI_OBJECTIVES.montoApartados)} por cada mes con actividad.`,
      blocks: [{ t: "chart", type: "bar", valueLabel: "Monto (MXN)", series: qd.rankingApartados.map((r) => ({ label: r.name, value: r.monto })) }],
    });
  }
  sections.push(monthTrendSection(slice, qd), ...estimatedCallout(qd.estimatedCount));

  const cutoff = quarterCutoff(qd);
  return {
    reportType: "pmi",
    title: `Desempeño · ${scope} · ${label}`,
    locationName,
    periodLabel: cutoff === null ? label : `${label} (al ${cutoff}, trimestre en curso)`,
    filtersLabel: v.kind === "quarter-advisor" ? `Asesor: ${v.advisor.name}` : undefined,
    kpis: kpisOf(slice.total, slice.objectives.quarter),
    sections,
  };
}
