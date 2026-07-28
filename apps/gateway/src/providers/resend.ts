export interface ResendAdapterConfig {
  apiKey?: string;
  baseUrl: string;
  fromEmail: string;
}

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

/**
 * Hand-rolled against Resend's documented REST API (`POST /emails`) — no
 * vendor SDK, the same convention as every other external-provider adapter
 * in this codebase (OpenAI/Anthropic/Gemini/Ollama, Stripe). Same "no live
 * credentials in this environment" caveat: unit-tested against undici
 * MockAgent shaped to match Resend's documented API, not verified against a
 * live account.
 *
 * A missing API key fails the specific send it's needed for (a
 * `ProviderError`-style thrown error), never blocks the caller from
 * booting — same rule as every other optional provider credential.
 */
export class ResendAdapter {
  readonly name = "resend";

  constructor(private readonly config: ResendAdapterConfig) {}

  async sendEmail(input: SendEmailInput): Promise<void> {
    if (!this.config.apiKey) {
      throw new Error("Resend is not configured (missing RESEND_API_KEY)");
    }

    const res = await fetch(`${this.config.baseUrl}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.config.fromEmail,
        to: [input.to],
        subject: input.subject,
        html: input.html,
      }),
    });

    if (!res.ok) {
      throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
    }
  }
}
