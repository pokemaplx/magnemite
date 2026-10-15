import { requireOperator } from "@/lib/session";
import { HUB_BASE_URL, HUB_SECRET } from "@/lib/hub";

// Node, not edge: the PNG is piped through rather than buffered.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Serve one collected screenshot.
 *
 * The log bundle route's twin, and for the same reason: the image lives on the
 * artifacts volume, which is mounted on the hub and not here. The session check
 * is what makes this safe to hand to a browser — and here it is doing more work
 * than it does for a zip, because this is a picture of somebody's television.
 *
 * Inline rather than an attachment: the point is to look at it.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string; screenshotId: string }> },
) {
  try {
    await requireOperator();
  } catch (err) {
    return new Response(err instanceof Error ? err.message : "not allowed", { status: 403 });
  }

  const { id, screenshotId } = await params;

  let upstream: Response;
  try {
    upstream = await fetch(`${HUB_BASE_URL}/internal/devices/${id}/screenshot/${screenshotId}`, {
      headers: { "x-magnemite-secret": HUB_SECRET },
      signal: request.signal,
      cache: "no-store",
    });
  } catch (err) {
    return new Response(
      `The hub is not reachable at ${HUB_BASE_URL} (${
        err instanceof Error ? err.message : String(err)
      })`,
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text();
    return new Response(text || "the screenshot is not available", { status: upstream.status });
  }

  return new Response(upstream.body, {
    headers: {
      "Content-Type": "image/png",
      ...(upstream.headers.get("content-length")
        ? { "Content-Length": upstream.headers.get("content-length")! }
        : {}),
      // A capture never changes once it has landed and its id is in the path,
      // so the browser may keep it. `private`, because the session check above
      // is the only thing standing in front of it.
      "Cache-Control": "private, max-age=86400, immutable",
    },
  });
}
