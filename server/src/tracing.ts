// Manual spans for the pipeline. One call = one Arize session (session.id = callId).
import { context, trace, SpanStatusCode, type Attributes } from "@opentelemetry/api";
import { setSession } from "@arizeai/openinference-core";

const tracer = trace.getTracer("two-am-call");

type Kind = "CHAIN" | "TOOL" | "EVALUATOR" | "GUARDRAIL";

// Runs fn inside a span; attributes returned by fn are added to the span when it ends.
export async function span<T>(name: string, kind: Kind, attrs: Attributes, fn: () => Promise<T> | T, after?: (r: T) => Attributes): Promise<T> {
  return tracer.startActiveSpan(name, { attributes: { "openinference.span.kind": kind, ...attrs } }, async (s) => {
    try {
      const result = await fn();
      if (after) s.setAttributes(after(result));
      return result;
    } catch (err) {
      s.recordException(err as Error);
      s.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
      throw err;
    } finally {
      s.end();
    }
  });
}

// Everything inside fn (manual spans and the Bedrock auto-instrumented spans) carries session.id.
export function inSession<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  return context.with(setSession(context.active(), { sessionId }), fn);
}
