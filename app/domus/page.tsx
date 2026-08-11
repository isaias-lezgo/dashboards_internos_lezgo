// app/domus/page.tsx
// The Domus door: a shareable link that opens the picker filtered to the Domus
// projects. It is ONLY a door — the dashboard itself still lives at /, so opening a
// project from here navigates there.
//
// This route is NOT the security boundary. A session's scope comes from the password
// it was opened with (lib/scopes.ts) and is enforced in requireClient(); this page
// only narrows what the picker offers. Reaching /domus with the general password
// grants nothing extra — it is a filtered view of what that session could already
// open.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PROJECT_COOKIE, verifyToken } from "@/lib/auth";
import { getClients } from "@/lib/clients";
import { DOMUS_SCOPE_ID, getScope, scopeAllows } from "@/lib/scopes";
import { currentScope } from "@/lib/session";
import { ProjectPicker } from "@/components/dashboard/project-picker";

export default async function DomusPage() {
  const domus = getScope(DOMUS_SCOPE_ID);
  const session = await currentScope();
  if (!domus || !session) redirect("/");

  // Already inside a Domus project → the dashboard, which lives at /. The test is
  // membership in DOMUS, not merely in the session's scope: a general session with
  // Grand Center open is better served the Domus picker than Grand Center's
  // dashboard, which is not what this link means.
  const token = (await cookies()).get(PROJECT_COOKIE)?.value;
  const projectId = await verifyToken(token);
  if (projectId && scopeAllows(domus, projectId) && scopeAllows(session, projectId)) {
    redirect("/");
  }

  // The intersection of the two scopes: a general session sees the same three, and a
  // Domus session cannot be widened by visiting this route.
  const projects = safeRoster()
    .filter((c) => scopeAllows(domus, c.id) && scopeAllows(session, c.id))
    .map((c) => ({ id: c.id, name: c.name }));

  return <ProjectPicker projects={projects} title={domus.label} />;
}

function safeRoster() {
  try {
    return getClients();
  } catch (err) {
    console.error("[domus] Could not load project roster:", err);
    return [];
  }
}
