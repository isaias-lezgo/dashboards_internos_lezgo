// lib/meta-admin.ts
// Quién puede tocar la conexión con Meta: SOLO una sesión del alcance `all`.
// Los alcances de agencia (domus, iw) ven el gasto de sus proyectos, pero no
// conectan, reconectan, desconectan ni asignan cuentas — la conexión es del
// despliegue entero, y reconectar con otra empresa la sobrescribe para todos.
import { currentScope } from "./session";
import type { AccessScope } from "./scopes";

export const META_ADMIN_SCOPE = "all";

export async function requireMetaAdmin(): Promise<AccessScope | null> {
  const scope = await currentScope();
  if (!scope || scope.id !== META_ADMIN_SCOPE) return null;
  return scope;
}

export function forbidden(): Response {
  return Response.json({ error: "forbidden" }, { status: 403 });
}

export function metaConfigured(): boolean {
  return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET && process.env.META_LOGIN_CONFIG_ID);
}
