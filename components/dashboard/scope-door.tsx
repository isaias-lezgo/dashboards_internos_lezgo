// components/dashboard/scope-door.tsx
// A "door": a shareable link that opens the project picker filtered to ONE access
// scope. /domus and /iw are the same component with a different scope id.
//
// A door is NOT the security boundary. A session's scope comes from the password it
// was opened with (lib/scopes.ts) and is enforced in requireClient(); this only
// narrows what the picker offers. Reaching a door with the general password grants
// nothing extra — it is a filtered view of what that session could already open.
//
// It is one component on purpose: the intersection below is subtle enough that a
// second hand-written copy would eventually drift from this one.
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { PROJECT_COOKIE, verifyToken } from "@/lib/auth";
import { getClients } from "@/lib/clients";
import { getScope, scopeAllows } from "@/lib/scopes";
import { currentScope } from "@/lib/session";
import { ProjectPicker } from "@/components/dashboard/project-picker";

export async function ScopeDoor({ scopeId }: { scopeId: string }) {
  const door = getScope(scopeId);
  const session = await currentScope();
  if (!door || !session) redirect("/");

  // Already inside one of the door's projects → the dashboard, which lives at /. The
  // test is membership in the DOOR's scope, not merely in the session's: a general
  // session with Grand Center open is better served the Domus picker than Grand
  // Center's dashboard, which is not what this link means.
  const token = (await cookies()).get(PROJECT_COOKIE)?.value;
  const projectId = await verifyToken(token);
  if (projectId && scopeAllows(door, projectId) && scopeAllows(session, projectId)) {
    redirect("/");
  }

  // The intersection of the two scopes: a general session sees exactly the door's
  // projects, and a narrower session cannot be widened by visiting this route.
  const projects = safeRoster(scopeId)
    .filter((c) => scopeAllows(door, c.id) && scopeAllows(session, c.id))
    .map((c) => ({ id: c.id, name: c.name }));

  return <ProjectPicker projects={projects} title={door.label} />;
}

function safeRoster(scopeId: string) {
  try {
    return getClients();
  } catch (err) {
    console.error(`[${scopeId}] Could not load project roster:`, err);
    return [];
  }
}
