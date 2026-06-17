import { AppConfig, CreateIntentRequest, GatewayBalanceResponse, GatewayPrepareResponse, IntentResponse, QuoteResponse } from "./types.js";

export class ArcOsClient {
  constructor(private readonly baseUrl = "http://localhost:8787") {}

  async getConfig(): Promise<AppConfig> {
    const res = await fetch(`${this.baseUrl}/config`);
    if (!res.ok) throw new Error(`getConfig failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async createIntent(input: CreateIntentRequest): Promise<IntentResponse> {
    const res = await fetch(`${this.baseUrl}/intents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    if (!res.ok) throw new Error(`createIntent failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async quote(input: CreateIntentRequest): Promise<QuoteResponse> {
    const res = await fetch(`${this.baseUrl}/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, quoteOnly: true })
    });
    if (!res.ok) throw new Error(`quote failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async getIntent(id: string): Promise<IntentResponse> {
    const res = await fetch(`${this.baseUrl}/intents/${id}`);
    if (!res.ok) throw new Error(`getIntent failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async prepareGateway(input: CreateIntentRequest): Promise<GatewayPrepareResponse> {
    const res = await fetch(`${this.baseUrl}/gateway/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, preferredRoute: "GATEWAY" })
    });
    if (!res.ok) throw new Error(`prepareGateway failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async getGatewayBalance(owner: string): Promise<GatewayBalanceResponse> {
    const res = await fetch(`${this.baseUrl}/gateway/balances/${owner}`);
    if (!res.ok) throw new Error(`getGatewayBalance failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async analyze(input: CreateIntentRequest): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/agents/analyze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input)
    });
    if (!res.ok) throw new Error(`analyze failed: ${res.status} ${await res.text()}`);
    return res.json();
  }
}
