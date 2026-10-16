import { count, eq } from "drizzle-orm";
import Image from "next/image";
import { logout } from "@/app/actions";
import { Nav } from "@/components/nav";
import { TopBar } from "@/components/topbar";
import { db } from "@/db";
import { testInteractions } from "@/db/schema";
import { requireUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [pending] = await db().select({ n: count() }).from(testInteractions).where(eq(testInteractions.status, "PENDING_APPROVAL"));
  return (
    <div className="min-h-screen md:grid md:grid-cols-[216px_1fr]">
      <aside className="bg-black text-white md:sticky md:top-0 md:h-screen md:overflow-y-auto">
        <div className="flex items-center gap-3 border-b border-line px-4 py-4">
          <div className="leading-tight">
            <Image src="/sidekick-logo.png" alt="SideKick" width={168} height={84} priority className="-ml-1 h-auto w-[168px]" />
            <div className="num mt-1 text-[10.5px] uppercase tracking-[0.12em] text-[#c3d2e6]">Intelligence Command Center</div>
          </div>
        </div>
        <Nav pending={pending?.n ?? 0} />
      </aside>
      <div className="min-w-0">
        <TopBar>
          <div className="flex items-center gap-3 text-[12.5px]">
            <span className="hidden text-muted sm:inline" title={user.email}>
              {user.name} <span className="num text-[10.5px] uppercase tracking-[0.08em] text-faint">· {user.role}</span>
            </span>
            <form action={logout}>
              <button className="btn btn-sm" type="submit">
                Sign out
              </button>
            </form>
          </div>
        </TopBar>
        <main className="px-4 py-5 md:px-6 md:py-6">{children}</main>
      </div>
    </div>
  );
}
