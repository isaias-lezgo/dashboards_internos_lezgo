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
