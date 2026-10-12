import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { AIProvider, AIRequest } from "./provider";

export class AnthropicProvider implements AIProvider {
  readonly name = "anthropic";
  private client: Anthropic | undefined;

  constructor(readonly model: string) {}

  async generate<T>(req: AIRequest<T>): Promise<{ data: T; inputTokens: number; outputTokens: number }> {
    // Resolves ANTHROPIC_API_KEY (or another configured credential) from the server environment.
    this.client ??= new Anthropic();
    const response = await this.client.messages.parse({
      model: this.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages: [{ role: "user", content: JSON.stringify(req.input) }],
      output_config: { effort: req.effort, format: zodOutputFormat(req.schema) },
    });
    if (response.stop_reason === "refusal") throw new Error("The model declined this request.");
    if (response.stop_reason === "max_tokens") throw new Error("The model ran out of output tokens before finishing; raise maxAITokensPerJob.");
    if (response.parsed_output === null || response.parsed_output === undefined) throw new Error("The model returned output that did not match the expected schema.");
    return {
      data: response.parsed_output as T,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }
}
