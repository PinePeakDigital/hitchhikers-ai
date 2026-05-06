import OpenAI from "openai";

interface DailyUsage {
  totalTokens: number;
  imageGenerations: number;
  lastUpdated: string;
}

export const LIMIT_EXCEEDED_MESSAGE =
  "The Guide's computational circuits are currently overloaded with requests from various parts of the galaxy. Please try again tomorrow. DON'T PANIC - this is a temporary measure to prevent the heat death of the universe.";

const IMAGE_TIMEOUT = 10000; // 10 seconds
export class RateLimitedOpenAI {
  private readonly openai: OpenAI;
  private readonly tokenUsage: KVNamespace;
  private readonly MAX_TOKENS_PER_DAY = 100000;
  private readonly MAX_IMAGES_PER_DAY = 10;
  private readonly KV_TTL_SECONDS = 86400; // 24 hours
  private cachedUsage: { date: string; data: DailyUsage } | null = null;

  constructor(apiKey: string, tokenUsage: KVNamespace) {
    this.openai = new OpenAI({ apiKey });
    this.tokenUsage = tokenUsage;
  }

  private async getUsage(dateKey: string): Promise<DailyUsage> {
    if (this.cachedUsage?.date === dateKey) {
      return this.cachedUsage.data;
    }
    const usage = await this.tokenUsage.get<DailyUsage>(dateKey, "json");
    const data: DailyUsage = usage || {
      totalTokens: 0,
      imageGenerations: 0,
      lastUpdated: new Date().toISOString(),
    };
    this.cachedUsage = { date: dateKey, data };
    return data;
  }

  private async updateUsage(
    dateKey: string,
    newTokens: number = 0,
    newImage: boolean = false
  ): Promise<void> {
    const current = await this.getUsage(dateKey);
    const updated: DailyUsage = {
      totalTokens: current.totalTokens + newTokens,
      imageGenerations: current.imageGenerations + (newImage ? 1 : 0),
      lastUpdated: new Date().toISOString(),
    };

    await this.tokenUsage.put(dateKey, JSON.stringify(updated), {
      expirationTtl: this.KV_TTL_SECONDS,
    });
    this.cachedUsage = { date: dateKey, data: updated };
  }

  private getLimitExceededResponse() {
    return {
      choices: [
        {
          message: {
            content: LIMIT_EXCEEDED_MESSAGE,
          },
        },
      ],
    };
  }

  async didExceedLimit() {
    const today = new Date().toISOString().split("T")[0];
    const usage = await this.getUsage(today);

    return usage.totalTokens >= this.MAX_TOKENS_PER_DAY;
  }

  async didExceedImageLimit() {
    console.log("Checking image limit");
    const today = new Date().toISOString().split("T")[0];
    const usage = await this.getUsage(today);

    return usage.imageGenerations >= this.MAX_IMAGES_PER_DAY;
  }

  async createChatCompletion(
    messages: any[],
    options: {
      model?: string;
    } = {}
  ) {
    const today = new Date().toISOString().split("T")[0];

    if (await this.didExceedLimit()) {
      return this.getLimitExceededResponse();
    }

    try {
      const completion = await this.openai.chat.completions.create({
        ...options,
        messages,
        model: options.model || "gpt-3.5-turbo",
      });

      // Update usage with actual tokens used
      if (completion.usage?.total_tokens) {
        await this.updateUsage(today, completion.usage.total_tokens);
      }

      return completion;
    } catch (error: any) {
      console.error("OpenAI API Error:", error);

      // Handle rate limits from OpenAI
      if (error?.status === 429) {
        return this.getLimitExceededResponse();
      }

      throw error;
    }
  }

  async createImage(prompt: string) {
    const today = new Date().toISOString().split("T")[0];

    if (await this.didExceedImageLimit()) {
      console.log("Image limit exceeded");
      return null;
    }

    console.log("Generating image");
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), IMAGE_TIMEOUT);

    try {
      const completion = await Promise.race<OpenAI.Images.ImagesResponse>([
        this.openai.images.generate({
          prompt,
          n: 1,
          size: "256x256",
          response_format: "b64_json",
        }),
        new Promise((_, reject) => {
          controller.signal.addEventListener("abort", () => {
            reject(
              new Error(`Image generation timed out after ${IMAGE_TIMEOUT}ms`)
            );
          });
        }),
      ]);

      // Update usage to count the image generation
      await this.updateUsage(today, 0, true);

      return completion.data?.[0].b64_json;
    } catch (error) {
      console.error("Image generation error:", error);
      return null;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  async isSafe(input: string) {
    const completion = await this.openai.moderations.create({
      input,
    });

    return !completion.results[0].flagged;
  }
}
