// One entry point for Claude: callClaude(). Provider is chosen by LLM_PROVIDER (bedrock | anthropic).
// Bedrock uses the Converse API. Anthropic uses the official SDK. Callers never see the difference.
import "./env.js";
import { env } from "./env.js";
import Anthropic from "@anthropic-ai/sdk";
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message as BedrockMessage,
  type Tool as BedrockTool,
} from "@aws-sdk/client-bedrock-runtime";

export type ChatMessage = { role: "user" | "assistant"; content: string };

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>; // JSON Schema object
};

export type ClaudeResult = {
  text: string;
  toolCalls: { name: string; input: unknown }[];
  stopReason: string;
  provider: "bedrock" | "anthropic";
};

export type CallClaudeArgs = {
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens?: number;
  effort?: "low" | "medium" | "high"; // lower effort = faster; omit for the model default
};

export function llmProvider(): "bedrock" | "anthropic" {
  return env("LLM_PROVIDER") === "anthropic" ? "anthropic" : "bedrock";
}

export async function callClaude(args: CallClaudeArgs): Promise<ClaudeResult> {
  return llmProvider() === "anthropic" ? callAnthropic(args) : callBedrock(args);
}

// ---------- Anthropic API ----------

let anthropicClient: Anthropic | null = null;

async function callAnthropic({ system, messages, tools, maxTokens = 4096, effort }: CallClaudeArgs): Promise<ClaudeResult> {
  if (!env("ANTHROPIC_API_KEY")) throw new Error("ANTHROPIC_API_KEY is not set");
  anthropicClient ??= new Anthropic({ apiKey: env("ANTHROPIC_API_KEY") });

  const response = await anthropicClient.messages.create({
    model: env("ANTHROPIC_MODEL") || "claude-sonnet-5-5",
    max_tokens: maxTokens,
    ...(system ? { system } : {}),
    messages,
    ...(effort ? { output_config: { effort } } : {}),
    ...(tools?.length
      ? { tools: tools.map((t) => ({ ...t, input_schema: t.input_schema as Anthropic.Tool.InputSchema })) }
      : {}),
  });

  let text = "";
  const toolCalls: ClaudeResult["toolCalls"] = [];
  for (const block of response.content) {
    if (block.type === "text") text += block.text;
    else if (block.type === "tool_use") toolCalls.push({ name: block.name, input: block.input });
  }
  return { text, toolCalls, stopReason: response.stop_reason ?? "unknown", provider: "anthropic" };
}

// ---------- AWS Bedrock (Converse API) ----------

let bedrockClient: BedrockRuntimeClient | null = null;

async function callBedrock({ system, messages, tools, maxTokens = 4096, effort }: CallClaudeArgs): Promise<ClaudeResult> {
  const modelId = env("BEDROCK_MODEL_ID");
  if (!modelId) throw new Error("BEDROCK_MODEL_ID is not set");
  if (!env("AWS_ACCESS_KEY_ID")) throw new Error("AWS_ACCESS_KEY_ID is not set");

  bedrockClient ??= new BedrockRuntimeClient({
    region: env("AWS_REGION") || "us-east-1",
    credentials: {
      accessKeyId: env("AWS_ACCESS_KEY_ID"),
      secretAccessKey: env("AWS_SECRET_ACCESS_KEY"),
      ...(env("AWS_SESSION_TOKEN") ? { sessionToken: env("AWS_SESSION_TOKEN") } : {}),
    },
  });

  const bedrockMessages: BedrockMessage[] = messages.map((m) => ({ role: m.role, content: [{ text: m.content }] }));
  const bedrockTools: BedrockTool[] | undefined = tools?.map((t) => ({
    toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.input_schema as never } },
  }));

  const response = await bedrockClient.send(
    new ConverseCommand({
      modelId,
      messages: bedrockMessages,
      ...(system ? { system: [{ text: system }] } : {}),
      inferenceConfig: { maxTokens },
      ...(effort ? { additionalModelRequestFields: { output_config: { effort } } } : {}),
      ...(bedrockTools?.length ? { toolConfig: { tools: bedrockTools } } : {}),
    }),
  );

  let text = "";
  const toolCalls: ClaudeResult["toolCalls"] = [];
  for (const block of response.output?.message?.content ?? []) {
    if (block.text) text += block.text;
    if (block.toolUse) toolCalls.push({ name: block.toolUse.name ?? "", input: block.toolUse.input });
  }
  return { text, toolCalls, stopReason: response.stopReason ?? "unknown", provider: "bedrock" };
}
