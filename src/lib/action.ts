import { revalidatePath } from "next/cache";
import { redirect, unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";
import { logger } from "./logger";

/** Only same-site relative paths are accepted as a return target (no open redirects). */
function safeBack(value: FormDataEntryValue | null, fallback: string): string {
  const s = typeof value === "string" ? value : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : fallback;
}

/**
 * Wraps a server action: runs it, then redirects back to the page with a notice or an error message.
 * Errors are never swallowed — the operator sees what went wrong and it is logged.
 */
export async function act(form: FormData, fallback: string, fn: () => Promise<string | void>): Promise<never> {
  const back = safeBack(form.get("back"), fallback).split("#")[0]!;
  const hash = safeBack(form.get("back"), fallback).split("#")[1];
  let key = "notice";
  let message = "";
  let target = back;
  try {
    const result = await fn();
    // An action may return "redirect:/path" to send the user somewhere new (e.g. after creating a record).
    if (typeof result === "string" && result.startsWith("redirect:")) target = result.slice(9);
    else message = result ?? "Saved.";
  } catch (err) {
    unstable_rethrow(err);
    key = "error";
    if (err instanceof ZodError) message = err.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ");
    else message = err instanceof Error ? err.message : "Something went wrong.";
    logger.warn({ err: message, back }, "action failed");
  }
  revalidatePath("/", "layout");
  if (target !== back) redirect(target);
  const url = new URL(target, "http://x");
  url.searchParams.delete("notice");
  url.searchParams.delete("error");
  if (message) url.searchParams.set(key, message.slice(0, 500));
  redirect(`${url.pathname}${url.search}${hash ? `#${hash}` : ""}`);
}

export const str = (form: FormData, key: string): string => {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
};
export const opt = (form: FormData, key: string): string | null => str(form, key) || null;
