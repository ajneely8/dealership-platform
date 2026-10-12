import Link from "next/link";
import type { ScoreReason } from "@/db/schema";
import { PRODUCT_LABEL, type Confidence, type FindingKind, type Product } from "@/domain/constants";

export const PRODUCT_COLOR: Record<Product, string> = {
  SUMMARYBOT: "var(--color-summarybot)",
  INVENTORY_OUTREACH: "var(--color-inventory)",
  SERVICE_BOT: "var(--color-service)",
  SOCIAL_AUTOMATION: "var(--color-social)",
};

/** Short codes used wherever a product has to fit in a narrow column. */
export const PRODUCT_CODE: Record<Product, string> = { SUMMARYBOT: "SB", INVENTORY_OUTREACH: "IO", SERVICE_BOT: "SV", SOCIAL_AUTOMATION: "SO" };

export function PageHeader({ title, sub, children }: { title: string; sub?: React.ReactNode; children?: React.ReactNode }) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-3 border-b border-line pb-4">
      <div className="min-w-0">
        <h1 className="text-[22px] font-semibold leading-tight tracking-[-0.01em]">{title}</h1>
        {sub ? <p className="mt-1 text-[13px] text-muted">{sub}</p> : null}
      </div>
      {children ? <div className="flex flex-wrap items-center gap-2">{children}</div> : null}
    </header>
  );
}

export function Panel({ title, action, children, className = "", id }: { title?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={`hud rounded-md border border-line bg-surface ${className}`}>
      {title ? (
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
          <h2 className="eyebrow flex items-center gap-2 text-text">
            <span aria-hidden className="inline-block h-3 w-0.5 bg-blue" />
            {title}
          </h2>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-4 py-6 text-[13px] text-muted">{children}</p>;
}

/**
 * Key figures as one ruled strip rather than a row of boxes: label above, mono figure,
 * supporting detail below, hairline between cells.
 */
export function MetricStrip({ items }: { items: { label: string; value: React.ReactNode; hint?: string; tone?: "default" | "bad" | "good" }[] }) {
  return (
    <div className="grid grid-cols-2 divide-y divide-line-soft rounded-md border border-line bg-surface md:grid-cols-4 md:divide-x md:divide-y-0 xl:grid-cols-7">
      {items.map((m) => (
        <div key={m.label} className="px-5 py-4">
          <div className="eyebrow">{m.label}</div>
          <div className={`num mt-1.5 text-[26px] font-medium leading-none tracking-tight ${m.tone === "bad" ? "text-bad" : m.tone === "good" ? "text-good" : "text-text"}`}>{m.value}</div>
          <div className="mt-1.5 min-h-[14px] text-[11.5px] text-faint">{m.hint ?? ""}</div>
        </div>
      ))}
    </div>
  );
}

/** Kept for pages that show one or two figures outside the strip. */
export function Stat({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return <MetricStrip items={[{ label, value, hint }]} />;
}

const TONES = {
  neutral: "text-muted",
  good: "text-good",
  warn: "text-warn",
  bad: "text-bad",
  ink: "text-text",
  blue: "text-blue-light",
} as const;

export function Badge({ children, tone = "neutral" }: { children: React.ReactNode; tone?: keyof typeof TONES }) {
  return (
    <span className={`num inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] font-medium uppercase tracking-[0.08em] ${TONES[tone]}`}>
      <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-current opacity-80" />
      {children}
    </span>
  );
}

/** Product name with a thin rule in its colour — a mark, not an icon. */
export function ProductTag({ product, code = false }: { product: Product | null; code?: boolean }) {
  if (!product) return <span className="text-faint">—</span>;
  return (
    <span className="inline-flex items-center gap-2 whitespace-nowrap text-[13px] font-medium">
      <span aria-hidden className="inline-block h-3.5 w-0.5" style={{ background: PRODUCT_COLOR[product] }} />
      {code ? <span className="num">{PRODUCT_CODE[product]}</span> : PRODUCT_LABEL[product]}
    </span>
  );
}

/**
 * Provenance as a typographic tag: OBS = observed fact, INF = inference, then confidence.
 * Observed is solid ink; an inference is outlined, so the difference reads at a glance.
 */
export function Provenance({ kind, confidence }: { kind: FindingKind; confidence?: Confidence }) {
  const observed = kind === "OBSERVED";
  return (
    <span className="num inline-flex items-center gap-1.5 whitespace-nowrap text-[10.5px] tracking-[0.06em]" title={observed ? "Observed fact" : "Inference"}>
      <span className={`rounded-sm px-1 leading-4 ${observed ? "bg-text text-paper" : "border border-text text-text"}`}>{observed ? "OBS" : "INF"}</span>
      {confidence ? <span className="uppercase text-faint">{confidence}</span> : null}
    </span>
  );
}

export function ScoreNumber({ score, size = "md" }: { score: number; size?: "md" | "lg" }) {
  const tone = score >= 70 ? "text-text" : score >= 40 ? "text-text" : "text-muted";
  return <span className={`num font-medium tracking-tight ${tone} ${size === "lg" ? "text-[34px] leading-none" : "text-[15px]"}`}>{score}</span>;
}

/**
 * The score drawn as its own explanation: one segment per reason, width = points.
 * Hatched segments are inferences. Empty track = the points not scored.
 */
export function ReasonBar({ product, score, reasons }: { product: Product; score: number; reasons: ScoreReason[] }) {
  const total = reasons.reduce((a, r) => a + r.points, 0);
  const scale = total > 100 ? 100 / total : 1;
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-[1px] bg-line-soft" role="img" aria-label={`${PRODUCT_LABEL[product]} score ${score} of 100`}>
      {reasons.map((r) => (
        <span
          key={r.ruleId}
          title={`+${r.points} ${r.label}`}
          className="h-full border-r border-surface last:border-r-0"
          style={{
            width: `${r.points * scale}%`,
            background: r.kind === "OBSERVED" ? PRODUCT_COLOR[product] : `repeating-linear-gradient(135deg, ${PRODUCT_COLOR[product]} 0 2px, transparent 2px 4px)`,
          }}
        />
      ))}
    </div>
  );
}

export function Field({ label, children, hint, className = "" }: { label: string; children: React.ReactNode; hint?: string; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="eyebrow mb-1.5 block">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[12px] text-faint">{hint}</span> : null}
    </label>
  );
}

export function Flash({ notice, error }: { notice?: string; error?: string }) {
  if (!notice && !error) return null;
  return (
    <div role="status" className={`mb-4 border-l-2 px-3 py-2 text-[13px] ${error ? "border-bad bg-[#2a0f0f] text-bad" : "border-good bg-[#0b2a1d] text-good"}`}>
      {error ?? notice}
    </div>
  );
}

export function A({ href, children, className = "" }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <Link href={href} className={`font-medium text-blue-deep hover:text-blue hover:underline ${className}`}>
      {children}
    </Link>
  );
}

export function ExternalLink({ href, children }: { href: string; children?: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className="break-all text-blue-deep hover:text-blue hover:underline">
      {children ?? href.replace(/^https?:\/\//, "")}
    </a>
  );
}

export function fmtDate(d: Date | null | undefined, withTime = false): string {
  if (!d) return "—";
  return d.toLocaleString("en-US", withTime ? { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" } : { month: "short", day: "numeric", year: "numeric" });
}

export function timeAgo(d: Date | null | undefined): string {
  if (!d) return "never";
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export const label = (s: string) => s.toLowerCase().replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
