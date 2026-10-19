// lib/scopes.ts
// Access scopes: which projects one password unlocks.
//
// Pure and Edge-safe ON PURPOSE — middleware.ts imports this file, so it must NEVER
// import lib/clients.ts: that would pull every project's GHL token into the Edge
// bundle. Scopes name projects by id only, and ids are not secrets.
//
// A scope id rides inside the dot-delimited dash_access token, so it may not contain
// a dot — the same constraint project ids have (see lib/auth.ts).
//
// The list of projects lives HERE rather than in an env var so that changing who sees
// what is a commit: versioned, reviewable in the diff. The passwords — which ARE
// secrets — stay in env vars, named by `passwordEnv`.

// The dashboard's tabs, by the ids dashboard-app.tsx uses. Declared here (not imported
// from the component) so this module stays pure and Edge-safe.
export type ScopeTab = "marketing" | "sales" | "conversations" | "pmi";

export interface AccessScope {
  id: string;
  /** Title of the project picker, and of the browser tab. */
  label: string;
  /** Name of the env var holding THIS scope's password. */
  passwordEnv: string;
  /** null = every project in the roster, including ones added later. */
  projectIds: readonly string[] | null;
  /** null = every tab. Otherwise the ONLY tabs this session sees, in this order. */
  tabs?: readonly ScopeTab[] | null;
}

// Note this list is static even when a scope's password env var is absent. The login
// route is what refuses to mint a session for an unconfigured scope; keeping SCOPES
// free of process.env keeps this module pure and its behaviour identical everywhere.
export const SCOPES: readonly AccessScope[] = [
  {
    id: "all",
    label: "Proyectos Lezgo",
    passwordEnv: "DASHBOARD_ACCESS_PASSWORD",
    projectIds: null,
  },
  {
    id: "domus",
    label: "Proyectos Domus",
    passwordEnv: "DOMUS_ACCESS_PASSWORD",
    projectIds: ["condesa", "yconia", "plaza-bosques"],
  },
  {
    id: "iw",
    label: "Proyectos IW",
    passwordEnv: "IW_ACCESS_PASSWORD",
    projectIds: ["condesa"],
  },
  {
    // Solo la pestaña Desempeño (el PMI de los asesores), en cualquier proyecto.
    // Ocultar pestañas en la UI es cosmético; lo que impide usar el asistente (que
    // escribe en el CRM) es scopeAllowsTab() en /api/chat, /api/ghl-write y
    // /api/attachments/process.
    id: "desempeno",
    label: "Desempeño Lezgo",
    passwordEnv: "DESEMPENO_ACCESS_PASSWORD",
    projectIds: null,
    tabs: ["pmi"],
  },
];

export const DOMUS_SCOPE_ID = "domus";
export const IW_SCOPE_ID = "iw";
export const DESEMPENO_SCOPE_ID = "desempeno";

// Fails closed: an unknown, empty or missing id resolves to null, which every caller
// reads as "no access".
export function getScope(id: string | null | undefined): AccessScope | null {
  if (!id) return null;
  return SCOPES.find((s) => s.id === id) ?? null;
}

export function scopeAllows(scope: AccessScope, projectId: string): boolean {
  if (scope.projectIds === null) return true;
  return scope.projectIds.includes(projectId);
}

export function scopeAllowsTab(scope: AccessScope, tab: ScopeTab): boolean {
  if (!scope.tabs) return true;
  return scope.tabs.includes(tab);
}
