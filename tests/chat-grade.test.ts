import { describe, expect, it } from "vitest";
import { gradeChatbot } from "@/domain/chat-grade";

const base = { chatPresent: true, launcherFound: true, boxFound: true, humanReplies: 0, answered: true, contactRequired: false, firstResponseSeconds: 5 };

describe("chatbot grade", () => {
  it("is NONE without a chat or without a launcher", () => {
    expect(gradeChatbot({ ...base, chatPresent: false, replies: [] }).grade).toBe("NONE");
    expect(gradeChatbot({ ...base, launcherFound: false, replies: [] }).grade).toBe("NONE");
  });
  it("is BAD when broken, silent, or only collecting contact details", () => {
    expect(gradeChatbot({ ...base, boxFound: false, replies: [] }).grade).toBe("BAD");
    expect(gradeChatbot({ ...base, replies: [] }).grade).toBe("BAD");
    const deflect = gradeChatbot({ ...base, answered: false, contactRequired: true, replies: ["Thanks! Someone will be in touch shortly. What's the best phone number?"] });
    expect(deflect.grade).toBe("BAD");
    expect(deflect.reasons.join(" ")).toMatch(/follow-up|contact details/);
  });
  it("is GOOD when it answers or a person joins quickly", () => {
    const answered = gradeChatbot({ ...base, replies: ["Yes, that vehicle is still available at our store."] });
    expect(answered.grade).toBe("GOOD");
    expect(answered.score).toBeGreaterThanOrEqual(60);
    const human = gradeChatbot({ ...base, answered: false, humanReplies: 1, replies: ["Hi this is Maria, let me check on that for you."] });
    expect(human.grade).toBe("GOOD");
  });
});
