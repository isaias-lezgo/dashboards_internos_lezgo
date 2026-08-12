import { requireClient, unauthorized } from "@/lib/session";
import { syncProject } from "@/lib/sync";

export const runtime = "nodejs";

function enc(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

export async function GET() {
  // Resolve the client here, in the request scope — cookies() is unavailable
  // inside the stream callback below.
  const client = await requireClient();
  if (!client) return unauthorized();

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // The client context is entered inside syncProject, not around GET(): the
      // stream keeps producing frames after GET() has returned, so wrapping the
      // handler would leave the pump running outside the context (where
      // currentClient() throws).
      const send = (obj: unknown) => controller.enqueue(encoder.encode(enc(obj)));
      try {
        const payload = await syncProject(client, send);
        send({ type: "data", ...payload });
      } catch (error) {
        console.error("[GHL Dashboard API Error]", error);
        send({
          type: "error",
          error: "Failed to fetch dashboard data",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    },
  });
}
