// app/page.tsx
// Server shell. Decides between the project picker and the dashboard based on the
// dash_project cookie, narrowed by the session's access scope. The middleware gate
// has already run, so anyone reaching here holds a valid dash_access.
import { cookies } from "next/headers";
import { PROJECT_COOKIE, verifyToken } from "@/lib/auth";
import { getClientById, getClients } from "@/lib/clients";
import { scopeAllows } from "@/lib/scopes";
import { currentScope } from "@/lib/session";
import { DashboardApp } from "@/components/dashboard/dashboard-app";
import { ProjectPicker } from "@/components/dashboard/project-picker";

export default async function Page() {
  const scope = await currentScope();
  const token = (await cookies()).get(PROJECT_COOKIE)?.value;
  const projectId = await verifyToken(token);
  const selected = scope && projectId ? safeLookup(projectId) : null;

  // A project selected before the session narrowed (or by a different password on
  // this machine) is treated as no selection: the picker is the honest answer, and
  // requireClient() would 401 every fetch the dashboard made anyway.
  if (scope && selected && scopeAllows(scope, selected.id)) return <DashboardApp />;

  // Only id and name cross into the browser bundle — never ghlToken or locationId,
  // and never a project outside this session's scope.
  const projects = scope
    ? safeRoster()
        .filter((c) => scopeAllows(scope, c.id))
        .map((c) => ({ id: c.id, name: c.name }))
    : [];
  return <ProjectPicker projects={projects} title={scope?.label ?? "Proyectos Lezgo"} />;
}

function safeLookup(id: string) {
  try {
    return getClientById(id);
  } catch (err) {
    console.error("[page] Could not load project roster:", err);
    return null;
  }
}

function safeRoster() {
  try {
    return getClients();
  } catch (err) {
    // A broken roster shows an empty picker rather than a Next.js error overlay.
    console.error("[page] Could not load project roster:", err);
    return [];
  }
}
