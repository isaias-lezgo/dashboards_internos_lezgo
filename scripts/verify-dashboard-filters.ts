// Verification for lib/dashboard-filters.ts. Run: pnpm verify:filters
//
// Lo que se protege aquí es la cascada por contacto: un error silencioso en estos
// predicados no rompe nada visible, solo hace que dos números de la misma
// pantalla hablen de universos distintos.
//
// Wrapped in main() rather than using top-level await: this package is CJS.
import assert from "node:assert/strict";
import type { Appointment, Contact, Message, Opportunity, Pauta, Task } from "../lib/types";
import {
  EMPTY_FILTERS,
  SIN_ASESOR,
  SIN_ORIGEN,
  SIN_PAUTA,
  applyDashboardFilters,
  buildFilterContext,
  buildFilterOptions,
  buildFirstPautaTipoByContact,
  describeFilters,
  hasActiveFilters,
  opportunityPasses,
  originsOfOpportunity,
  statusKey,
  type DashboardFilters,
} from "../lib/dashboard-filters";

// ── Fixtures ───────────────────────────────────────────────────────────────

function contact(id: string, over: Partial<Contact> = {}): Contact {
  return {
    id,
    name: id,
    email: "",
    phone: "",
    tags: [],
    dateAdded: "2026-01-01T00:00:00Z",
    createdAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function opp(id: string, over: Partial<Opportunity> = {}): Opportunity {
  return {
    id,
    name: id,
    pipelineId: "p1",
    pipelineStageId: "s1",
    status: "open",
    createdAt: "2026-01-01T00:00:00Z",
    contactId: "",
    value: 0,
    stage: "01. Nuevo",
    pipelineName: "Ventas",
    ...over,
  };
}

function pauta(id: string, contactId: string, tipo: string, createdAt: string): Pauta {
  return { id, tipo, nombrePauta: id, createdAt, contactId };
}

const EMPTY_DATA = {
  opportunities: [] as Opportunity[],
  contacts: [] as Contact[],
  appointments: [] as Appointment[],
  tasks: [] as Task[],
  pautas: [] as Pauta[],
  messages: [] as Message[],
};

function filters(over: Partial<DashboardFilters>): DashboardFilters {
  return { ...EMPTY_FILTERS, ...over };
}

async function main() {
  // ── statusKey: la partición del panel, no el campo crudo de GHL ───────────
  // La razón de ser del filtro: sub-cuentas que registran la venta moviendo la
  // etapa y dejan status === "open". Con el campo crudo esto daría "Abierto" y
  // el filtro "Ganado" devolvería cero junto a un KPI que muestra decenas.
  assert.equal(statusKey(opp("a", { status: "open", stage: "09. Negocio Ganado" })), "won");
  assert.equal(statusKey(opp("b", { status: "won" })), "won");
  assert.equal(statusKey(opp("c", { status: "open" })), "open");
  assert.equal(statusKey(opp("d", { status: "lost" })), "lost");
  assert.equal(statusKey(opp("e", { status: "abandoned" })), "abandoned");
  // Marcada como perdida DESPUÉS de haber pasado por la etapa ganada: pierde.
  assert.equal(statusKey(opp("f", { status: "lost", stage: "09. Negocio Ganado" })), "lost");

  // ── Origen de lead: campo de la oportunidad, fallback al del contacto ─────
  const conCampoPropio = opp("o", {
    contactId: "c1",
    customFieldsResolved: { "Origen de Lead": "Instagram" },
  });
  assert.deepEqual(originsOfOpportunity(conCampoPropio), ["Instagram"]);

  // El nombre del campo varía por sub-cuenta: el match es por substring.
  assert.deepEqual(
    originsOfOpportunity(opp("o2", { customFieldsResolved: { "ORIGEN DEL LEAD": "TikTok" } })),
    ["TikTok"],
  );

  // Fallback al contacto cuando la oportunidad no trae el campo.
  const dueño = contact("c1", { customFieldsResolved: { "Origen de Lead": "Facebook" } });
  assert.deepEqual(originsOfOpportunity(opp("o3", { contactId: "c1" }), dueño), ["Facebook"]);

  // El campo propio gana sobre el del contacto.
  assert.deepEqual(originsOfOpportunity(conCampoPropio, dueño), ["Instagram"]);

  // Opción múltiple: pertenece a todos sus valores.
  assert.deepEqual(
    originsOfOpportunity(opp("o4", { customFieldsResolved: { "Origen de Lead": ["Facebook", "Instagram"] } })),
    ["Facebook", "Instagram"],
  );

  // Último recurso: lo que lib/sync.ts copió a originPlatform.
  assert.deepEqual(originsOfOpportunity(opp("o5", { originPlatform: "Google" })), ["Google"]);
  assert.deepEqual(originsOfOpportunity(opp("o6")), [SIN_ORIGEN]);

  // ── Primera pauta del contacto ────────────────────────────────────────────
  const historial = [
    pauta("p2", "c1", "Meta Ads", "2026-03-01T00:00:00Z"),
    pauta("p1", "c1", "Google Ads", "2026-01-01T00:00:00Z"),
    pauta("p3", "c2", "Formulario", "2026-02-01T00:00:00Z"),
    // Pauta huérfana: sin contacto, no clasifica a nadie.
    { id: "p4", tipo: "Meta Ads", nombrePauta: "x", createdAt: "2026-01-01T00:00:00Z" } as Pauta,
  ];
  const primeras = buildFirstPautaTipoByContact(historial);
  assert.equal(primeras.get("c1"), "Google Ads", "gana la más antigua, no la primera del arreglo");
  assert.equal(primeras.get("c2"), "Formulario");
  assert.equal(primeras.size, 2, "una pauta sin contactId no crea entrada");

  // ── Opción múltiple: basta un valor seleccionado (O dentro del filtro) ────
  const ctxMulti = buildFilterContext([], []);
  const multi = opp("m", { customFieldsResolved: { "Origen de Lead": ["Facebook", "Instagram"] } });
  assert.ok(opportunityPasses(multi, filters({ origins: ["Instagram"] }), ctxMulti));
  assert.ok(!opportunityPasses(multi, filters({ origins: ["TikTok"] }), ctxMulti));

  // ── Y entre categorías ────────────────────────────────────────────────────
  const ana = opp("ana", { status: "won", assignedTo: "Ana" });
  assert.ok(opportunityPasses(ana, filters({ status: ["won"], advisors: ["Ana"] }), ctxMulti));
  assert.ok(!opportunityPasses(ana, filters({ status: ["won"], advisors: ["Beto"] }), ctxMulti));

  // ── Sin filtros activos: los MISMOS arreglos por referencia ──────────────
  // Si esto se rompe, los memos aguas abajo se invalidan en cada render y el
  // panel sin filtros deja de comportarse como antes de que existiera la barra.
  const base = {
    ...EMPTY_DATA,
    opportunities: [ana],
    contacts: [contact("c1")],
    pautas: [historial[0]],
  };
  const ctxBase = buildFilterContext(base.contacts, historial);
  const passthrough = applyDashboardFilters(base, EMPTY_FILTERS, ctxBase);
  assert.equal(passthrough.opportunities, base.opportunities, "misma referencia, no una copia");
  assert.equal(passthrough.contacts, base.contacts);
  assert.equal(passthrough.pautas, base.pautas);
  assert.equal(passthrough.allowedContactIds, null);
  assert.equal(hasActiveFilters(EMPTY_FILTERS), false);

  // ── LA CASCADA ────────────────────────────────────────────────────────────
  // c1 tiene dos oportunidades de status distinto; c2 una perdida; c3 ninguna.
  const contacts = [
    contact("c1", { assignedTo: "Ana" }),
    contact("c2", { assignedTo: "Beto" }),
    contact("c3", { assignedTo: "Ana", customFieldsResolved: { "Origen de Lead": "Instagram" } }),
  ];
  const opportunities = [
    opp("o-c1-won", { contactId: "c1", assignedTo: "Ana", status: "won" }),
    opp("o-c1-lost", { contactId: "c1", assignedTo: "Ana", status: "lost" }),
    opp("o-c2-lost", { contactId: "c2", assignedTo: "Beto", status: "lost" }),
  ];
  const appointments: Appointment[] = [
    { id: "a1", contactId: "c1", startTime: "2026-02-01T00:00:00Z", endTime: "2026-02-01T01:00:00Z", status: "showed" },
    { id: "a2", contactId: "c2", startTime: "2026-02-01T00:00:00Z", endTime: "2026-02-01T01:00:00Z", status: "showed" },
    { id: "a3", contactId: "c3", startTime: "2026-02-01T00:00:00Z", endTime: "2026-02-01T01:00:00Z", status: "showed" },
  ];
  const tasks: Task[] = [
    { id: "t1", title: "t1", status: "pending", contactId: "c2" },
  ];
  const pautas = [
    pauta("pa1", "c1", "Google Ads", "2026-01-01T00:00:00Z"),
    pauta("pa2", "c2", "Meta Ads", "2026-01-01T00:00:00Z"),
    // Relación rota del escenario de Make: no es atribuible a nadie.
    { id: "pa3", tipo: "Google Ads", nombrePauta: "huérfana", createdAt: "2026-01-01T00:00:00Z" } as Pauta,
  ];
  const messages: Message[] = [
    { id: "m1", contactId: "c1", direction: "inbound", source: "whatsapp", createdAt: "2026-02-01T00:00:00Z" },
    { id: "m2", contactId: "c3", direction: "inbound", source: "whatsapp", createdAt: "2026-02-01T00:00:00Z" },
  ];
  const data = { opportunities, contacts, appointments, tasks, pautas, messages };
  const ctx = buildFilterContext(contacts, pautas);

  // Status = Ganado. Solo sobrevive la oportunidad ganada de c1; c1 arrastra su
  // cita y su mensaje. c2 desaparece entero. c3 NO tiene oportunidades, y con un
  // filtro de status activo eso significa que no puede estar "Ganado": se cae, y
  // ese cero de "leads sin oportunidad" es real.
  const ganado = applyDashboardFilters(data, filters({ status: ["won"] }), ctx);
  assert.deepEqual(ganado.opportunities.map((o) => o.id), ["o-c1-won"]);
  assert.deepEqual(ganado.contacts.map((c) => c.id), ["c1"]);
  assert.deepEqual(ganado.appointments.map((a) => a.id), ["a1"]);
  assert.deepEqual(ganado.tasks.map((t) => t.id), []);
  assert.deepEqual(ganado.pautas.map((p) => p.id), ["pa1"], "la pauta huérfana se cae");
  assert.deepEqual(ganado.messages.map((m) => m.id), ["m1"]);
  assert.equal(ganado.totalOpportunities, 3, "el contador N de M cuenta el total previo");

  // c1 tiene una ganada y una perdida: con status Perdido sigue vivo, y con él
  // sobrevive SOLO su oportunidad perdida.
  const perdido = applyDashboardFilters(data, filters({ status: ["lost"] }), ctx);
  assert.deepEqual(perdido.opportunities.map((o) => o.id), ["o-c1-lost", "o-c2-lost"]);
  assert.deepEqual(perdido.contacts.map((c) => c.id), ["c1", "c2"]);

  // Asesor Ana: la oportunidad de Beto se cae, y c3 — sin oportunidades — pasa
  // por su PROPIO assignedTo. Este es el caso que la cascada ingenua borraba.
  const deAna = applyDashboardFilters(data, filters({ advisors: ["Ana"] }), ctx);
  assert.deepEqual(deAna.opportunities.map((o) => o.id), ["o-c1-won", "o-c1-lost"]);
  assert.deepEqual(deAna.contacts.map((c) => c.id), ["c1", "c3"], "c3 sobrevive sin oportunidades");
  assert.deepEqual(deAna.appointments.map((a) => a.id), ["a1", "a3"]);
  assert.deepEqual(deAna.messages.map((m) => m.id), ["m1", "m2"]);

  // Origen leído sobre el contacto huérfano: c3 tiene "Instagram" propio y pasa,
  // aunque ninguna oportunidad lo tenga.
  const insta = applyDashboardFilters(data, filters({ origins: ["Instagram"] }), ctx);
  assert.deepEqual(insta.opportunities.map((o) => o.id), []);
  assert.deepEqual(insta.contacts.map((c) => c.id), ["c3"]);

  // Tipo de pauta = la PRIMERA del contacto. c3 no tiene ninguna → "Sin pauta".
  const google = applyDashboardFilters(data, filters({ pautaTypes: ["Google Ads"] }), ctx);
  assert.deepEqual(google.contacts.map((c) => c.id), ["c1"]);
  const sinPauta = applyDashboardFilters(data, filters({ pautaTypes: [SIN_PAUTA] }), ctx);
  assert.deepEqual(sinPauta.contacts.map((c) => c.id), ["c3"]);

  // Y entre categorías, sobre la cascada completa.
  const anaYGanado = applyDashboardFilters(data, filters({ advisors: ["Ana"], status: ["won"] }), ctx);
  assert.deepEqual(anaYGanado.opportunities.map((o) => o.id), ["o-c1-won"]);
  assert.deepEqual(anaYGanado.contacts.map((c) => c.id), ["c1"], "c3 se cae: status excluye huérfanos");

  // ── Opciones de los menús ─────────────────────────────────────────────────
  const options = buildFilterOptions(opportunities, ctx);
  assert.deepEqual(options.status.map((o) => o.value), ["won", "lost"], "orden canónico, no por volumen");
  assert.deepEqual(options.advisors.map((o) => o.value), ["Ana", "Beto"]);
  assert.deepEqual(
    options.advisors.map((o) => o.count),
    [2, 1],
    "cuenta oportunidades, no contactos",
  );
  assert.deepEqual(options.pautaTypes.map((o) => o.value), ["Google Ads", "Meta Ads"]);
  assert.deepEqual(options.origins.map((o) => o.value), [SIN_ORIGEN]);

  // El residuo va al final aunque sea el cubo más grande.
  const conSinAsignar = buildFilterOptions(
    [
      opp("x1", { assignedTo: "Ana" }),
      opp("x2"),
      opp("x3"),
      opp("x4"),
    ],
    ctx,
  );
  assert.deepEqual(
    conSinAsignar.advisors.map((o) => o.value),
    ["Ana", SIN_ASESOR],
    "'Sin asignar' se clava al final aunque tenga 3 contra 1",
  );

  // ── Etiqueta del PDF ──────────────────────────────────────────────────────
  assert.equal(describeFilters(EMPTY_FILTERS), null);
  assert.equal(
    describeFilters(filters({ status: ["won"], advisors: ["Ana", "Beto"] })),
    "Status: Ganado · Asesor: Ana, Beto",
  );
  assert.equal(
    describeFilters(filters({ advisors: ["Ana", "Beto", "Cris"] })),
    "Asesor: Ana +2",
    "se resume en vez de crecer sin límite en la portada",
  );

  console.log("verify:filters — todas las aserciones pasaron ✅");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
