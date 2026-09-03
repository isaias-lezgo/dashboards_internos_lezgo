// app/domus/page.tsx
// The Domus door. All of the logic — and the reasoning about why this route is not
// the security boundary — lives in ScopeDoor.
import { DOMUS_SCOPE_ID } from "@/lib/scopes";
import { ScopeDoor } from "@/components/dashboard/scope-door";

export default async function DomusPage() {
  return <ScopeDoor scopeId={DOMUS_SCOPE_ID} />;
}
