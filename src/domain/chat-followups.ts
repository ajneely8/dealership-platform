/**
 * The only follow-ups Charlie may say in a chat, and the rule for choosing one. Every line is
 * an early-stage shopper question: nothing is promised, negotiated or invented.
 */
export const APPROVED_FOLLOWUPS = {
  whichVehicle: "I'm looking at your used inventory online. Can someone send me more information about what you have available?",
  moreInfo: "Great, can someone send me more information about it?",
  generic: "Can someone send me more information about your current inventory?",
} as const;

export type FollowUp = { kind: "send"; text: string; why: string } | { kind: "wait"; why: string } | { kind: "stop"; why: string };

const CONNECTING = /\b(one moment|just a moment|connect(ing)? you|transferring|hold on|please wait|someone will be (right )?with you|be with you shortly)\b/i;
const ASKS_CONTACT = /\b(name|e-?mail|phone|number)\b[^.?!]*\?/i;
const ASKS_VEHICLE = /\b(which|what) (vehicle|car|model|one)\b|\bstock (number|#)|\bvin\b|looking for\b|interested in\b|in mind\b/i;
const CONFIRMS = /\b(available|in stock|still have|still here|yes|absolutely|sure)\b/i;

/** Decide what to do after the dealership's latest chat line. */
export function pickFollowUp(lastReply: string, sentSoFar: number, maxMessages: number): FollowUp {
  if (sentSoFar >= maxMessages) return { kind: "stop", why: `message limit (${maxMessages}) reached` };
  if (CONNECTING.test(lastReply)) return { kind: "wait", why: "the chat is connecting a person" };
  if (ASKS_CONTACT.test(lastReply)) return { kind: "wait", why: "it asked for contact details; the contact gate handles that" };
  if (ASKS_VEHICLE.test(lastReply)) return { kind: "send", text: APPROVED_FOLLOWUPS.whichVehicle, why: "it asked which vehicle" };
  if (CONFIRMS.test(lastReply)) return { kind: "send", text: APPROVED_FOLLOWUPS.moreInfo, why: "it confirmed availability" };
  return { kind: "send", text: APPROVED_FOLLOWUPS.generic, why: "a general reply" };
}
