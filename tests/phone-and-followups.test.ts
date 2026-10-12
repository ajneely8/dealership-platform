import { describe, expect, it } from "vitest";
import { APPROVED_FOLLOWUPS, pickFollowUp } from "@/domain/chat-followups";
import { classifyPhoneAnswer } from "@/domain/phone-answer";

describe("what answered the phone", () => {
  it("recognises an AI receptionist by what it says", () => {
    const v = classifyPhoneAnswer({ callStatus: "completed", answeredBy: "human", transcript: "Thanks for calling. I'm an AI assistant and I can help you book an appointment.", durationSeconds: 30 });
    expect(v.status).toBe("AI_RECEPTIONIST");
    expect(v.reason).toMatch(/ai/i);
  });
  it("recognises a phone menu, voicemail and a person", () => {
    expect(classifyPhoneAnswer({ callStatus: "completed", answeredBy: "machine_start", transcript: "For sales press one, for service press two.", durationSeconds: 20 }).status).toBe("IVR_MENU");
    expect(classifyPhoneAnswer({ callStatus: "completed", answeredBy: "machine_end_beep", transcript: "We are currently closed. Please leave a message after the tone.", durationSeconds: 25 }).status).toBe("VOICEMAIL");
    expect(classifyPhoneAnswer({ callStatus: "completed", answeredBy: "human", transcript: "Thank you for calling, this is Maria, how can I help?", durationSeconds: 18 }).status).toBe("HUMAN");
  });
  it("falls back to the line's own detection and reports no answer honestly", () => {
    expect(classifyPhoneAnswer({ callStatus: "completed", answeredBy: "human", transcript: null, durationSeconds: 12 })).toMatchObject({ status: "HUMAN", confidence: "LOW" });
    expect(classifyPhoneAnswer({ callStatus: "no-answer", answeredBy: null, transcript: null, durationSeconds: null }).status).toBe("NO_ANSWER");
    expect(classifyPhoneAnswer({ callStatus: "completed", answeredBy: "unknown", transcript: "", durationSeconds: 5 }).status).toBe("UNKNOWN");
  });
});

describe("chat follow-ups", () => {
  it("only ever sends approved lines and stops at the limit", () => {
    const r = pickFollowUp("Which vehicle are you interested in?", 1, 3);
    expect(r).toMatchObject({ kind: "send", text: APPROVED_FOLLOWUPS.whichVehicle });
    expect(pickFollowUp("Yes it's still available!", 1, 3)).toMatchObject({ kind: "send", text: APPROVED_FOLLOWUPS.moreInfo });
    expect(pickFollowUp("Thanks for reaching out.", 2, 3)).toMatchObject({ kind: "send", text: APPROVED_FOLLOWUPS.generic });
    expect(pickFollowUp("Thanks for reaching out.", 3, 3).kind).toBe("stop");
  });
  it("waits instead of talking over a connecting message or a contact gate", () => {
    expect(pickFollowUp("One moment while I connect you with a member of our team.", 1, 3).kind).toBe("wait");
    expect(pickFollowUp("What's the best phone number to reach you?", 1, 3).kind).toBe("wait");
  });
});
