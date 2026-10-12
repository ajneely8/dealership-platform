import type { Answer, Check, Checks, Fit, FitTier } from "@/domain/checks";

const ANSWER_STYLE: Record<Answer, string> = {
  YES: "bg-good text-paper",
  NO: "bg-bad text-paper",
  UNKNOWN: "border border-line bg-paper text-muted",
};
const ANSWER_TEXT: Record<Answer, string> = { YES: "Yes", NO: "No", UNKNOWN: "Not checked" };

export function AnswerPill({ answer }: { answer: Answer }) {
  return <span className={`num inline-block min-w-[32px] rounded-sm px-1.5 py-px text-center text-[10.5px] font-medium uppercase tracking-[0.06em] leading-4 ${ANSWER_STYLE[answer]}`}>{ANSWER_TEXT[answer]}</span>;
}

export const CHECK_LABEL: Record<keyof Checks, string> = { chatbot: "Chatbot", receptionist: "AI receptionist", followUp: "Lead follow-up" };

/** Compact: three pills in a row, for tables. */
export function CheckRow({ checks }: { checks: Checks }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1 text-[12px]">
      {(Object.keys(CHECK_LABEL) as (keyof Checks)[]).map((k) => (
        <span key={k} className="inline-flex items-center gap-1.5 whitespace-nowrap" title={checks[k].detail}>
          <span className="text-muted">{CHECK_LABEL[k]}</span>
          <AnswerPill answer={checks[k].answer} />
        </span>
      ))}
    </div>
  );
}

/** Full: one card per question with the answer and the one-line detail. */
export function CheckCards({ checks, extra, append }: { checks: Checks; extra?: Partial<Record<keyof Checks, React.ReactNode>>; append?: React.ReactNode }) {
  return (
    <div className={`grid gap-px bg-line-soft ${append ? "md:grid-cols-2 xl:grid-cols-4" : "md:grid-cols-3"}`}>
      {(Object.keys(CHECK_LABEL) as (keyof Checks)[]).map((k) => {
        const c: Check = checks[k];
        return (
          <div key={k} className="bg-surface px-4 py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[14px] font-semibold">{CHECK_LABEL[k]}</span>
              <AnswerPill answer={c.answer} />
            </div>
            <p className="mt-1.5 text-[13px] leading-snug text-text">{c.detail}</p>
            <p className="num mt-1 text-[10.5px] uppercase tracking-[0.08em] text-faint">
              {c.source === "WEBSITE" ? "From website scan" : c.source === "LIVE_TEST" ? "From live test" : c.source === "PHONE_CALL" ? "From phone call" : c.source === "MANUAL" ? "Checked by hand" : "No data yet"}
            </p>
            {extra?.[k] ? <div className="mt-2">{extra[k]}</div> : null}
          </div>
        );
      })}
      {append}
    </div>
  );
}

const FIT_STYLE: Record<FitTier, string> = {
  STRONG: "bg-good text-paper",
  POSSIBLE: "bg-blue text-white",
  WEAK: "border border-line bg-paper text-muted",
  UNKNOWN: "border border-line bg-paper text-faint",
};
const FIT_TEXT: Record<FitTier, string> = { STRONG: "Strong fit", POSSIBLE: "Possible fit", WEAK: "Weak fit", UNKNOWN: "Not enough data" };

/** The verdict a salesperson needs: is this dealership the kind we want, and why. */
export function FitBadge({ fit, withReasons = true }: { fit: Fit; withReasons?: boolean }) {
  return (
    <div>
      <span className={`num inline-block rounded-sm px-1.5 py-px text-[10.5px] font-medium uppercase tracking-[0.06em] leading-4 ${FIT_STYLE[fit.tier]}`}>{FIT_TEXT[fit.tier]}</span>
      {withReasons && fit.reasons.length ? <div className="mt-1 text-[12.5px]">{fit.reasons.join(" · ")}</div> : null}
    </div>
  );
}
