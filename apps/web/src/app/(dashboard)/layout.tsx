import { prisma } from "@magnemite/db";
import { requireUser } from "@/lib/session";
import { LiveRefresh } from "@/components/live-refresh";
import { Nav } from "@/components/nav";
import { ShortcutsProvider } from "@/components/shortcuts/shortcuts-provider";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();

  // Small counts in the sidebar, so a stuck rollout is visible from anywhere.
  const [online, total, activeRollouts] = await Promise.all([
    prisma.device.count({ where: { kind: "BOX", status: "ONLINE" } }),
    prisma.device.count({ where: { kind: "BOX" } }),
    prisma.rollout.count({ where: { status: { in: ["CANARY", "SOAKING", "RUNNING", "PAUSED"] } } }),
  ]);

  return (
    // Around everything, so the sidebar, the pages and the palette all bind
    // keys through the one listener — and so a viewer's keys never include
    // the ones that change the fleet.
    <ShortcutsProvider canOperate={user.role !== "VIEWER"}>
      <div className="flex min-h-screen">
        <Nav online={online} total={total} activeRollouts={activeRollouts} />
        <div className="flex min-w-0 flex-1 flex-col">
          <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 pb-8 pt-20 sm:px-6 lg:px-8 lg:pt-6">
            {children}
          </main>
        </div>
        <LiveRefresh />
      </div>
    </ShortcutsProvider>
  );
}
