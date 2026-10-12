import Image from "next/image";
import { redirect } from "next/navigation";
import { login } from "@/app/actions";
import { Field, Flash } from "@/components/ui";
import { getSessionUser } from "@/lib/auth/session";

export const dynamic = "force-dynamic";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  if (await getSessionUser()) redirect("/command");
  const { error, notice } = await searchParams;
  return (
    <main className="grid min-h-screen md:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
      <section className="hidden flex-col justify-between bg-black p-10 text-white md:flex">
        <div className="flex items-center gap-3">
          <Image src="/sarvx-logo.png" alt="SarvX" width={44} height={44} priority className="rounded-sm" />
          <div className="leading-tight">
            <div className="text-[16px] font-semibold">SarvX</div>
            <div className="num text-[11px] uppercase tracking-[0.12em] text-[#c3d2e6]">Dealer Intel · Research desk</div>
          </div>
        </div>
        <div className="max-w-md">
          <p className="text-[26px] font-semibold leading-snug tracking-[-0.01em]">Call the right dealership first, with the evidence in hand.</p>
          <p className="mt-4 text-[14px] leading-relaxed text-[#c3d2e6]">Website research, measured lead response, hiring signals and inventory, scored by fixed rules and traced back to proof.</p>
        </div>
        <div className="num text-[11px] uppercase tracking-[0.1em] text-[#54718e]">Authorised staff only</div>
      </section>
      <section className="grid place-items-center px-6 py-10">
        <div className="w-full max-w-[360px]">
          <div className="mb-6 md:hidden">
            <Image src="/sarvx-logo.png" alt="SarvX" width={40} height={40} priority className="rounded-sm" />
          </div>
          <div className="eyebrow">Sign in</div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.01em]">Research desk</h1>
          <div className="mt-5">
            <Flash error={error} notice={notice} />
          </div>
          <form action={login} className="space-y-4">
            <Field label="Email">
              <input className="input" type="email" name="email" autoComplete="username" required autoFocus />
            </Field>
            <Field label="Password">
              <input className="input" type="password" name="password" autoComplete="current-password" required />
            </Field>
            <button className="btn btn-primary w-full justify-center py-2" type="submit">
              Sign in
            </button>
          </form>
        </div>
      </section>
    </main>
  );
}
