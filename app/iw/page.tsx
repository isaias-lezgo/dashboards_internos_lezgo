// app/iw/page.tsx
// The IW door: today a single project (Condesa Cimatario). Same component as /domus;
// what IW may open is declared in lib/scopes.ts and enforced in requireClient().
import { IW_SCOPE_ID } from "@/lib/scopes";
import { ScopeDoor } from "@/components/dashboard/scope-door";

export default async function IwPage() {
  return <ScopeDoor scopeId={IW_SCOPE_ID} />;
}
