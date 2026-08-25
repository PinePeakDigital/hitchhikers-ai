/**
 * Inference for the Guide, on Workers AI.
 *
 * Everything runs through the `AI` binding — no API keys, no vendor SDK, no separate
 * billing surface. Optionally routed through an AI Gateway (set `AI_GATEWAY_ID`) for
 * request logging, cost tracking, caching and retries.
 */

const TEXT_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const SAFETY_MODEL = "@cf/meta/llama-guard-3-8b";

// Flux accepts 1-8; 4 is the model default and the point of diminishing returns for
// the small thumbnails the Guide renders.
const IMAGE_STEPS = 4;

const IMAGE_TIMEOUT = 10000;
const TEXT_TIMEOUT = 20000;
const SAFETY_TIMEOUT = 10000;

/**
 * Bound an inference call in wall-clock time.
 *
 * An unbounded provider call on the request path is what took the Guide down once
 * already: a hung upstream never reaches a `catch`, so the request hangs until the
 * Worker itself is killed and the reader gets nothing. Losing the race doesn't cancel
 * the underlying request — the binding takes no abort signal — it just stops us
 * waiting on it.
 */
async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export const LIMIT_EXCEEDED_MESSAGE =
  "The Guide's computational circuits are currently overloaded with requests from various parts of the galaxy. Please try again tomorrow. DON'T PANIC - this is a temporary measure to prevent the heat death of the universe.";

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

interface DailyUsage {
  generations: number;
  imageGenerations: number;
  lastUpdated: string;
}

/**
 * Workers AI's free Neuron allocation (10,000/day) resets at 00:00 UTC. On the Free
 * plan further calls then hard-fail; on Workers Paid they overage-bill at
 * $0.011/1,000 Neurons instead — so this limiter exists to cap that spend, rather
 * than being the sole defence it had to be when inference was billed to an unbounded
 * external account. Counted in requests: the binding doesn't report token usage for
 * text generation, and `max_tokens` bounds the cost of any single call anyway.
 */
const MAX_GENERATIONS_PER_DAY = 300;
const MAX_IMAGES_PER_DAY = 50;

const KV_TTL_SECONDS = 86400;

export class RateLimitedAI {
  private readonly ai: Ai;
  private readonly usage: KVNamespace;
  private readonly gatewayId?: string;
  private cachedUsage: { date: string; data: DailyUsage } | null = null;

  constructor(ai: Ai, usage: KVNamespace, gatewayId?: string) {
    this.ai = ai;
    this.usage = usage;
    this.gatewayId = gatewayId;
  }

  /**
   * Per-call options. When an AI Gateway is configured, its built-in retries absorb
   * the transient upstream blips this code used to have to survive on its own.
   */
  private options() {
    if (!this.gatewayId) return undefined;

    return {
      gateway: {
        id: this.gatewayId,
        retries: { maxAttempts: 2 as const, retryDelayMs: 500, backoff: "exponential" as const },
      },
    };
  }

  private async getUsage(dateKey: string): Promise<DailyUsage> {
    if (this.cachedUsage?.date === dateKey) {
      return this.cachedUsage.data;
    }

    const stored = await this.usage.get<Partial<DailyUsage>>(dateKey, "json");
    // Tolerate the pre-migration shape (which counted tokens) by defaulting anything
    // missing to zero rather than trusting the stored keys.
    const data: DailyUsage = {
      generations: stored?.generations ?? 0,
      imageGenerations: stored?.imageGenerations ?? 0,
      lastUpdated: stored?.lastUpdated ?? new Date().toISOString(),
    };

    this.cachedUsage = { date: dateKey, data };
    return data;
  }

  private async recordUsage(
    dateKey: string,
    { generation = false, image = false }: { generation?: boolean; image?: boolean }
  ): Promise<void> {
    const current = await this.getUsage(dateKey);
    const updated: DailyUsage = {
      generations: current.generations + (generation ? 1 : 0),
      imageGenerations: current.imageGenerations + (image ? 1 : 0),
      lastUpdated: new Date().toISOString(),
    };

    await this.usage.put(dateKey, JSON.stringify(updated), {
      expirationTtl: KV_TTL_SECONDS,
    });
    this.cachedUsage = { date: dateKey, data: updated };
  }

  private static today() {
    return new Date().toISOString().split("T")[0];
  }

  async didExceedLimit() {
    const usage = await this.getUsage(RateLimitedAI.today());
    return usage.generations >= MAX_GENERATIONS_PER_DAY;
  }

  async didExceedImageLimit() {
    const usage = await this.getUsage(RateLimitedAI.today());
    return usage.imageGenerations >= MAX_IMAGES_PER_DAY;
  }

  /**
   * Generate text. Returns `LIMIT_EXCEEDED_MESSAGE` when the daily budget is spent or
   * inference fails — callers detect that by identity to avoid persisting or caching a
   * transient failure as though it were content, so it must be returned verbatim.
   */
  async createText(
    messages: ChatMessage[],
    { maxTokens = 1024 }: { maxTokens?: number } = {}
  ): Promise<string> {
    const today = RateLimitedAI.today();

    if (await this.didExceedLimit()) {
      return LIMIT_EXCEEDED_MESSAGE;
    }

    try {
      const result = await withTimeout(
        this.ai.run(TEXT_MODEL, { messages, max_tokens: maxTokens }, this.options()),
        TEXT_TIMEOUT,
        "Text generation"
      );

      await this.recordUsage(today, { generation: true });

      const text = (result as { response?: string }).response?.trim();
      return text || LIMIT_EXCEEDED_MESSAGE;
    } catch (error) {
      console.error("Workers AI text generation failed:", error);
      return LIMIT_EXCEEDED_MESSAGE;
    }
  }

  /**
   * Generate an image, returning base64-encoded JPEG, or null if unavailable.
   *
   * Image failures are never fatal — the Guide renders fine without one — so this
   * swallows errors rather than surfacing the limit sentinel.
   */
  async createImage(prompt: string): Promise<string | null> {
    const today = RateLimitedAI.today();

    if (await this.didExceedImageLimit()) {
      console.log("Image limit exceeded");
      return null;
    }

    try {
      const result = await withTimeout(
        this.ai.run(IMAGE_MODEL, { prompt, steps: IMAGE_STEPS }, this.options()),
        IMAGE_TIMEOUT,
        "Image generation"
      );

      const image = (result as { image?: string }).image;
      if (!image) return null;

      await this.recordUsage(today, { image: true });
      return image;
    } catch (error) {
      console.error("Workers AI image generation failed:", error);
      return null;
    }
  }

  /**
   * Content moderation via Llama Guard, replacing OpenAI's moderations endpoint.
   *
   * Throws on failure rather than returning a verdict, so callers keep failing closed:
   * an unavailable safety check must never read as "safe".
   */
  async isSafe(input: string): Promise<boolean> {
    const result = await withTimeout(
      this.ai.run(
        SAFETY_MODEL,
        {
          messages: [{ role: "user" as const, content: input }],
          response_format: { type: "json_object" },
        },
        this.options()
      ),
      SAFETY_TIMEOUT,
      "Moderation"
    );

    const response = (result as { response?: string | { safe?: boolean } }).response;

    // The model returns a parsed object when asked for JSON, but falls back to a raw
    // Llama Guard string ("safe" / "unsafe\nS1,S3") — handle both rather than assume.
    if (typeof response === "object" && response !== null) {
      if (typeof response.safe === "boolean") return response.safe;
      throw new Error("Moderation returned an unrecognised verdict");
    }

    if (typeof response === "string") {
      const verdict = response.trim().toLowerCase();
      if (verdict.startsWith("unsafe")) return false;
      if (verdict.startsWith("safe")) return true;
    }

    throw new Error("Moderation returned an unrecognised verdict");
  }
}
