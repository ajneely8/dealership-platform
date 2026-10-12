/**
 * How good a dealership's chatbot is, from what a controlled test actually saw. Deterministic.
 *
 *   NONE  — no chat on the site, or a chat script that never produced a launcher
 *   BAD   — the widget opened but could not be used, never replied, or only collected contact
 *           details / said someone would be in touch without answering the question
 *   GOOD  — it answered the question, or a person joined within the window
 */
export type ChatGrade = "GOOD" | "BAD" | "NONE";

export type ChatGradeInput = {
  chatPresent: boolean;
  launcherFound: boolean;
  boxFound: boolean;
  replies: string[];
  humanReplies: number;
  answered: boolean;
  contactRequired: boolean;
  firstResponseSeconds: number | null;
};

const ANSWERS = /\b(yes|still available|in stock|we have|it'?s here|sold|no longer|not available|price is|\$\d|stock (number|#)|vin|mileage|miles|colou?r|trim|year)\b/i;
const DEFLECTS = /\b(someone will|will (be|get) (in touch|back to you|with you)|contact you (shortly|soon)|leave your|best (number|email)|provide your|phone number|email address|representative will|one moment|connect(ing)? you)\b/i;

export function gradeChatbot(i: ChatGradeInput): { grade: ChatGrade; score: number; reasons: string[] } {
  const reasons: string[] = [];
  if (!i.chatPresent) return { grade: "NONE", score: 0, reasons: ["no chat widget on the site"] };
  if (!i.launcherFound) return { grade: "NONE", score: 0, reasons: ["a chat script is installed but no launcher ever appeared"] };
  if (!i.boxFound) return { grade: "BAD", score: 10, reasons: ["the widget opened but had no usable message box"] };
  if (i.replies.length === 0) return { grade: "BAD", score: 15, reasons: ["no reply within the test window"] };

  let score = 40;
  if (i.firstResponseSeconds !== null && i.firstResponseSeconds <= 30) {
    score += 10;
    reasons.push(`first reply in ${i.firstResponseSeconds}s`);
  }
  const text = i.replies.join(" ");
  const answeredQuestion = i.answered && ANSWERS.test(text);
  const deflected = DEFLECTS.test(text);
  if (i.humanReplies > 0) {
    score += 35;
    reasons.push("a person joined the conversation");
  }
  if (answeredQuestion) {
    score += 30;
    reasons.push("it answered the question");
  } else if (deflected) {
    score -= 15;
    reasons.push("it only promised a follow-up or asked for contact details");
  } else {
    reasons.push("it replied without answering the question");
  }
  if (i.contactRequired && !answeredQuestion) {
    score -= 10;
    reasons.push("contact details were demanded before any help");
  }
  score = Math.max(0, Math.min(100, score));
  const grade: ChatGrade = score >= 60 ? "GOOD" : "BAD";
  return { grade, score, reasons };
}

export const CHAT_GRADE_LABEL: Record<ChatGrade, string> = { GOOD: "Good chatbot", BAD: "Bad chatbot", NONE: "No chatbot" };
