// lib/pmi.ts
// El motor del PMI: lo que la consultoría calcula a mano en su Excel, calculado
// desde el CRM. Puro y client-side, como lib/dashboard-filters.ts: el servidor
// sincroniza (y fecha los hitos en la bitácora), el navegador cuenta.
//
// Todo por día LOCAL (America/Mexico_City): el PMI cuenta "el apartado del
// martes 3", y un ISO en UTC corre seis horas el día — la misma trampa que
// drill-export y meta-attribution ya esquivan con localDay.
import type { Appointment, Contact, Opportunity, Pauta } from "./types";
import { localDay } from "./meta-attribution";
import { isDePauta } from "./pauta";

export type PmiIndicator = "leads" | "perfilamientos" | "citas" | "apartados" | "cierres";
export const PMI_INDICATORS: readonly PmiIndicator[] = ["leads", "perfilamientos", "citas", "apartados", "cierres"];

export interface PmiObjectives {
  leads: number;
  perfilamientos: number;
  citas: number;
  apartados: number;
  montoApartados: number;
  cierres: number;
  montoCierres: number;
}

// Por asesor y por mes, los del PMI de septiembre 2026. Fijos a propósito
// (decisión 9 del spec): nadie pidió administrarlos.
export const PMI_OBJECTIVES: PmiObjectives = {
  leads: 40,
  perfilamientos: 16,
  citas: 8,
  apartados: 2,
  montoApartados: 3_000_000,
  cierres: 2,
  montoCierres: 3_000_000,
};

export const PMI_CONVERSION_TARGETS = {
  leadPerfil: 0.4,
  perfilCita: 0.6,
  citaApartado: 0.75,
  apartadoCierre: 1.0,
} as const;

// Sacadas de las fórmulas del Excel (E7=E8*180%, E9=E8*75%): ALTO "superó la
// meta", MEDIO "alcanzó", BAJO "se acercó". Debajo, sin color.
export const PMI_BANDS = { alto: 1.8, medio: 1.0, bajo: 0.75 } as const;
export type PmiTone = "alto" | "medio" | "bajo" | null;

export function semaphore(value: number, objective: number): PmiTone {
  if (!(objective > 0)) return null;
  const r = value / objective;
  if (r >= PMI_BANDS.alto) return "alto";
  if (r >= PMI_BANDS.medio) return "medio";
  if (r >= PMI_BANDS.bajo) return "bajo";
  return null;
}

export function scaleObjectives(base: PmiObjectives, factor: number): PmiObjectives {
  return {
    leads: base.leads * factor,
    perfilamientos: base.perfilamientos * factor,
    citas: base.citas * factor,
    apartados: base.apartados * factor,
    montoApartados: base.montoApartados * factor,
    cierres: base.cierres * factor,
    montoCierres: base.montoCierres * factor,
  };
}

// ── Calendario ──────────────────────────────────────────────────────────────

export interface PmiWeek {
  index: number; // 0-based
  label: string; // "21 - 30"
  start: string; // YYYY-MM-DD
  end: string;
  days: string[];
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function monthDays(month: string): string[] {
  const [y, m] = month.split("-").map(Number);
  const count = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: count }, (_, i) => `${y}-${pad2(m)}-${pad2(i + 1)}`);
}

// 0 = domingo … 6 = sábado, del día calendario (no de un instante).
function weekdayOf(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// Lunes a domingo recortadas al mes. Un pedazo de menos de 4 días se pega a la
// semana vecina: reproduce las semanas del PMI (sept 2026 "21 - 30", ago 2026
// "1 - 9", jul 2026 con cinco semanas).
const MIN_WEEK_DAYS = 4;

export function monthWeeks(month: string): PmiWeek[] {
  const days = monthDays(month);
  const groups: string[][] = [];
  for (const day of days) {
    if (groups.length === 0 || weekdayOf(day) === 1) groups.push([day]);
    else groups[groups.length - 1].push(day);
  }
  if (groups.length > 1 && groups[0].length < MIN_WEEK_DAYS) {
    groups[1].unshift(...groups[0]);
    groups.shift();
  }
  if (groups.length > 1 && groups[groups.length - 1].length < MIN_WEEK_DAYS) {
    groups[groups.length - 2].push(...groups[groups.length - 1]);
    groups.pop();
  }
  return groups.map((g, index) => ({
    index,
    label: `${Number(g[0].slice(8))} - ${Number(g[g.length - 1].slice(8))}`,
    start: g[0],
    end: g[g.length - 1],
    days: g,
  }));
}

// ── Eventos ─────────────────────────────────────────────────────────────────

export interface PmiInput {
  contacts: Contact[];
  opportunities: Opportunity[];
  appointments: Appointment[];
  pautas: Pauta[];
}

export interface PmiEvent {
  kind: PmiIndicator;
  day: string; // local
  advisor: string; // UNASSIGNED cuando no hay
  id: string; // contacto, oportunidad o cita según kind
  monto: number; // solo apartados / cierres
  pauta: boolean; // solo leads
  estimated: boolean; // solo hitos
}

export const UNASSIGNED = "";

function advisorOf(name: string | undefined): string {
  return name?.trim() || UNASSIGNED;
}

// Contactos "de pauta": ligados a un objeto Pauta O con alguna oportunidad de
// tráfico pagado — la unión canónica de lib/pauta.ts, subida a contacto.
function pautaContactSet(input: PmiInput): Set<string> {
  const linked = new Set<string>();
  for (const p of input.pautas) if (p.contactId) linked.add(p.contactId);
  const out = new Set<string>(linked);
  for (const opp of input.opportunities) {
    if (opp.contactId && isDePauta(opp, linked)) out.add(opp.contactId);
  }
  return out;
}

// Todos los eventos del PMI entre dos días locales (inclusive). Una pasada por
// dataset; mes y año la comparten.
export function collectEvents(input: PmiInput, since: string, until: string): PmiEvent[] {
  const inRange = (day: string) => day >= since && day <= until;
  const pauta = pautaContactSet(input);
  const events: PmiEvent[] = [];

  for (const c of input.contacts) {
    if (!c.createdAt) continue;
    const day = localDay(c.createdAt);
    if (!inRange(day)) continue;
    events.push({ kind: "leads", day, advisor: advisorOf(c.assignedTo), id: c.id, monto: 0, pauta: pauta.has(c.id), estimated: false });
  }

  for (const opp of input.opportunities) {
    const m = opp.milestones;
    if (!m) continue;
    const advisor = advisorOf(opp.assignedTo);
    const estimated = m.estimated === true;
    const push = (kind: PmiIndicator, iso: string | undefined, monto: number) => {
      if (!iso) return;
      const day = localDay(iso);
      if (!inRange(day)) return;
      events.push({ kind, day, advisor, id: opp.id, monto, pauta: false, estimated });
    };
    push("perfilamientos", m.perfilado, 0);
    push("apartados", m.apartado, opp.value ?? 0);
    push("cierres", m.cierre, opp.value ?? 0);
  }

  for (const a of input.appointments) {
    if (a.status !== "showed" || !a.startTime) continue;
    const day = localDay(a.startTime);
    if (!inRange(day)) continue;
    events.push({ kind: "citas", day, advisor: advisorOf(a.assignedTo), id: a.id, monto: 0, pauta: false, estimated: false });
  }

  return events;
}

// ── Conteos ─────────────────────────────────────────────────────────────────

export interface PmiCounts {
  leads: number;
  leadsPauta: number;
  perfilamientos: number;
  citas: number;
  apartados: number;
  montoApartados: number;
  cierres: number;
  montoCierres: number;
  // Para el drill-down: contactos (leads), oportunidades (perfil/apartados/
  // cierres) y citas.
  ids: Record<PmiIndicator, string[]>;
}

export function emptyCounts(): PmiCounts {
  return {
    leads: 0, leadsPauta: 0, perfilamientos: 0, citas: 0,
    apartados: 0, montoApartados: 0, cierres: 0, montoCierres: 0,
    ids: { leads: [], perfilamientos: [], citas: [], apartados: [], cierres: [] },
  };
}

export function addEvent(c: PmiCounts, e: PmiEvent): void {
  c[e.kind] += 1;
  c.ids[e.kind].push(e.id);
  if (e.kind === "leads" && e.pauta) c.leadsPauta += 1;
  if (e.kind === "apartados") c.montoApartados += e.monto;
  if (e.kind === "cierres") c.montoCierres += e.monto;
}

export function sumCounts(list: PmiCounts[]): PmiCounts {
  const out = emptyCounts();
  for (const c of list) {
    out.leads += c.leads; out.leadsPauta += c.leadsPauta; out.perfilamientos += c.perfilamientos;
    out.citas += c.citas; out.apartados += c.apartados; out.montoApartados += c.montoApartados;
    out.cierres += c.cierres; out.montoCierres += c.montoCierres;
    for (const k of PMI_INDICATORS) out.ids[k].push(...c.ids[k]);
  }
  return out;
}

export interface PmiConversions {
  leadPerfil: number | null;
  perfilCita: number | null;
  citaApartado: number | null;
  apartadoCierre: number | null;
}

function ratio(num: number, den: number): number | null {
  return den > 0 ? num / den : null;
}

export function conversions(c: PmiCounts): PmiConversions {
  return {
    leadPerfil: ratio(c.perfilamientos, c.leads),
    perfilCita: ratio(c.citas, c.perfilamientos),
    citaApartado: ratio(c.apartados, c.citas),
    apartadoCierre: ratio(c.cierres, c.apartados),
  };
}

// ── Mes ─────────────────────────────────────────────────────────────────────

export interface PmiSlice {
  byWeek: PmiCounts[];
  byDay: PmiCounts[];
  total: PmiCounts;
  objectives: { month: PmiObjectives; week: PmiObjectives; day: PmiObjectives };
  conversions: PmiConversions;
}

export interface PmiAdvisor extends PmiSlice {
  name: string;
}

export interface PmiRankingRow {
  name: string;
  monto: number;
  count: number;
  avance: number | null; // monto ÷ objetivo del mes
}

export interface PmiMonth {
  month: string;
  weeks: PmiWeek[];
  days: string[];
  team: PmiSlice;
  advisors: PmiAdvisor[];
  unassigned: PmiSlice | null;
  activeAdvisors: number;
  rankingApartados: PmiRankingRow[];
  rankingCierres: PmiRankingRow[];
  estimatedCount: number;
}

const MONTHS_ES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${MONTHS_ES[m - 1]} ${y}`;
}

export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
}

export function currentMonth(now: Date = new Date()): string {
  return localDay(now.toISOString()).slice(0, 7);
}

// El objetivo diario es semanal ÷ 7 = mensual ÷ 28 — así lo hace el Excel
// (D8=C7/7), aunque el mes tenga 30 días o cinco semanas.
function buildSlice(events: PmiEvent[], weeks: PmiWeek[], days: string[], objectiveFactor: number): PmiSlice {
  const dayIndex = new Map(days.map((d, i) => [d, i]));
  const weekOfDay = new Map<string, number>();
  for (const w of weeks) for (const d of w.days) weekOfDay.set(d, w.index);

  const byDay = days.map(() => emptyCounts());
  const byWeek = weeks.map(() => emptyCounts());
  for (const e of events) {
    const di = dayIndex.get(e.day);
    if (di === undefined) continue;
    addEvent(byDay[di], e);
    addEvent(byWeek[weekOfDay.get(e.day)!], e);
  }
  const total = sumCounts(byWeek);
  const month = scaleObjectives(PMI_OBJECTIVES, objectiveFactor);
  return {
    byWeek,
    byDay,
    total,
    objectives: { month, week: scaleObjectives(month, 1 / 4), day: scaleObjectives(month, 1 / 28) },
    conversions: conversions(total),
  };
}

function ranking(advisors: PmiAdvisor[], kind: "apartados" | "cierres"): PmiRankingRow[] {
  const montoKey = kind === "apartados" ? "montoApartados" : "montoCierres";
  return advisors
    .map((a) => ({
      name: a.name,
      monto: a.total[montoKey],
      count: a.total[kind],
      avance: ratio(a.total[montoKey], PMI_OBJECTIVES[montoKey]),
    }))
    .sort((x, y) => y.monto - x.monto || y.count - x.count || x.name.localeCompare(y.name));
}

export function buildPmiMonth(input: PmiInput, month: string): PmiMonth {
  const days = monthDays(month);
  const weeks = monthWeeks(month);
  const events = collectEvents(input, days[0], days[days.length - 1]);

  const byAdvisor = new Map<string, PmiEvent[]>();
  for (const e of events) {
    const list = byAdvisor.get(e.advisor) ?? [];
    list.push(e);
    byAdvisor.set(e.advisor, list);
  }

  const names = [...byAdvisor.keys()].filter((n) => n !== UNASSIGNED).sort((a, b) => a.localeCompare(b, "es"));
  const advisors: PmiAdvisor[] = names.map((name) => ({
    name,
    ...buildSlice(byAdvisor.get(name)!, weeks, days, 1),
  }));

  const teamEvents = events.filter((e) => e.advisor !== UNASSIGNED);
  const team = buildSlice(teamEvents, weeks, days, names.length);

  const unassignedEvents = byAdvisor.get(UNASSIGNED) ?? [];
  const unassigned = unassignedEvents.length > 0 ? buildSlice(unassignedEvents, weeks, days, 0) : null;

  return {
    month,
    weeks,
    days,
    team,
    advisors,
    unassigned,
    activeAdvisors: names.length,
    rankingApartados: ranking(advisors, "apartados"),
    rankingCierres: ranking(advisors, "cierres"),
    estimatedCount: events.filter((e) => e.estimated).length,
  };
}

// ── Año (la hoja DASH) ──────────────────────────────────────────────────────

export interface PmiYearAdvisor {
  name: string;
  byMonth: PmiCounts[]; // 12
  byQuarter: PmiCounts[]; // 4
  total: PmiCounts;
  mesesActivo: number; // meses con algún registro
  promedio: PmiCounts | null; // total ÷ mesesActivo (ids vacíos)
  ticketPromedio: number | null; // montoCierres ÷ cierres
}

export interface PmiYearRankingRow {
  name: string;
  monto: number;
  count: number;
  mesesActivo: number;
  avance: number | null; // monto ÷ (objetivo mensual × mesesActivo)
  paraLlegar: number;
  promedio: number | null; // monto ÷ mesesActivo
}

export interface PmiYear {
  year: number;
  advisors: PmiYearAdvisor[];
  team: {
    byMonth: PmiCounts[];
    byQuarter: PmiCounts[];
    total: PmiCounts;
    activeByMonth: number[]; // asesores con actividad, por mes
    pctMeta: (PmiObjectives | null)[]; // avance por mes; null sin asesores activos
  };
  rankingApartados: PmiYearRankingRow[];
  rankingCierres: PmiYearRankingRow[];
  estimatedCount: number;
}

function divideCounts(c: PmiCounts, n: number): PmiCounts | null {
  if (!(n > 0)) return null;
  const out = emptyCounts();
  out.leads = c.leads / n; out.leadsPauta = c.leadsPauta / n; out.perfilamientos = c.perfilamientos / n;
  out.citas = c.citas / n; out.apartados = c.apartados / n; out.montoApartados = c.montoApartados / n;
  out.cierres = c.cierres / n; out.montoCierres = c.montoCierres / n;
  return out;
}

function hasActivity(c: PmiCounts): boolean {
  return c.leads + c.perfilamientos + c.citas + c.apartados + c.cierres > 0;
}

function quarters(byMonth: PmiCounts[]): PmiCounts[] {
  return [0, 1, 2, 3].map((q) => sumCounts(byMonth.slice(q * 3, q * 3 + 3)));
}

function yearRanking(advisors: PmiYearAdvisor[], kind: "apartados" | "cierres"): PmiYearRankingRow[] {
  const montoKey = kind === "apartados" ? "montoApartados" : "montoCierres";
  return advisors
    .map((a) => {
      const meta = PMI_OBJECTIVES[montoKey] * a.mesesActivo;
      const monto = a.total[montoKey];
      return {
        name: a.name,
        monto,
        count: a.total[kind],
        mesesActivo: a.mesesActivo,
        avance: ratio(monto, meta),
        paraLlegar: Math.max(0, meta - monto),
        promedio: ratio(monto, a.mesesActivo),
      };
    })
    .sort((x, y) => y.monto - x.monto || y.count - x.count || x.name.localeCompare(y.name));
}

export function buildPmiYear(input: PmiInput, year: number): PmiYear {
  const events = collectEvents(input, `${year}-01-01`, `${year}-12-31`);
  const monthOf = (day: string) => Number(day.slice(5, 7)) - 1;

  const byAdvisor = new Map<string, PmiCounts[]>();
  for (const e of events) {
    if (e.advisor === UNASSIGNED) continue;
    let months = byAdvisor.get(e.advisor);
    if (!months) {
      months = Array.from({ length: 12 }, () => emptyCounts());
      byAdvisor.set(e.advisor, months);
    }
    addEvent(months[monthOf(e.day)], e);
  }

  const advisors: PmiYearAdvisor[] = [...byAdvisor.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], "es"))
    .map(([name, byMonth]) => {
      const total = sumCounts(byMonth);
      const mesesActivo = byMonth.filter(hasActivity).length;
      return {
        name,
        byMonth,
        byQuarter: quarters(byMonth),
        total,
        mesesActivo,
        promedio: divideCounts(total, mesesActivo),
        ticketPromedio: ratio(total.montoCierres, total.cierres),
      };
    });

  const teamByMonth = Array.from({ length: 12 }, (_, i) => sumCounts(advisors.map((a) => a.byMonth[i])));
  const activeByMonth = Array.from({ length: 12 }, (_, i) => advisors.filter((a) => hasActivity(a.byMonth[i])).length);
  const pctMeta = teamByMonth.map((c, i) => {
    const n = activeByMonth[i];
    if (n === 0) return null;
    const o = scaleObjectives(PMI_OBJECTIVES, n);
    return {
      leads: c.leads / o.leads,
      perfilamientos: c.perfilamientos / o.perfilamientos,
      citas: c.citas / o.citas,
      apartados: c.apartados / o.apartados,
      montoApartados: c.montoApartados / o.montoApartados,
      cierres: c.cierres / o.cierres,
      montoCierres: c.montoCierres / o.montoCierres,
    };
  });

  return {
    year,
    advisors,
    team: { byMonth: teamByMonth, byQuarter: quarters(teamByMonth), total: sumCounts(teamByMonth), activeByMonth, pctMeta },
    rankingApartados: yearRanking(advisors, "apartados"),
    rankingCierres: yearRanking(advisors, "cierres"),
    estimatedCount: events.filter((e) => e.estimated && e.advisor !== UNASSIGNED).length,
  };
}
