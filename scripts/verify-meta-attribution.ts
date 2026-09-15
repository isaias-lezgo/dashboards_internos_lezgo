// Verificación de lib/meta-attribution.ts. Correr: pnpm verify:meta-attribution
//
// Un error aquí es un número equivocado en pantalla: un CPL calculado sobre
// leads que no eran de ese anuncio, o un gasto que se cuenta dos veces. Por eso
// las aserciones fijan la llave (ad id), la cadena de fallbacks (oportunidad →
// Pauta → primera atribución → última), la cohorte de CONTACTOS por día LOCAL y
// las divisiones sin denominador.
//
// Envuelto en main() en vez de usar await de nivel superior: este paquete es CJS.
import assert from "node:assert/strict";
import type { Contact, MetaAdsData, Opportunity, Pauta } from "../lib/types";
import {
  oppAdId,
  pautaAdId,
  contactAdId,
  resolveOppAdId,
  buildMetaIndex,
  buildAttributionContext,
  classifyLead,
  classifyContact,
  localDay,
  buildCostSummary,
  buildCampaignPerformance,
  buildMetaReport,
  defaultCurrency,
} from "../lib/meta-attribution";

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
    ...over,
  } as Opportunity;
}

function contact(over: Partial<Contact> & { id: string }): Contact {
  return {
    name: over.id,
    email: "",
    phone: "",
    tags: [],
    dateAdded: "2026-08-10T15:00:00.000Z",
    createdAt: "2026-08-10T15:00:00.000Z",
    ...over,
  } as Contact;
}

function pauta(over: Partial<Pauta> & { id: string }): Pauta {
  return { tipo: "Mensaje WhatsApp", nombrePauta: "", createdAt: "2026-08-10T15:00:00.000Z", ...over } as Pauta;
}

const meta: MetaAdsData = {
  accounts: [
    { id: "act_1", name: "Condesa", currency: "MXN", timezone: "America/Mexico_City" },
    { id: "act_2", name: "USD", currency: "USD", timezone: "America/Mexico_City" },
  ],
  campaigns: [
    { id: "camp-a", name: "IW - CC - FF - Demografía", accountId: "act_1" },
    { id: "camp-b", name: "IW - CC - FF - Buyer", accountId: "act_1" },
    { id: "camp-usd", name: "Test USD", accountId: "act_2" },
  ],
  adsets: [
    { id: "set-a", name: "Set A", campaignId: "camp-a" },
    { id: "set-b", name: "Set B", campaignId: "camp-b" },
    { id: "set-usd", name: "Set USD", campaignId: "camp-usd" },
  ],
  ads: [
    { id: "120001", name: "AD 01", adsetId: "set-a" },
    { id: "120002", name: "AD 02", adsetId: "set-a" },
    { id: "120003", name: "AD 03", adsetId: "set-b" },
    { id: "120009", name: "AD USD", adsetId: "set-usd" },
  ],
  daily: [
    { adId: "120001", date: "2026-08-10", spend: 100, impressions: 1000, reach: 900, clicks: 50, linkClicks: 40, leadsForm: 4, leadsMsg: 0 },
    { adId: "120002", date: "2026-08-11", spend: 50, impressions: 500, reach: 450, clicks: 10, linkClicks: 8, leadsForm: 0, leadsMsg: 2 },
    { adId: "120003", date: "2026-08-20", spend: 300, impressions: 3000, reach: 2000, clicks: 90, linkClicks: 80, leadsForm: 0, leadsMsg: 0 },
    { adId: "120001", date: "2026-09-01", spend: 999, impressions: 1, reach: 1, clicks: 0, linkClicks: 0, leadsForm: 0, leadsMsg: 0 },
    { adId: "120009", date: "2026-08-12", spend: 10, impressions: 100, reach: 90, clicks: 1, linkClicks: 1, leadsForm: 0, leadsMsg: 0 },
  ],
  window: { since: "2026-08-01", until: "2026-09-14" },
  failedAccounts: [],
};

async function main() {
  // --- oppAdId: nativo manda; custom field es fallback; se normaliza a dígitos
  assert.equal(oppAdId(opp({ id: "1", adId: "120001" })), "120001");
  assert.equal(oppAdId(opp({ id: "2", adId: " 120001 " })), "120001");
  assert.equal(oppAdId(opp({ id: "3", customFieldsResolved: { "ID de Pauta": "120002" } })), "120002");
  assert.equal(oppAdId(opp({ id: "4", customFieldsResolved: { "ID Pauta": "120002" } })), "120002");
  assert.equal(oppAdId(opp({ id: "5", adId: "120001", customFieldsResolved: { "ID Pauta": "120002" } })), "120001", "la attribution nativa manda");
  assert.equal(oppAdId(opp({ id: "6", customFieldsResolved: { "URL Pauta": "https://fb.me/x" } })), null, "URL Pauta no es ad id");
  assert.equal(oppAdId(opp({ id: "7", adId: "" })), null);
  assert.equal(oppAdId(opp({ id: "8", adId: "abc" })), null, "sin dígitos no hay id");

  // --- pautaAdId: el ad id vive al final del nombre "<titular> - <liga> - <adId>"
  assert.equal(pautaAdId(pauta({ id: "p1", nombrePauta: "TU INMOBILIARIA, MÁS EFICIENTE - https://fb.me/5iHqPQHIH - 120247929084880611" })), "120247929084880611");
  assert.equal(pautaAdId(pauta({ id: "p2", nombrePauta: "TU INMOBILIARIA - https://fb.me/x - 120247929084880611 " })), "120247929084880611", "tolera espacio final");
  assert.equal(pautaAdId(pauta({ id: "p3", nombrePauta: "Formulario Balvanera 210726" })), null, "un número corto no es ad id");
  assert.equal(pautaAdId(pauta({ id: "p4" })), null);

  // --- índice
  const index = buildMetaIndex(meta);
  assert.equal(index.byAd.get("120001")?.campaign?.id, "camp-a");
  assert.equal(index.byAd.get("120001")?.account?.currency, "MXN");
  assert.equal(index.byAd.get("120003")?.adset?.id, "set-b");
  assert.equal(index.dailyByAd.get("120001")?.length, 2);
  assert.equal(index.byAd.has("999"), false);

  // ── La cadena de atribución (oportunidad → Pauta → primera → última) ──────
  const chainContacts = [
    contact({ id: "c-opp" }),                                                            // su oportunidad trae el id
    contact({ id: "c-pauta", adId: "999999999999" }),                                    // su Pauta trae el id; el propio adId es de otra cuenta
    contact({ id: "c-first", attributions: [{ isFirst: true, utmAdId: "120002" }, { isFirst: false, utmAdId: "120003" }] }),
    contact({ id: "c-last", attributions: [{ isFirst: true, utmAdId: "555555555555" }, { isFirst: false, utmAdId: "120003" }] }),
    contact({ id: "c-src", attributionSource: { utmAdId: "120001" } }),                  // el objeto del endpoint individual
    contact({ id: "c-lastsrc", lastAttributionSource: { utmAdId: "120002" } }),
    contact({ id: "c-none", attributions: [{ isFirst: true, utmSource: "facebook" }] }),
    contact({ id: "c-csv", attributions: [{ isFirst: true, medium: "csv_import", utmAdId: "120001" }] }),
    contact({ id: "c-organic" }),
  ];
  const chainOpps = [opp({ id: "o-opp", contactId: "c-opp", adId: "120001" }), opp({ id: "o-noid", contactId: "c-pauta" })];
  const chainPautas = [pauta({ id: "pa-1", contactId: "c-pauta", nombrePauta: "X - https://fb.me/y - 120003" }), pauta({ id: "pa-2", contactId: "c-none" })];
  const cctx = buildAttributionContext({ index, contacts: chainContacts, opportunities: chainOpps, pautas: chainPautas });
  const byId = new Map(chainContacts.map((c) => [c.id, c]));
  assert.equal(contactAdId(byId.get("c-opp")!, cctx), "120001", "1º: el ad id de su oportunidad");
  assert.equal(contactAdId(byId.get("c-pauta")!, cctx), "120003", "2º: el objeto Pauta gana al adId propio");
  assert.equal(contactAdId(byId.get("c-first")!, cctx), "120002", "3º: primera atribución");
  assert.equal(contactAdId(byId.get("c-last")!, cctx), "120003", "4º: última atribución cuando la primera no está en Meta");
  assert.equal(contactAdId(byId.get("c-src")!, cctx), "120001", "attributionSource cuenta como primera");
  assert.equal(contactAdId(byId.get("c-lastsrc")!, cctx), "120002", "lastAttributionSource cuenta como última");
  assert.equal(contactAdId(byId.get("c-none")!, cctx), null);
  assert.equal(classifyContact(byId.get("c-opp")!, cctx), "exact");
  assert.equal(classifyContact(byId.get("c-pauta")!, cctx), "exact");
  assert.equal(classifyContact(byId.get("c-last")!, cctx), "exact");
  assert.equal(classifyContact(byId.get("c-none")!, cctx), "noAdId", "tiene Pauta pero sin id");
  assert.equal(classifyContact(byId.get("c-csv")!, cctx), "notPauta", "csv_import gana incluso con ad id");
  assert.equal(classifyContact(byId.get("c-organic")!, cctx), "notPauta");
  const unknown = contact({ id: "c-unk", attributions: [{ isFirst: true, utmAdId: "777777777777" }] });
  assert.equal(classifyContact(unknown, cctx), "unknownAd");
  assert.equal(resolveOppAdId(chainOpps[1], cctx), "120003", "opp sin adId → Pauta del contacto");
  assert.equal(classifyLead(chainOpps[1], cctx), "exact");
  assert.equal(resolveOppAdId(chainOpps[0], cctx), "120001", "el adId propio de la opp manda");

  // --- classifyLead: cuatro niveles; csv_import gana incluso con ad id
  const pctx = buildAttributionContext({ index, contacts: [], opportunities: [], pautas: [pauta({ id: "pp", contactId: "c-p" })] });
  assert.equal(classifyLead(opp({ id: "e", adId: "120001" }), pctx), "exact");
  assert.equal(classifyLead(opp({ id: "u", adId: "777777", source: "facebook" }), pctx), "unknownAd");
  assert.equal(classifyLead(opp({ id: "p", contactId: "c-p" }), pctx), "noAdId", "de pauta por el objeto Pauta, sin id");
  assert.equal(classifyLead(opp({ id: "n", source: "referido" }), pctx), "notPauta");
  assert.equal(
    classifyLead(opp({ id: "csv", adId: "120001", attributions: [{ medium: "csv_import" }] }), pctx),
    "notPauta",
    "importado por CSV nunca entra al costo"
  );

  // --- localDay: 23:36 del 6 en UTC-6 es el 7 en UTC; el día local manda
  assert.equal(localDay("2026-08-07T05:36:00.000Z"), "2026-08-06");
  assert.equal(localDay("2026-08-07T06:00:00.000Z"), "2026-08-07");

  // ── Cohorte sobre agosto ──────────────────────────────────────────────────
  // Cada oportunidad tiene su contacto (c-<id>), creado al mismo tiempo y sin
  // atribución propia: se atribuye por su oportunidad (eslabón 1).
  const range = { since: "2026-08-01", until: "2026-08-31" };
  const opps = [
    opp({ id: "a1", adId: "120001", createdAt: "2026-08-10T16:00:00.000Z", status: "won" }),
    opp({ id: "a2", adId: "120001", createdAt: "2026-08-10T17:00:00.000Z" }),
    opp({ id: "a3", adId: "120002", createdAt: "2026-08-11T17:00:00.000Z", stage: "Negocio Ganado" }),
    opp({ id: "a4", adId: "120003", createdAt: "2026-09-01T05:59:00.000Z" }), // 31 ago 23:59 local → dentro
    opp({ id: "sep", adId: "120001", createdAt: "2026-09-01T06:01:00.000Z" }), // 1 sep local → fuera
    opp({ id: "unk", adId: "555555", source: "facebook", createdAt: "2026-08-15T12:00:00.000Z" }),
    opp({ id: "noid", contactId: "c-p", createdAt: "2026-08-15T12:00:00.000Z" }),
    opp({ id: "org", source: "referido", createdAt: "2026-08-15T12:00:00.000Z" }),
  ];
  const contacts = opps.map((o) => contact({ id: o.contactId, createdAt: o.createdAt }));
  const pautas = [pauta({ id: "pp", contactId: "c-p" })];
  const inputFor = (m: MetaAdsData, os: Opportunity[] = opps, r: typeof range | null = range) => {
    const idx = buildMetaIndex(m);
    return { contacts, opportunities: os, meta: m, index: idx, range: r, ctx: buildAttributionContext({ index: idx, contacts, opportunities: os, pautas }) };
  };

  const s = buildCostSummary(inputFor(meta));
  assert.equal(s.mixedCurrency, true, "act_2 es USD");
  assert.deepEqual(s.spendByCurrency, { MXN: 450, USD: 10 });
  assert.equal(s.spend, null, "con moneda mixta no hay total consolidado");
  assert.equal(s.cpl, null);
  assert.equal(s.leadsMeta, 6);
  assert.equal(s.leadsCrm, 4, "c-a1 c-a2 c-a3 c-a4; c-sep queda fuera por día local");
  assert.equal(s.opportunities, 4);
  assert.equal(s.won, 2, "status won + etapa Negocio Ganado (isWonOpp)");
  assert.equal(s.unknownAdLeads, 1, "c-unk: su opp trae un ad que Meta no tiene");
  assert.equal(s.noAdIdLeads, 1, "c-p: tiene Pauta, sin id");

  // --- solo MXN: costos consolidados
  const mxn: MetaAdsData = { ...meta, daily: meta.daily.filter((d) => d.adId !== "120009") };
  const s2 = buildCostSummary(inputFor(mxn));
  assert.equal(s2.mixedCurrency, false);
  assert.equal(s2.currency, "MXN");
  assert.equal(s2.spend, 450);
  assert.equal(s2.cpl, 112.5, "450 / 4 contactos");
  assert.equal(s2.cpa, 225);

  // --- sin leads en la ventana → null, nunca 0 ni Infinity
  const s3 = buildCostSummary({ ...inputFor(mxn, []), contacts: [] });
  assert.equal(s3.spend, 450);
  assert.equal(s3.leadsCrm, 0);
  assert.equal(s3.cpl, null);
  assert.equal(s3.cpa, null);

  // --- range null = todo
  const s4 = buildCostSummary(inputFor(mxn, opps, null));
  assert.equal(s4.spend, 1449);
  assert.equal(s4.leadsCrm, 5);

  // --- por campaña
  const rows = buildCampaignPerformance(inputFor(mxn));
  const a = rows.find((r) => r.campaignId === "camp-a")!;
  const b = rows.find((r) => r.campaignId === "camp-b")!;
  assert.equal(a.spend, 150);
  assert.equal(a.impressions, 1500);
  assert.equal(a.clicks, 60);
  assert.equal(a.cpm, 100);
  assert.equal(a.ctr, 0.04);
  assert.equal(a.leadsMeta, 6);
  assert.equal(a.leadsCrm, 3);
  assert.equal(a.opportunities, 3);
  assert.equal(a.won, 2);
  assert.equal(a.cpl, 50);
  assert.equal(a.cpa, 75);
  assert.equal(b.spend, 300);
  assert.equal(b.leadsCrm, 1);
  assert.equal(b.won, 0);
  assert.equal(b.cpa, null);
  assert.ok(rows.findIndex((r) => r.campaignId === "camp-b") < rows.findIndex((r) => r.campaignId === "camp-a"), "ordenado por gasto desc");
  assert.equal(rows.some((r) => r.campaignId === "camp-usd"), false, "sin filas en la ventana no aparece");

  // ── buildMetaReport ────────────────────────────────────────────────────────
  const base = inputFor(mxn);
  const mxnIdx = base.index;

  // --- none: una fila total, igual que buildCostSummary
  const total = buildMetaReport({ ...base, groupBy: "none" });
  assert.equal(total.length, 1);
  assert.equal(total[0].key, "total");
  assert.equal(total[0].spend, 450);
  assert.equal(total[0].leadsCrm, 4);
  assert.equal(total[0].opportunities, 4);
  assert.equal(total[0].currency, "MXN");
  assert.equal(total[0].cpl, 112.5);

  // --- campaign: idéntico al alias
  const byCamp = buildMetaReport({ ...base, groupBy: "campaign" });
  assert.deepEqual(byCamp.map((r) => [r.key, r.spend, r.leadsCrm]), rows.map((r) => [r.campaignId, r.spend, r.leadsCrm]));

  // --- month: cronológico; la cohorte cruza el límite de mes por DÍA LOCAL
  const byMonth = buildMetaReport({ ...base, groupBy: "month", range: null });
  assert.deepEqual(byMonth.map((r) => r.key), ["2026-08", "2026-09"]);
  assert.equal(byMonth[0].spend, 450);
  assert.equal(byMonth[0].leadsCrm, 4, "c-a4 (31 ago 23:59 local) cae en agosto");
  assert.equal(byMonth[1].spend, 999);
  assert.equal(byMonth[1].leadsCrm, 1, "c-sep (1 sep 00:01 local) cae en septiembre");
  assert.equal(byMonth[1].label, "2026-09");

  // --- adset y ad
  const byAdset = buildMetaReport({ ...base, groupBy: "adset" });
  assert.deepEqual(byAdset.map((r) => [r.key, r.spend]), [["set-b", 300], ["set-a", 150]]);
  const byAd = buildMetaReport({ ...base, groupBy: "ad" });
  assert.deepEqual(byAd.map((r) => r.key), ["120003", "120001", "120002"]);
  assert.equal(byAd.find((r) => r.key === "120001")?.leadsCrm, 2);
  assert.equal(byAd.find((r) => r.key === "120001")?.accountId, "act_1");

  // --- filtro por campaña (substring, sin acentos ni mayúsculas)
  const onlyB = buildMetaReport({ ...base, groupBy: "ad", campaign: "buyer" });
  assert.deepEqual(onlyB.map((r) => r.key), ["120003"]);
  const onlyBMonth = buildMetaReport({ ...base, groupBy: "month", campaign: "DEMOGRAFIA" });
  assert.equal(onlyBMonth.length, 1);
  assert.equal(onlyBMonth[0].spend, 150, "el filtro de campaña acota también los totales por mes");

  // --- includeIds: solo con la bandera, distintos, con tope
  const noIds = buildMetaReport({ ...base, groupBy: "campaign" });
  assert.equal(noIds[0].oppIds, undefined);
  const withIds = buildMetaReport({ ...base, groupBy: "campaign", includeIds: true });
  const campA = withIds.find((r) => r.key === "camp-a")!;
  assert.deepEqual([...campA.oppIds!].sort(), ["a1", "a2", "a3"]);
  assert.deepEqual([...campA.contactIds!].sort(), ["c-a1", "c-a2", "c-a3"]);
  const many = Array.from({ length: 80 }, (_, i) =>
    opp({ id: `m${i}`, adId: "120001", contactId: "c-shared", createdAt: "2026-08-12T12:00:00.000Z" })
  );
  const shared = [contact({ id: "c-shared", createdAt: "2026-08-12T12:00:00.000Z" })];
  const manyIdx = buildMetaIndex(mxn);
  const cappedRow = buildMetaReport({
    contacts: shared, opportunities: many, meta: mxn, index: manyIdx, range,
    ctx: buildAttributionContext({ index: manyIdx, contacts: shared, opportunities: many, pautas: [] }),
    groupBy: "ad", includeIds: true,
  }).find((r) => r.key === "120001")!;
  assert.equal(cappedRow.opportunities, 80, "el conteo no se topa");
  assert.equal(cappedRow.leadsCrm, 1, "un solo contacto detrás de las 80");
  assert.equal(cappedRow.oppIds!.length, 50, "los ids sí (cap 50)");
  assert.deepEqual(cappedRow.contactIds, ["c-shared"]);

  // --- moneda mixta: la fila total lleva "?" y sin costos; por campaña cada una con la suya
  const mixedTotal = buildMetaReport({ ...inputFor(meta), groupBy: "none" });
  assert.equal(mixedTotal[0].currency, "?");
  assert.equal(mixedTotal[0].spend, 460, "el gasto se suma igual; la UI sabe por currency que no es comparable");
  assert.equal(mixedTotal[0].cpl, null);
  assert.equal(mixedTotal[0].cpm, null);
  const mixedCamp = buildMetaReport({ ...inputFor(meta), groupBy: "campaign" });
  assert.equal(mixedCamp.find((r) => r.key === "camp-usd")?.currency, "USD");

  // --- defaultCurrency y un ad fuera de la jerarquía NO ensucia la moneda
  // `mxn` solo recorta las filas diarias: sus CUENTAS siguen siendo dos (MXN y
  // USD), así que la moneda por defecto solo existe con una cuenta.
  const mxnOnly: MetaAdsData = { ...mxn, accounts: [meta.accounts[0]] };
  assert.equal(defaultCurrency(mxn), null, "dos cuentas de monedas distintas: sin moneda por defecto");
  assert.equal(defaultCurrency(mxnOnly), "MXN");
  assert.equal(defaultCurrency(meta), null);
  const orphanDaily: MetaAdsData = {
    ...mxnOnly,
    daily: [...mxnOnly.daily, { adId: "999999", date: "2026-08-15", spend: 5, impressions: 10, reach: 9, clicks: 1, linkClicks: 1, leadsForm: 0, leadsMsg: 0 }],
  };
  const orphanSummary = buildCostSummary(inputFor(orphanDaily));
  assert.equal(orphanSummary.mixedCurrency, false, "un ad borrado (sin jerarquía) hereda la única moneda de la cuenta");
  assert.equal(orphanSummary.spend, 455);
  const orphanTotal = buildMetaReport({ ...inputFor(orphanDaily), groupBy: "none" });
  assert.equal(orphanTotal[0].currency, "MXN");

  // ── La cohorte es de CONTACTOS; las oportunidades son el embudo debajo ─────
  const cohortContacts = [
    contact({ id: "k1", createdAt: "2026-08-10T16:00:00.000Z" }),                       // por su opp (a1, ganada)
    contact({ id: "k2", createdAt: "2026-08-11T16:00:00.000Z", attributions: [{ isFirst: true, utmAdId: "120001" }] }),
    contact({ id: "k3", createdAt: "2026-08-12T16:00:00.000Z" }),                       // por Pauta
    contact({ id: "k4", createdAt: "2026-09-02T16:00:00.000Z", attributions: [{ isFirst: true, utmAdId: "120002" }] }), // fuera de agosto
    contact({ id: "k5", createdAt: "2026-08-12T16:00:00.000Z", attributions: [{ isFirst: true, utmAdId: "444444444444" }] }), // unknownAd
    contact({ id: "k6", createdAt: "2026-08-12T16:00:00.000Z" }),                       // orgánico
  ];
  const cohortOpps = [
    opp({ id: "a1", contactId: "k1", adId: "120001", createdAt: "2026-08-10T17:00:00.000Z", status: "won" }),
    opp({ id: "a2", contactId: "k2", createdAt: "2026-08-15T17:00:00.000Z" }),           // sin adId: hereda el de k2
    opp({ id: "a6", contactId: "k6", createdAt: "2026-08-15T17:00:00.000Z" }),           // orgánica
  ];
  const cohortPautas = [pauta({ id: "kp3", contactId: "k3", nombrePauta: "X - https://fb.me/z - 120002" })];
  const kctx = buildAttributionContext({ index: mxnIdx, contacts: cohortContacts, opportunities: cohortOpps, pautas: cohortPautas });
  const ks = buildCostSummary({ contacts: cohortContacts, opportunities: cohortOpps, meta: mxn, index: mxnIdx, range, ctx: kctx });
  assert.equal(ks.leadsCrm, 3, "k1 k2 k3 (k4 fuera de ventana, k5 unknownAd, k6 orgánico)");
  assert.equal(ks.opportunities, 2, "a1 y a2 (a6 es orgánica)");
  assert.equal(ks.won, 1);
  assert.equal(ks.cpl, 150, "450 / 3 contactos");
  assert.equal(ks.cpa, 450);
  assert.equal(ks.unknownAdLeads, 1);
  const krows = buildMetaReport({ contacts: cohortContacts, opportunities: cohortOpps, meta: mxn, index: mxnIdx, range, ctx: kctx, groupBy: "campaign", includeIds: true });
  const ka = krows.find((r) => r.key === "camp-a")!;
  assert.equal(ka.leadsCrm, 3, "los tres contactos caen en camp-a (120001/120002)");
  assert.equal(ka.opportunities, 2);
  assert.equal(ka.won, 1);
  assert.deepEqual([...ka.contactIds!].sort(), ["k1", "k2", "k3"]);
  assert.deepEqual([...ka.oppIds!].sort(), ["a1", "a2"]);

  console.log("✅ verify:meta-attribution OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
