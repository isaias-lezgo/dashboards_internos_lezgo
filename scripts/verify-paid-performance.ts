// Verificación de lib/paid-performance.ts. Correr: pnpm verify:paid-performance
//
// Un error aquí es un número equivocado en la tabla de "Inversión y rendimiento
// de pauta": un gasto de campaña que no cuadra con el Administrador de anuncios,
// una oportunidad de TikTok que desaparece por no tener ad id, o una cita contada
// dos veces. Por eso las aserciones fijan: (1) el gasto por campaña es IDÉNTICO
// al de buildMetaReport; (2) un anuncio con gasto y sin leads existe; (3) lo que
// no cruza con Meta sobrevive sin costos; (4) la barra de etapas suma Opps;
// (5) sin Meta salen las mismas filas; (6) Citas cuenta contactos; (7) la cadena
// manda sobre el campo crudo; (12) en modo Origen no hay inversión.
//
// Envuelto en main() en vez de usar await de nivel superior: este paquete es CJS.
import assert from "node:assert/strict";
import type { Appointment, Contact, MetaAdsData, Opportunity, Pauta, Pipeline } from "../lib/types";
import { buildMetaIndex, buildAttributionContext, buildMetaReport } from "../lib/meta-attribution";
import { buildPaidPerformance, EMPTY_META, NO_AD_KEY, type PaidGroup } from "../lib/paid-performance";

// ── Fixtures ────────────────────────────────────────────────────────────────

function opp(over: Partial<Opportunity> & { id: string }): Opportunity {
  return {
    name: over.id,
    pipelineId: "p",
    pipelineStageId: "s",
    status: "open",
    createdAt: "2026-08-10T15:00:00.000Z",
    contactId: `c-${over.id}`,
    value: 0,
    stage: "Nuevo",
    pipelineName: "Ventas",
    source: "facebook",
    attributionMedium: "paid_social",
    ...over,
  } as Opportunity;
}

function contact(over: Partial<Contact> & { id: string }): Contact {
  return { name: over.id, createdAt: "2026-08-10T15:00:00.000Z", tags: [], ...over } as Contact;
}

function appt(id: string, contactId: string, status: string): Appointment {
  return { id, contactId, startTime: "2026-08-12T16:00:00.000Z", endTime: "2026-08-12T17:00:00.000Z", status };
}

const pipelines: Pipeline[] = [{ id: "p", name: "Ventas", stages: ["Nuevo", "Cita", "Ganado", "Perdido"] }];

// Dos campañas de Meta, tres anuncios. El anuncio 300 gasta y no trae leads.
const meta: MetaAdsData = {
  accounts: [{ id: "act_1", name: "Lezgo", currency: "MXN", timezone: "America/Mexico_City" }],
  campaigns: [
    { id: "camp-A", name: "CAMPAÑA A", accountId: "act_1" },
    { id: "camp-B", name: "CAMPAÑA B", accountId: "act_1" },
  ],
  adsets: [
    { id: "set-A", name: "Set A", campaignId: "camp-A" },
    { id: "set-B", name: "Set B", campaignId: "camp-B" },
  ],
  ads: [
    { id: "120100", name: "Ad 120100", adsetId: "set-A" },
    { id: "120200", name: "Ad 120200", adsetId: "set-A" },
    { id: "120300", name: "Ad 120300", adsetId: "set-B" },
  ],
  daily: [
    { adId: "120100", date: "2026-08-10", spend: 100, impressions: 1000, reach: 900, clicks: 50, linkClicks: 40, leadsForm: 3, leadsMsg: 0 },
    { adId: "120200", date: "2026-08-11", spend: 50.5, impressions: 500, reach: 450, clicks: 20, linkClicks: 15, leadsForm: 0, leadsMsg: 2 },
    { adId: "120300", date: "2026-08-11", spend: 75.25, impressions: 700, reach: 600, clicks: 30, linkClicks: 22, leadsForm: 1, leadsMsg: 0 },
  ],
  window: { since: "2026-08-01", until: "2026-08-31" },
  failedAccounts: [],
};

const opportunities: Opportunity[] = [
  opp({ id: "o1", adId: "120100", stage: "Cita", attributionUrl: "https://ig.me/m/abc" }),
  opp({ id: "o2", adId: "120100", stage: "Nuevo", attributionUrl: "https://ig.me/m/abc" }),
  opp({ id: "o3", adId: "120100", stage: "Perdido", status: "lost", attributionUrl: "https://fb.me/xyz" }),
  opp({ id: "o4", adId: "120200", stage: "Ganado", status: "won" }),
  // TikTok sin ad id: nombre de pauta en custom field, tráfico pagado por source.
  opp({ id: "o5", source: "tiktok", stage: "Nuevo", customFieldsResolved: { "Nombre pauta": "TIKTOK VERANO" } }),
  // Ad id propio que Meta no conoce, pero el contacto trae uno que sí (o7 abajo).
  opp({ id: "o6", adId: "120999", contactId: "c-o7", stage: "Cita" }),
  opp({ id: "o7", adId: "120200", contactId: "c-o7", stage: "Cita" }),
];
const contacts: Contact[] = Array.from(new Set(opportunities.map((o) => o.contactId))).map((id) => contact({ id }));
const pautas: Pauta[] = [];
const appointments: Appointment[] = [
  appt("a1", "c-o1", "showed"),
  appt("a2", "c-o1", "confirmed"), // segunda cita del mismo contacto
  appt("a3", "c-o2", "confirmed"),
  appt("a4", "c-o5", "showed"),
];

const RANGE = { since: "2026-08-01", until: "2026-08-31" };

function build(withMeta: boolean, over: Partial<Parameters<typeof buildPaidPerformance>[0]> = {}): PaidGroup[] {
  const data = withMeta ? meta : EMPTY_META;
  const index = buildMetaIndex(data);
  const ctx = buildAttributionContext({ index, contacts, opportunities, pautas });
  return buildPaidPerformance({
    opportunities,
    contacts,
    appointments,
    pipelines,
    pautaNameByContact: new Map(),
    ctx,
    groupBy: "campaign",
    includeLost: true,
    meta: withMeta ? { data, range: RANGE } : null,
    ...over,
  });
}

const byLabel = (groups: PaidGroup[], label: string) => {
  const g = groups.find((x) => x.label === label);
  assert.ok(g, `falta el grupo "${label}" en ${groups.map((x) => x.label).join(" | ")}`);
  return g;
};

async function main() {
  // ── 3. Lo que no cruza con Meta sobrevive, sin costos ────────────────────
  {
    const groups = build(true);
    const tiktok = byLabel(groups, "TIKTOK VERANO");
    assert.equal(tiktok.crmOnly, true);
    assert.equal(tiktok.spend, null);
    assert.equal(tiktok.cpl, null);
    assert.equal(tiktok.opportunities, 1);
    assert.equal(tiktok.children.length, 1);
    assert.equal(tiktok.children[0].key, NO_AD_KEY);
    assert.deepEqual(tiktok.children[0].oppIds, ["o5"]);
  }

  // ── 4. La barra de etapas suma Opps, con y sin perdidas ──────────────────
  {
    const withLost = byLabel(build(true), "CAMPAÑA A");
    assert.equal(withLost.opportunities, 6); // o1 o2 o3 o4 o6 o7 (o6 va por su contacto → ad 120200)
    assert.equal(withLost.stages.reduce((a, s) => a + s.count, 0), withLost.opportunities);
    assert.ok(withLost.stages.some((s) => s.lost && s.stage === "Perdido" && s.count === 1));
    assert.deepEqual(withLost.stages.map((s) => s.stage), ["Nuevo", "Cita", "Ganado", "Perdido"], "orden del pipeline");

    const noLost = byLabel(build(true, { includeLost: false }), "CAMPAÑA A");
    assert.equal(noLost.opportunities, 5);
    assert.equal(noLost.stages.reduce((a, s) => a + s.count, 0), 5);
    assert.ok(!noLost.stages.some((s) => s.lost));
    assert.ok(!noLost.oppIds.includes("o3"), "la perdida sale también de oppIds");
  }

  // ── 6. Citas cuenta CONTACTOS; Efectivas solo showed ─────────────────────
  {
    const a = byLabel(build(true), "CAMPAÑA A");
    // c-o1 (2 citas → 1), c-o2 (1) = 2 contactos con cita; showed solo c-o1.
    assert.equal(a.appointments, 2);
    assert.equal(a.showed, 1);
    assert.deepEqual([...a.apptContactIds].sort(), ["c-o1", "c-o2"]);
    const t = byLabel(build(true), "TIKTOK VERANO");
    assert.equal(t.appointments, 1);
    assert.equal(t.showed, 1);
  }

  // ── 5. Sin Meta salen las mismas filas del CRM, sin inversión ────────────
  {
    const groups = build(false);
    for (const g of groups) {
      assert.equal(g.crmOnly, true);
      assert.equal(g.spend, null);
      assert.equal(g.impressions, null);
      assert.equal(g.leadsMeta, null);
      for (const c of g.children) assert.equal(c.spend, null);
    }
    // Sin Meta no hay jerarquía: la campaña es el headline del CRM. Las opps de
    // los ads 120100/120200 no traen nombre de pauta → "Sin nombre", con un hijo por ad id.
    // o6 (adId 120999) cae en "120999": sin Meta la cadena devuelve el primer id crudo.
    const sinNombre = byLabel(groups, "Sin nombre");
    assert.deepEqual([...sinNombre.children.map((c) => c.key)].sort(), ["120100", "120200", "120999"].sort());
    assert.equal(groups.reduce((a, g) => a + g.opportunities, 0), 7);
  }

  // ── 1. El gasto por campaña es IDÉNTICO al de buildMetaReport ────────────
  {
    const index = buildMetaIndex(meta);
    const ctx = buildAttributionContext({ index, contacts, opportunities, pautas });
    const reference = buildMetaReport({ contacts, opportunities, meta, index, range: RANGE, ctx, groupBy: "campaign" });
    const groups = build(true);
    assert.equal(reference.length, 2);
    for (const ref of reference) {
      const g = byLabel(groups, ref.label);
      assert.equal(g.spend, ref.spend, `gasto de ${ref.label}`);
      assert.equal(g.impressions, ref.impressions, `impresiones de ${ref.label}`);
      assert.equal(g.clicks, ref.clicks, `clics de ${ref.label}`);
      assert.equal(g.leadsMeta, ref.leadsMeta, `leads Meta de ${ref.label}`);
      // Con los mismos contactos y la misma cadena, Leads CRM también cuadra.
      assert.equal(g.leadsCrm, ref.leadsCrm, `leads CRM de ${ref.label}`);
      assert.equal(g.currency, "MXN");
      assert.equal(g.crmOnly, false);
    }
    const a = byLabel(groups, "CAMPAÑA A");
    assert.equal(a.spend, 150.5);
    assert.equal(a.cpm, (150.5 / 1500) * 1000);
    assert.equal(a.ctr, 70 / 1500);
    // CPL = gasto ÷ contactos de la fila (c-o1 c-o2 c-o3 c-o4 c-o7 → 5).
    assert.equal(a.leadsCrm, 5);
    assert.equal(a.cpl, 150.5 / 5);
    assert.equal(a.cpa, 150.5 / 1);
    // Los hijos suman al grupo: 100 + 50.5.
    assert.equal(a.children.reduce((s, c) => s + (c.spend ?? 0), 0), a.spend);
  }

  // ── 2. Un anuncio con gasto y sin leads existe como hijo ─────────────────
  {
    const b = byLabel(build(true), "CAMPAÑA B");
    assert.equal(b.spend, 75.25);
    assert.equal(b.opportunities, 0);
    assert.equal(b.leadsCrm, 0);
    assert.equal(b.cpl, null, "sin denominador no hay CPL");
    assert.equal(b.children.length, 1);
    assert.equal(b.children[0].adId, "120300");
    assert.equal(b.children[0].crmOnly, false);
    assert.deepEqual(b.children[0].stages, []);
  }

  // ── 7. La cadena manda sobre el campo crudo ──────────────────────────────
  {
    const a = byLabel(build(true), "CAMPAÑA A");
    const ad200 = a.children.find((c) => c.adId === "120200");
    assert.ok(ad200);
    assert.ok(ad200.oppIds.includes("o6"), "o6 (adId 120999, contacto con 120200) cae bajo el ad 120200");
    assert.ok(!a.children.some((c) => c.adId === "120999"));
    // La URL más frecuente del hijo 120100 es la de Instagram (2 de 3), con 1 otra.
    const ad100 = a.children.find((c) => c.adId === "120100");
    assert.ok(ad100?.url);
    assert.equal(ad100.url.platform, "instagram");
    assert.equal(ad100.url.others, 1);
  }

  // ── 12. En modo Origen no hay inversión ──────────────────────────────────
  {
    const groups = build(true, { groupBy: "platform" });
    assert.ok(groups.length > 0);
    for (const g of groups) assert.equal(g.spend, null);
    assert.equal(groups.reduce((s, g) => s + g.opportunities, 0), 7);
    // Un contacto SIN oportunidad se ubica por sus propias señales (source, liga,
    // "Origen de Lead"), no en "Otro": en Lezgo Suite el 93 % de los leads nunca
    // llega a oportunidad y "Otro" se comía 1,450.
    const solo = contact({ id: "c-solo", adId: "120100", source: "instagram" });
    const withSolo = build(true, { groupBy: "platform", contacts: [...contacts, solo] });
    assert.ok(byLabel(withSolo, "Instagram").contactIds.includes("c-solo"));
    assert.ok(!withSolo.some((g) => g.label === "Otro"));
  }

  console.log("verify:paid-performance ✓");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
