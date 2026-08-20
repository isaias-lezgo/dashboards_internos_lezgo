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
  MONTSE_CAMPAIGN_HEADLINE,
  NO_IDENTIFICADO,
  SEGMENT_DEFS,
  SIN_ASESOR,
  SIN_ORIGEN,
  SIN_PAUTA,
  applyDashboardFilters,
  buildFilterContext,
  buildFilterOptions,
  buildFirstPautaTipoByContact,
  countActiveFilters,
  describeFilters,
  hasActiveFilters,
  isMontseCampaign,
  opportunityPasses,
  originsOfOpportunity,
  segmentOfContact,
  segmentOfOpportunity,
  statusKey,
  type DashboardFilters,
  type SegmentDef,
} from "../lib/dashboard-filters";
import { campaignHeadline } from "../lib/pauta";

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

function namedPauta(id: string, contactId: string, nombrePauta: string, createdAt: string): Pauta {
  return { id, tipo: "Mensaje WhatsApp", nombrePauta, createdAt, contactId };
}

const PLAZA: SegmentDef = SEGMENT_DEFS.find((d) => d.key === "plaza")!;
const AGENCIA: SegmentDef = SEGMENT_DEFS.find((d) => d.key === "agencia")!;

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
  const ctxMulti = buildFilterContext([], [], []);
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
  const ctxBase = buildFilterContext(base.contacts, historial, base.opportunities);
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
  const ctx = buildFilterContext(contacts, pautas, opportunities);

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

  // ── Registro dentro de la ventana, contacto fuera ─────────────────────────
  // El caso de Balvanera: el escenario de Make creó el 3 de agosto ocho pautas
  // para contactos entrados en julio. La pauta cae en la ventana; el contacto y su
  // oportunidad, no. Antes de `outOfWindowContactPasses` esas pautas se caían con
  // CUALQUIER filtro activo, incluso uno que seleccionara todas sus opciones, y la
  // gráfica "Pautas por canal" pasaba de 21 a 13 formularios sin explicación.
  const cJulio = contact("c-julio", { assignedTo: "Ana", createdAt: "2026-07-22T00:00:00Z" });
  const oJulio = opp("o-julio", {
    contactId: "c-julio",
    assignedTo: "Ana",
    status: "won",
    createdAt: "2026-07-22T00:00:00Z",
  });
  const pAgosto = pauta("p-agosto", "c-julio", "Formulario", "2026-08-03T19:02:00Z");

  // `data` simula lo que llega YA recortado por fecha: la pauta sí, el contacto y
  // la oportunidad no. El contexto, en cambio, se construye sobre el historial.
  const rezagada = {
    ...EMPTY_DATA,
    opportunities: [...opportunities],
    contacts: [...contacts],
    pautas: [...pautas, pAgosto],
  };
  const ctxRezagada = buildFilterContext(
    [...contacts, cJulio],
    [...pautas, pAgosto],
    [...opportunities, oJulio],
  );

  // Sin filtros la pauta ya se veía; el bug era que aparecer/desaparecer dependía
  // de que hubiera un filtro activo.
  assert.ok(
    applyDashboardFilters(rezagada, EMPTY_FILTERS, ctxRezagada).pautas.includes(pAgosto),
  );

  // Filtro que selecciona TODAS las opciones: no debe borrar nada.
  const todoSeleccionado = filters({
    advisors: ["Ana", "Beto", SIN_ASESOR],
    pautaTypes: ["Google Ads", "Meta Ads", "Formulario", SIN_PAUTA],
  });
  assert.ok(
    applyDashboardFilters(rezagada, todoSeleccionado, ctxRezagada).pautas.includes(pAgosto),
    "un filtro que selecciona todo no puede recortar nada",
  );

  // Y el criterio se respeta: la pauta entra por Formulario, no por Meta Ads.
  assert.ok(
    applyDashboardFilters(rezagada, filters({ pautaTypes: ["Formulario"] }), ctxRezagada)
      .pautas.includes(pAgosto),
  );
  assert.ok(
    !applyDashboardFilters(rezagada, filters({ pautaTypes: ["Meta Ads"] }), ctxRezagada)
      .pautas.includes(pAgosto),
  );

  // Status se juzga contra la oportunidad de julio: es la única que existe.
  assert.ok(
    applyDashboardFilters(rezagada, filters({ status: ["won"] }), ctxRezagada)
      .pautas.includes(pAgosto),
  );
  assert.ok(
    !applyDashboardFilters(rezagada, filters({ status: ["lost"] }), ctxRezagada)
      .pautas.includes(pAgosto),
  );

  // El contacto rezagado NO entra al dataset de contactos: eso movería "Leads sin
  // oportunidad", que se mide contra la ventana de fechas.
  assert.deepEqual(
    applyDashboardFilters(rezagada, filters({ advisors: ["Ana"] }), ctxRezagada)
      .contacts.map((c) => c.id),
    ["c1", "c3"],
    "la puerta de atrás alcanza a los registros, no al dataset de contactos",
  );

  // Un contacto CON oportunidad en la ventana que el filtro rechazó no se
  // readmite por tener registros: eso contradiría el filtro.
  const rechazado = applyDashboardFilters(rezagada, filters({ advisors: ["Ana"] }), ctxRezagada);
  assert.ok(!rechazado.pautas.some((p) => p.id === "pa2"), "c2 es de Beto: su pauta se queda fuera");

  // ── Opciones de los menús ─────────────────────────────────────────────────
  // Un valor aparece en el menú si y sólo si algún registro puede ser
  // seleccionado por él. c3 no tiene oportunidades, así que sus valores sólo
  // llegan por la segunda pasada sobre contactos huérfanos.
  const options = buildFilterOptions(opportunities, contacts, ctx);
  assert.deepEqual(options.status.map((o) => o.value), ["won", "lost"], "orden canónico, no por volumen");

  // Status NO recibe a los huérfanos: sus cubos salen sólo de oportunidades, y un
  // contacto sin oportunidad no tiene status. 2 ganada+perdida de c1, 1 de c2.
  assert.deepEqual(options.status.map((o) => o.count), [1, 2], "status sigue contando sólo oportunidades");

  assert.deepEqual(options.advisors.map((o) => o.value), ["Ana", "Beto"]);
  assert.deepEqual(
    options.advisors.map((o) => o.count),
    [3, 1],
    "unidades filtrables: 2 oportunidades de Ana + el contacto huérfano c3",
  );

  // Instagram sólo existe en c3, que no tiene oportunidades. Antes de la segunda
  // pasada este menú era [SIN_ORIGEN] y el valor era imposible de seleccionar
  // pese a que orphanContactPasses sí lo evaluaba: 433 leads de TikTok en Lezgo
  // Suite estaban en ese hueco.
  assert.deepEqual(
    options.origins.map((o) => o.value),
    ["Instagram", SIN_ORIGEN],
    "el origen de un contacto sin oportunidades es seleccionable",
  );
  assert.deepEqual(options.origins.map((o) => o.count), [1, 3]);

  // c3 no tiene pautas → SIN_PAUTA, y el residuo va al final pese al empate.
  assert.deepEqual(
    options.pautaTypes.map((o) => o.value),
    ["Google Ads", "Meta Ads", SIN_PAUTA],
  );

  // El residuo va al final aunque sea el cubo más grande.
  const conSinAsignar = buildFilterOptions(
    [
      opp("x1", { assignedTo: "Ana" }),
      opp("x2"),
      opp("x3"),
      opp("x4"),
    ],
    [],
    ctx,
  );
  assert.deepEqual(
    conSinAsignar.advisors.map((o) => o.value),
    ["Ana", SIN_ASESOR],
    "'Sin asignar' se clava al final aunque tenga 3 contra 1",
  );

  // Un contacto que SÍ es dueño de una oportunidad de la ventana no se cuenta dos
  // veces: la segunda pasada es sólo para huérfanos.
  const sinDobleConteo = buildFilterOptions(opportunities, [contacts[0]], ctx);
  assert.deepEqual(
    sinDobleConteo.advisors.map((o) => o.count),
    [2, 1],
    "c1 ya aportó por sus oportunidades; no suma otra vez como contacto",
  );

  // ── Criterios por segmento ────────────────────────────────────────────────
  // El match del nombre del campo es exacto salvo mayúsculas: un match laxo haría
  // que un campo ajeno de otra sub-cuenta inventara un criterio donde no existe.
  assert.equal(
    segmentOfOpportunity(opp("s1", { customFieldsResolved: { "bosques o meseta para dash": "Plaza Meseta" } }), PLAZA),
    "Plaza Meseta",
    "el nombre del campo no distingue mayúsculas",
  );
  assert.equal(
    segmentOfOpportunity(opp("s2", { customFieldsResolved: { "Bosques o Meseta para el Dash": "Plaza Meseta" } }), PLAZA),
    NO_IDENTIFICADO,
    "un nombre parecido NO cuenta: el match es exacto, no por substring",
  );

  // Fallback al contacto, y el campo propio de la oportunidad ganándole.
  const cMeseta = contact("c-meseta", {
    customFieldsResolved: { "Plaza Bosques o Plaza Meseta": "Plaza Meseta" },
  });
  assert.equal(segmentOfOpportunity(opp("s3", { contactId: "c-meseta" }), PLAZA, cMeseta), "Plaza Meseta");
  assert.equal(
    segmentOfOpportunity(
      opp("s4", { contactId: "c-meseta", customFieldsResolved: { "Bosques o Meseta para Dash": "Plaza Bosques" } }),
      PLAZA,
      cMeseta,
    ),
    "Plaza Bosques",
    "el campo de la oportunidad gana sobre el del contacto",
  );

  // Sin señal cae en el cubo de residuo, que es una opción seleccionable.
  assert.equal(segmentOfOpportunity(opp("s5"), PLAZA), NO_IDENTIFICADO);
  assert.equal(segmentOfContact(contact("s6"), AGENCIA), NO_IDENTIFICADO);

  // ── El criterio EXISTE sólo donde hay algo que separar ────────────────────
  // Sin un solo valor real, `NO_IDENTIFICADO` no puede inventar un menú de un
  // valor en los proyectos que nunca declararon el campo.
  const ctxVacio = buildFilterContext([], [], []);
  const sinCampo = buildFilterOptions([opp("n1"), opp("n2")], [contact("n3")], ctxVacio);
  assert.deepEqual(sinCampo.segments.plaza, [], "sin el campo, el criterio no existe");
  assert.deepEqual(sinCampo.segments.agencia, []);
  assert.equal(sinCampo.montse, false, "sin agencia no se dibuja el toggle de Montse");

  const conPlaza = buildFilterOptions(
    [
      opp("p-b", { customFieldsResolved: { "Bosques o Meseta para Dash": "Plaza Bosques" } }),
      opp("p-m", { customFieldsResolved: { "Bosques o Meseta para Dash": "Plaza Meseta" } }),
      opp("p-x"),
      opp("p-y"),
    ],
    [],
    ctxVacio,
  );
  assert.deepEqual(
    conPlaza.segments.plaza.map((o) => o.value),
    ["Plaza Bosques", "Plaza Meseta", NO_IDENTIFICADO],
    "'No identificado' se clava al final aunque empate o gane en volumen",
  );
  assert.deepEqual(conPlaza.segments.plaza.map((o) => o.count), [1, 1, 2]);
  assert.deepEqual(conPlaza.segments.agencia, [], "un criterio no arrastra al otro");
  assert.equal(conPlaza.montse, false);

  // El toggle se dibuja donde existe la agencia, no donde la campaña tenga leads:
  // un control que aparece y desaparece al mover las fechas es peor que uno que a
  // veces da cero.
  const conAgencia = buildFilterOptions(
    [opp("a-iw", { customFieldsResolved: { "IW o DOMUS": "IW" } })],
    [],
    ctxVacio,
  );
  assert.equal(conAgencia.montse, true, "el toggle sale con la agencia, sin exigir leads de Montse");

  // El valor de un contacto huérfano llega al menú: si no, sería filtrable e
  // inseleccionable a la vez — el mismo hueco que escondía 433 leads de TikTok.
  const soloHuerfano = buildFilterOptions(
    [],
    [contact("h1", { customFieldsResolved: { "IW o DOMUS": "DOMUS" } })],
    ctxVacio,
  );
  assert.deepEqual(soloHuerfano.segments.agencia.map((o) => o.value), ["DOMUS"]);

  // ── La cascada del segmento ───────────────────────────────────────────────
  const cBosques = contact("cb", { customFieldsResolved: { "Plaza Bosques o Plaza Meseta": "Plaza Bosques" } });
  const cSinPlaza = contact("cs");
  const oBosques = opp("ob", {
    contactId: "cb",
    customFieldsResolved: { "Bosques o Meseta para Dash": "Plaza Bosques" },
  });
  const oMeseta = opp("om", {
    contactId: "cm",
    customFieldsResolved: { "Bosques o Meseta para Dash": "Plaza Meseta" },
  });
  const plazaData = {
    ...EMPTY_DATA,
    opportunities: [oBosques, oMeseta],
    contacts: [cBosques, cSinPlaza],
  };
  const ctxPlaza = buildFilterContext(plazaData.contacts, [], plazaData.opportunities);

  const soloBosques = applyDashboardFilters(
    plazaData,
    filters({ segments: { plaza: ["Plaza Bosques"] } }),
    ctxPlaza,
  );
  assert.deepEqual(soloBosques.opportunities.map((o) => o.id), ["ob"]);
  assert.deepEqual(soloBosques.contacts.map((c) => c.id), ["cb"], "el huérfano sin plaza se cae");

  // Y el huérfano SÍ entra por su propio campo cuando se selecciona su cubo.
  const sinPlaza = applyDashboardFilters(
    plazaData,
    filters({ segments: { plaza: [NO_IDENTIFICADO] } }),
    ctxPlaza,
  );
  assert.deepEqual(sinPlaza.opportunities.map((o) => o.id), []);
  assert.deepEqual(sinPlaza.contacts.map((c) => c.id), ["cs"], "un contacto sin plaza es seleccionable");

  // Un segmento con arreglo vacío no filtra nada, igual que los demás criterios.
  assert.equal(hasActiveFilters(filters({ segments: { plaza: [] } })), false);
  assert.equal(hasActiveFilters(filters({ segments: { plaza: ["Plaza Meseta"] } })), true);
  assert.equal(countActiveFilters(filters({ segments: { plaza: ["Plaza Meseta"], agencia: ["IW"] } })), 2);

  // Sin filtros activos siguen siendo los MISMOS arreglos por referencia.
  const passthroughSeg = applyDashboardFilters(plazaData, filters({ segments: { plaza: [] } }), ctxPlaza);
  assert.equal(passthroughSeg.opportunities, plazaData.opportunities);

  // ── El headline de un anuncio ─────────────────────────────────────────────
  // Meta parte una misma campaña en un nombre por creatividad; el corte los junta.
  assert.equal(
    campaignHeadline("Depa Desde $1,900,000 en Qro - https://fb.me/aJjfJmi1K - 120251583532750437"),
    MONTSE_CAMPAIGN_HEADLINE,
  );
  assert.equal(
    campaignHeadline("Depa Desde $1,900,000 en Qro - https://www.instagram.com/p/DcM5WesgZBG/ - 120251583532750437"),
    MONTSE_CAMPAIGN_HEADLINE,
    "la otra liga de la MISMA campaña colapsa al mismo headline",
  );
  // Lo que NO debe cortarse: los nombres de formulario también separan con
  // guiones, pero no terminan en un id de adset.
  assert.equal(
    campaignHeadline("IW - CC - FF - Corregidora - Enero 2026"),
    "IW - CC - FF - Corregidora - Enero 2026",
    "un nombre de formulario queda intacto",
  );
  assert.equal(campaignHeadline("FORM | DOMUS | CONDESA"), "FORM | DOMUS | CONDESA");
  assert.equal(campaignHeadline("facebook_formulario - 120249814624870104"), "facebook_formulario - 120249814624870104");

  // ── El toggle de Montse ───────────────────────────────────────────────────
  assert.ok(isMontseCampaign("Depa Desde $1,900,000 en Qro - https://fb.me/aJjfJmi1K - 120251583532750437"));
  assert.ok(!isMontseCampaign("Depa Desde $1,860,000 en Qro - https://fb.me/4hvym5RJY - 120249679584950437"),
    "la campaña anterior de DOMUS no es la de Montse");
  assert.ok(!isMontseCampaign(undefined));

  const cMontse = contact("c-montse");
  const cOtra = contact("c-otra");
  const oMontse = opp("o-montse", { contactId: "c-montse" });
  const oOtra = opp("o-otra", { contactId: "c-otra" });
  const pautasMontse = [
    namedPauta("pm", "c-montse", `${MONTSE_CAMPAIGN_HEADLINE} - https://fb.me/aJjfJmi1K - 120251583532750437`, "2026-08-19T00:00:00Z"),
    namedPauta("po", "c-otra", "Depa Desde $1,860,000 MXN - https://fb.me/6aF6r7h3I - 120249679584940437", "2026-06-25T00:00:00Z"),
  ];
  const montseData = {
    ...EMPTY_DATA,
    opportunities: [oMontse, oOtra],
    contacts: [cMontse, cOtra],
    pautas: pautasMontse,
  };
  const ctxMontse = buildFilterContext(montseData.contacts, pautasMontse, montseData.opportunities);

  // Apagado no excluye nada: es un recorte, no una partición.
  assert.equal(hasActiveFilters(filters({ montse: false })), false);
  assert.equal(
    applyDashboardFilters(montseData, filters({ montse: false }), ctxMontse).opportunities,
    montseData.opportunities,
  );

  const soloMontse = applyDashboardFilters(montseData, filters({ montse: true }), ctxMontse);
  assert.deepEqual(soloMontse.opportunities.map((o) => o.id), ["o-montse"]);
  assert.deepEqual(soloMontse.contacts.map((c) => c.id), ["c-montse"]);
  assert.deepEqual(soloMontse.pautas.map((p) => p.id), ["pm"], "la pauta de la otra campaña se cae");

  // Un contacto SIN oportunidad se juzga por su propia primera pauta: sin esta
  // rama, prender el toggle borraría a todo lead que aún no abrió oportunidad.
  const huerfanoMontse = {
    ...montseData,
    opportunities: [] as Opportunity[],
  };
  assert.deepEqual(
    applyDashboardFilters(huerfanoMontse, filters({ montse: true }), ctxMontse).contacts.map((c) => c.id),
    ["c-montse"],
    "el lead sin oportunidad entra por su propia pauta",
  );

  // El nombre de campaña propio de la oportunidad gana sobre el de la pauta: es
  // el primer eslabón de resolveCampaignName y el toggle no puede saltárselo.
  const oPropio = opp("o-propio", { contactId: "c-otra", campaignName: MONTSE_CAMPAIGN_HEADLINE });
  assert.ok(
    applyDashboardFilters(
      { ...montseData, opportunities: [oPropio] },
      filters({ montse: true }),
      ctxMontse,
    ).opportunities.length === 1,
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

  // Un reporte recortado a una plaza o a una agencia que no lo declara miente, y
  // el prompt de analyze-report lo necesita para no leer un subconjunto como si
  // fuera el total.
  assert.equal(
    describeFilters(filters({ segments: { plaza: ["Plaza Meseta"], agencia: ["DOMUS"] } })),
    "Plaza: Plaza Meseta · Agencia: DOMUS",
  );
  assert.equal(describeFilters(filters({ montse: true })), "Campañas Montse");
  assert.equal(
    describeFilters(filters({ status: ["won"], segments: { agencia: ["DOMUS"] }, montse: true })),
    "Status: Ganado · Agencia: DOMUS · Campañas Montse",
  );

  console.log("verify:filters — todas las aserciones pasaron ✅");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
