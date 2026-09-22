// Canonical "won" detection, shared by the Marketing and Ventas dashboards so
// every won-based metric (counts, revenue, close rate, funnel) agrees.
//
// Some sub-accounts never flip GHL's `status` to "won": they record the sale by
// moving the opportunity into a late pipeline stage such as "09. Negocio Ganado"
// ("Closed Won") while leaving `status === "open"`. Treat either signal as a win
// so the dashboards work regardless of how a location operates. Detection is
// stage-name based (no hardcoded stage IDs) to stay portable across locations.
import type { Opportunity } from "./types"

// "Negocio Ganado" / "Negocio Ganada(s)" (es) and "Won" / "Closed Won" (en).
// Word-boundary on "won" avoids matching it as a substring of unrelated words.
const WON_STAGE_PATTERN = /ganad[oa]|\bwon\b/i

// "Negocio Perdido" / "Prospecto Perdido" (es) and "Lost" / "Closed Lost" (en).
const LOST_STAGE_PATTERN = /perdid[oa]|\blost\b/i

// Lost is either signal: GHL's status, or the pipeline's lost stage. Some
// sub-accounts move the opportunity into "Negocio Perdido" without touching the
// status, and the reverse happens when an automation marks `lost` in place.
export function isLostOpp(opp: Opportunity): boolean {
  if (opp.status === "lost" || opp.status === "abandoned") return true
  return LOST_STAGE_PATTERN.test(opp.stage ?? "")
}

export function isWonOpp(opp: Opportunity): boolean {
  if (opp.status === "won") return true
  // An explicitly lost/abandoned opp is never a win, even if it lingers in a
  // stage whose name happens to match (e.g. moved then marked lost).
  if (opp.status === "lost" || opp.status === "abandoned") return false
  return WON_STAGE_PATTERN.test(opp.stage ?? "")
}
