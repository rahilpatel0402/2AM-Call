// Arize AX tracing via OpenTelemetry + OpenInference. Must be imported before anything creates a Bedrock client.
// Setup follows the Arize "Amazon Bedrock tracing" TypeScript guide.
import "./env.js";
import { env } from "./env.js";
import { createRequire } from "node:module";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import { SEMRESATTRS_PROJECT_NAME } from "@arizeai/openinference-semantic-conventions";

// The instrumentor's ESM build currently fails to import (openinference#3393); load its CommonJS build.
const require = createRequire(import.meta.url);

export const tracingEnabled = Boolean(env("ARIZE_SPACE_ID") && env("ARIZE_API_KEY"));
const projectName = env("ARIZE_PROJECT_NAME") || "two-am-call";

export const provider = tracingEnabled
  ? new NodeTracerProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: projectName,
        [SEMRESATTRS_PROJECT_NAME]: projectName,
      }),
      spanProcessors: [
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            url: "https://otlp.arize.com/v1/traces",
            headers: { "arize-space-id": env("ARIZE_SPACE_ID"), "arize-api-key": env("ARIZE_API_KEY") },
          }),
        ),
      ],
    })
  : null;

if (provider) {
  provider.register();
  const { BedrockInstrumentation } = require("@arizeai/openinference-instrumentation-bedrock");
  registerInstrumentations({ instrumentations: [new BedrockInstrumentation()], tracerProvider: provider });
  console.log(`[arize] tracing to project "${projectName}"`);
} else {
  console.log("[arize] ARIZE_SPACE_ID / ARIZE_API_KEY not set, tracing off");
}

export async function flushTraces(): Promise<void> {
  await provider?.forceFlush();
}
