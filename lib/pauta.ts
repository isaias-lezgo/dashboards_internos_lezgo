// Canonical "es de pauta" logic, shared by the Marketing dashboard charts and the
// AI assistant's search/aggregate tools so both classify paid-advertising
// ("pauta") opportunities identically. Keep this the single source of truth — do
// not re-inline isPaidTraffic / isDePauta / resolveCampaignName elsewhere.

import type { Opportunity, Pauta } from "@/lib/types"

// Paid-traffic source/medium vocabularies. Social + search together — an
// opportunity is "paid traffic" if its GHL source or ad medium matches any of
// these. These are the raw-signal half of isDePauta.
export const PAID_SOCIAL_SOURCES = ["meta", "facebook", "instagram", "tiktok", "fb", "snapchat", "pinterest"]
export const PAID_SOCIAL_MEDIUMS = ["paid_social", "paidsocial", "paid social", "cpc", "cpm", "paid_search", "paid_ads"]
export const PAID_SEARCH_SOURCES = ["google", "bing", "yahoo", "baidu", "duckduckgo"]
export const PAID_SEARCH_MEDIUMS = ["cpc", "ppc", "paid_search", "paidsearch", "google_ads", "sem"]

export function isPaidTraffic(opp: Opportunity): boolean {
  const src = (opp.source ?? "").toLowerCase()
  const med = (opp.adType ?? "").toLowerCase()
  return (
    PAID_SOCIAL_SOURCES.some((s) => src.includes(s)) ||
    PAID_SOCIAL_MEDIUMS.some((m) => med.includes(m)) ||
    PAID_SEARCH_SOURCES.some((s) => src.includes(s)) ||
    PAID_SEARCH_MEDIUMS.some((m) => med.includes(m))
  )
}

// Anything with a membership test — a Set<string> (dashboard) or a
// Map<string, …> (AI ChatIndex.pautasByContact) both satisfy this.
export interface HasKey {
  has(key: string): boolean
}

// Canonical "es de pauta" predicate. An opportunity counts if EITHER its contact
// is linked to a Pauta custom-object record (opp → contact → llegó por pauta) OR
// the opportunity itself carries a paid-traffic source/medium signal. The union is
// deliberate: not every paid lead gets a Pauta record (it's created by a Make
// scenario), and not every Pauta-linked contact kept its UTM source, so each
// signal covers the other's gaps.
export function isDePauta(opp: Opportunity, pautaContacts: HasKey): boolean {
  return (!!opp.contactId && pautaContacts.has(opp.contactId)) || isPaidTraffic(opp)
}

// An opportunity's own custom field that holds the campaign / ad name. Field names
// vary per sub-account ("Nombre pauta", "Nombre de la pauta", …) so match loosely
// by requiring both "nombre" and "pauta" in the field name.
export function pautaNameFromCustomFields(
  resolved?: Record<string, string | string[]>
): string | undefined {
  if (!resolved) return undefined
  for (const [name, val] of Object.entries(resolved)) {
    const n = name.toLowerCase()
    if (n.includes("nombre") && n.includes("pauta")) {
      const s = Array.isArray(val) ? val[0] : val
      if (s && String(s).trim()) return String(s).trim()
    }
  }
  return undefined
}

// The Pauta record stores the lead's name and phone as plain-text properties,
// written by the Make scenario at capture time — independent of whether the
// contact relation ever got linked. That makes them the only identity left on a
// contact-less pauta, so the drill drawer can still name a broken record.
// Property spelling varies per sub-account, and GHL stored the phone one with a
// typo ("telfono_del_contacto"), so match loosely instead of by exact key.
function findProperty(p: Pauta, match: (key: string) => boolean): string | undefined {
  if (!p.properties) return undefined
  for (const [k, v] of Object.entries(p.properties)) {
    if (!match(k.toLowerCase())) continue
    const s = String(v ?? "").trim()
    // "-" is the Make scenario's placeholder for "no value", not a real name.
    if (s && s !== "-") return s
  }
  return undefined
}

export function pautaContactName(p: Pauta): string | undefined {
  return findProperty(p, (k) => k.includes("nombre") && k.includes("contacto"))
}

export function pautaContactPhone(p: Pauta): string | undefined {
  return findProperty(p, (k) => k.includes("telfono") || k.includes("telefono") || k.includes("phone"))
}

// contactId → the name of the contact's FIRST (chronologically earliest) Pauta
// record that carries a real name. Last-resort fallback for resolveCampaignName.
// Built over the FULL (unfiltered) pauta history so a pauta outside the active
// date window still names the campaign.
export function buildPautaNameByContact(pautas: Pauta[]): Map<string, string> {
  const byContact = new Map<string, Pauta[]>()
  for (const p of pautas) {
    if (!p.contactId) continue
    const arr = byContact.get(p.contactId) ?? []
    arr.push(p)
    byContact.set(p.contactId, arr)
  }
  const m = new Map<string, string>()
  for (const [contactId, arr] of byContact) {
    arr.sort((a, b) => (+new Date(a.createdAt) || 0) - (+new Date(b.createdAt) || 0))
    const named = arr.find((p) => {
      const n = p.nombrePauta?.trim()
      return n && n !== "Sin nombre"
    })
    if (named) m.set(contactId, named.nombrePauta.trim())
  }
  return m
}

// The campaign name is scattered across sources with wildly different coverage.
// Resolve it through a fallback chain so an opportunity that carries paid traffic
// but lost its utmCampaign still lands in a named campaign bucket instead of
// dropping out of "por campaña" grouping entirely:
//   1. opp.campaignName  — utmCampaign (own, or inherited from the contact in the transform)
//   2. opp "Nombre pauta" custom field — account-agnostic name match (nombre + pauta)
//   3. opp.campaign      — buildCampaignLabel(utmContent, utmCampaign) from the
//                          contact attribution; since (1) already failed this is
//                          effectively the utmContent
//   4. the contact's FIRST Pauta record's nombrePauta (via pautaNameByContact)
export function resolveCampaignName(
  opp: Opportunity,
  pautaNameByContact?: Map<string, string>
): string | undefined {
  if (opp.campaignName) return opp.campaignName
  const fromCf = pautaNameFromCustomFields(opp.customFieldsResolved)
  if (fromCf) return fromCf
  if (opp.campaign) return opp.campaign
  return opp.contactId ? pautaNameByContact?.get(opp.contactId) : undefined
}

// ── El headline de un anuncio ──────────────────────────────────────────────
// Meta nombra cada pauta de un anuncio como `<headline> - <liga> - <id de adset>`,
// así que una misma campaña llega partida en tantos nombres como creatividades y
// ligas tenga: "Depa Desde $1,900,000 en Qro" son dos entradas distintas sólo
// porque una trae una liga de Instagram y la otra una de fb.me.
//
// El corte exige las TRES partes, con una liga reconocible en medio y un id
// numérico al final. Esa exigencia es lo que evita destrozar los nombres de
// formulario, que también separan con guiones: "IW - CC - FF - Corregidora -
// Enero 2026" no termina en un id, así que queda intacto. Medido sobre Condesa,
// colapsa 52 nombres a 34 sin tocar un solo nombre de formulario.
const AD_NAME_RE = /^(.+?)\s+-\s+\S*(?:https?:\/\/|fb\.me|wa\.me)\S*\s+-\s+\d{6,}$/i

/** El headline de un nombre de pauta, o el nombre entero si no tiene ese formato. */
export function campaignHeadline(name: string): string {
  const trimmed = name.trim()
  const m = AD_NAME_RE.exec(trimmed)
  return (m ? m[1] : trimmed).trim()
}

// ── Familias de campaña ────────────────────────────────────────────────────
// Nothing in GHL says which agency owns a campaign — not on the Pauta object,
// not on the opportunity. The only signal is the naming convention: each agency
// prefixes its pautas its own way ("IW - CC - FF - Corregidora - Julio"). These
// helpers detect that shared prefix so the Marketing chart can group by it and
// dim it, making the pattern legible to a human who then infers the agency.
//
// This is the deliberate INVERSE of campaignPrefixCut() in
// marketing-dashboard.tsx, which strips the prefix shared by ALL keys so bars
// don't render visually identical. Different question, opposite treatment —
// do not try to unify them.

/** Bucket for named campaigns whose name matched no family. */
export const SIN_PATRON_FAMILY = "Sin patrón"

/**
 * The sentinel app/api/dashboard/route.ts writes when the Pauta record has no
 * name property. Kept distinct from SIN_PATRON_FAMILY: "I don't know what this
 * is called" is not the same as "it's called something that fits no family".
 */
export const SIN_NOMBRE_CAMPAIGN = "Sin nombre"

// Campaign names separate tokens with any of these, with or without spaces.
const CAMPAIGN_SEPARATOR = /\s*[-|_/]\s*/

/**
 * Split a campaign name into its family prefix and the rest, cutting after the
 * `depth`-th separator. Returns null when the name has no family at that depth
 * — no separator, too few tokens, or nothing left after the cut.
 *
 * `prefixLen` is a character offset into the ORIGINAL string (separator
 * included) so the UI can render name.slice(0, prefixLen) dimmed and
 * name.slice(prefixLen) emphasized, without re-deriving the split.
 */
export function campaignFamilySplit(
  name: string,
  depth: number,
): { family: string; prefixLen: number } | null {
  if (depth < 1) return null
  const re = new RegExp(CAMPAIGN_SEPARATOR.source, "g")
  let seen = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(name)) !== null) {
    // A separator at position 0 is leading punctuation, not a token boundary.
    if (m.index === 0) continue
    seen++
    if (seen < depth) continue
    // Strip leading punctuation too: it was skipped as a token boundary above,
    // but it's still sitting at the front of the slice ("- IW" → "IW"). The
    // offset keeps it, so the UI dims it along with the rest of the prefix.
    const family = name.slice(0, m.index).replace(/^[\s\-|_/]+/, "").trim()
    const prefixLen = m.index + m[0].length
    // Both halves must be non-empty: "IW - " would otherwise yield a family
    // with nothing left to tell its members apart.
    if (!family || !name.slice(prefixLen).trim()) return null
    return { family, prefixLen }
  }
  return null
}

/** One campaign's counts. `leads` is the isUniqueLead subset of `pautas`. */
export interface CampaignTally {
  name: string
  pautas: number
  leads: number
}

export interface CampaignRow extends CampaignTally {
  /**
   * Leading chars of `name` already shown by the group's header, so the row can
   * render only the part that distinguishes it. 0 = show the whole name.
   */
  prefixLen: number
}

export interface CampaignGroup {
  /** Grouping identity: the family key, or SIN_PATRON_FAMILY / SIN_NOMBRE_CAMPAIGN. */
  key: string
  /**
   * What the header shows: the longest prefix every member shares, which is
   * usually longer than `key` ("IW - CC - FF - Corregidora", not just "IW").
   * Falls back to `key` when the members share nothing printable.
   */
  label: string
  kind: "family" | "orphan" | "unnamed"
  campaigns: CampaignRow[]
  pautas: number
  leads: number
}

/**
 * Length of the longest prefix shared by every name, cut back to a separator
 * boundary so it never slices mid-word. 0 when there's nothing worth hoisting.
 *
 * This is what lets the header carry the shared prefix while rows keep only
 * their distinguishing tail: repeating "IW - CC - FF - Corregidora - " on forty
 * rows is noise, and greying it out just turns the noise into a code the reader
 * has to crack.
 */
function sharedPrefixCut(names: string[]): number {
  if (names.length < 2) return 0
  let prefix = names[0] ?? ""
  for (const n of names) {
    let i = 0
    while (i < prefix.length && i < n.length && prefix[i] === n[i]) i++
    prefix = prefix.slice(0, i)
    if (!prefix) return 0
  }
  let cut = 0
  for (const sep of [" ", "-", "|", "_", "/"]) cut = Math.max(cut, prefix.lastIndexOf(sep) + 1)
  return cut
}

/**
 * Bucket campaign tallies into families detected at `depth`, ordered for
 * display: real families by volume desc, then "Sin patrón", then "Sin nombre".
 * The two leftover buckets are pinned last regardless of volume — they are
 * residue, not findings, and letting a big one lead would bury the signal.
 */
export function groupCampaignsByFamily(
  tallies: CampaignTally[],
  depth: number,
): CampaignGroup[] {
  const families = new Map<string, CampaignRow[]>()
  const orphans: CampaignRow[] = []
  const unnamed: CampaignRow[] = []

  for (const t of tallies) {
    if (t.name === SIN_NOMBRE_CAMPAIGN) {
      unnamed.push({ ...t, prefixLen: 0 })
      continue
    }
    const split = campaignFamilySplit(t.name, depth)
    if (!split) {
      orphans.push({ ...t, prefixLen: 0 })
      continue
    }
    const arr = families.get(split.family) ?? []
    arr.push({ ...t, prefixLen: split.prefixLen })
    families.set(split.family, arr)
  }

  // A family of one costs a header and a color and conveys nothing. Demote it,
  // and drop its dimming — we did not actually find a pattern.
  for (const [key, rows] of families) {
    if (rows.length > 1) continue
    orphans.push({ ...rows[0], prefixLen: 0 })
    families.delete(key)
  }

  const byVolume = (a: CampaignRow, b: CampaignRow) =>
    b.pautas - a.pautas || a.name.localeCompare(b.name, "es")
  const sum = (rows: CampaignRow[], k: "pautas" | "leads") =>
    rows.reduce((s, r) => s + r[k], 0)

  const groups: CampaignGroup[] = [...families.entries()]
    .map(([key, rows]) => {
      // Hoist the shared prefix into the header. Row-level prefixLen is
      // recomputed here and REPLACES the one campaignFamilySplit produced: the
      // family key ("IW") is only how members were bucketed, while the header
      // can show everything they actually have in common
      // ("IW - CC - FF - Corregidora").
      const cut = sharedPrefixCut(rows.map((r) => r.name))
      const campaigns = rows
        // A member whose whole name IS the shared prefix would render as an
        // empty row, so it keeps its full name.
        .map((r) => ({ ...r, prefixLen: r.name.slice(cut).trim() ? cut : 0 }))
        .sort(byVolume)
      const label =
        (cut > 0 ? rows[0].name.slice(0, cut).replace(/[\s\-|_/]+$/, "") : "") || key
      return {
        key,
        label,
        kind: "family" as const,
        campaigns,
        pautas: sum(rows, "pautas"),
        leads: sum(rows, "leads"),
      }
    })
    .sort((a, b) => b.pautas - a.pautas || a.key.localeCompare(b.key, "es"))

  // The leftover buckets share no prefix by construction, so their rows always
  // render in full.
  if (orphans.length > 0) {
    groups.push({
      key: SIN_PATRON_FAMILY,
      label: SIN_PATRON_FAMILY,
      kind: "orphan",
      campaigns: [...orphans].sort(byVolume),
      pautas: sum(orphans, "pautas"),
      leads: sum(orphans, "leads"),
    })
  }
  if (unnamed.length > 0) {
    groups.push({
      key: SIN_NOMBRE_CAMPAIGN,
      label: SIN_NOMBRE_CAMPAIGN,
      kind: "unnamed",
      campaigns: [...unnamed].sort(byVolume),
      pautas: sum(unnamed, "pautas"),
      leads: sum(unnamed, "leads"),
    })
  }
  return groups
}
