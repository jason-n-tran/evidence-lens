import { Module, Logger, Inject } from "@nestjs/common";
import {
  ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect,
  SubscribeMessage, WebSocketGateway, WebSocketServer,
} from "@nestjs/websockets";
import type { WebSocket, Server } from "ws";
import { connect as natsConnect, NatsConnection, Subscription } from "nats";
import { SearchModule } from "../search/search.module.js";
import { SearchService } from "../search/search.service.js";

interface Frame { type: string; id: string; [k: string]: any }

const MAX_CONNS_PER_IP = parseInt(process.env.GATEWAY_WS_MAX_CONNECTIONS_PER_IP ?? "10", 10);
const MEILI_URL = process.env.MEILI_URL ?? "http://meilisearch:7700";
const MEILI_KEY = process.env.MEILI_KEY ?? "";
const NATS_URL = process.env.NATS_URL ?? "nats://nats:4222";

@WebSocketGateway({ path: "/ws" })
class GatewayWebSocket implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly logger = new Logger(GatewayWebSocket.name);
  @WebSocketServer() server!: Server;

  /** IP -> active connection count (for per-IP cap). */
  private readonly connsByIP = new Map<string, number>();
  /** WebSocket -> active NATS subscriptions for cleanup on disconnect. */
  private readonly subsByClient = new WeakMap<WebSocket, Subscription[]>();
  private nc: NatsConnection | null = null;

  constructor(@Inject(SearchService) private readonly searchSvc: SearchService) {}

  async onModuleInit(): Promise<void> {
    try {
      this.nc = await natsConnect({ servers: NATS_URL });
      this.logger.log(`nats connected: ${NATS_URL}`);
    } catch (e) {
      this.logger.warn(`nats connect failed (recall fanout disabled): ${(e as Error).message}`);
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.nc) await this.nc.close();
  }

  handleConnection(client: WebSocket, msg?: any) {
    const ip = String(msg?.headers?.["x-forwarded-for"] ?? msg?.socket?.remoteAddress ?? "unknown").split(",")[0].trim();
    const cur = this.connsByIP.get(ip) ?? 0;
    if (cur >= MAX_CONNS_PER_IP) {
      client.close(1013, "rate limited"); // Try Again Later
      return;
    }
    this.connsByIP.set(ip, cur + 1);
    (client as any).__ip = ip;
    this.logger.log(`ws.connect ip=${ip}`);
    client.on("error", (err: Error) => this.logger.error("ws.error", err.message));
  }

  handleDisconnect(client: WebSocket) {
    const ip = (client as any).__ip ?? "unknown";
    const cur = this.connsByIP.get(ip) ?? 1;
    if (cur <= 1) this.connsByIP.delete(ip);
    else this.connsByIP.set(ip, cur - 1);
    const subs = this.subsByClient.get(client);
    if (subs) for (const s of subs) s.unsubscribe();
    this.logger.log("ws.disconnect");
  }

  @SubscribeMessage("ping")
  ping(@MessageBody() data: Frame) {
    return { type: "pong", id: data.id };
  }

  @SubscribeMessage("search")
  async search(@MessageBody() data: Frame, @ConnectedSocket() client: WebSocket) {
    try {
      await this.searchSvc.streamFromScorer(
        data["query"],
        data["filters"],
        data["topK"] ?? 50,
        (wave, isFinal, results, elapsedMs) => {
          client.send(JSON.stringify({
            type: isFinal ? "search.final" : "search.partial",
            id: data.id, wave, isFinal, elapsedMs,
            totalEstimated: results.length, results,
          }));
        },
      );
    } catch (e) {
      client.send(JSON.stringify({
        type: "error", id: data.id, code: "internal_error",
        message: `scorer upstream error: ${(e as Error).message}`,
      }));
    }
  }

  @SubscribeMessage("getDoc")
  async getDoc(@MessageBody() data: Frame, @ConnectedSocket() client: WebSocket) {
    const id = data["documentId"];
    if (!id) {
      client.send(JSON.stringify({
        type: "error", id: data.id, code: "bad_request", message: "documentId required",
      }));
      return;
    }
    try {
      const r = await fetch(`${MEILI_URL}/indexes/documents/documents/${encodeURIComponent(id)}`, {
        headers: MEILI_KEY ? { authorization: `Bearer ${MEILI_KEY}` } : {},
      });
      if (!r.ok) {
        client.send(JSON.stringify({
          type: "error", id: data.id, code: "not_found",
          message: `document ${id} not found`,
        }));
        return;
      }
      const doc = await r.json();
      client.send(JSON.stringify({ type: "getDoc.result", id: data.id, document: doc }));
    } catch (e) {
      client.send(JSON.stringify({
        type: "error", id: data.id, code: "internal_error", message: (e as Error).message,
      }));
    }
  }

  @SubscribeMessage("subscribe")
  async subscribe(@MessageBody() data: Frame, @ConnectedSocket() client: WebSocket) {
    if (data["topic"] !== "recalls") {
      client.send(JSON.stringify({ type: "error", id: data.id, code: "unknown_topic", message: data["topic"] }));
      return;
    }
    if (!this.nc) {
      client.send(JSON.stringify({ type: "error", id: data.id, code: "internal_error", message: "nats unavailable" }));
      return;
    }
    const sub = this.nc.subscribe("recall-fanout");
    const subs = this.subsByClient.get(client) ?? [];
    subs.push(sub);
    this.subsByClient.set(client, subs);
    client.send(JSON.stringify({ type: "subscribed", id: data.id, topic: "recalls" }));

    (async () => {
      for await (const msg of sub) {
        try {
          const event = JSON.parse(new TextDecoder().decode(msg.data));
          const filt = data["filters"] ?? {};
          if (filt.drugClass && event.drug_class !== filt.drugClass) continue;
          if (filt.productName && event.product_name !== filt.productName) continue;
          client.send(JSON.stringify({ type: "recall.fanout", id: data.id, event }));
        } catch {
          /* malformed; skip */
        }
      }
    })();
  }

  @SubscribeMessage("unsubscribe")
  async unsubscribe(@MessageBody() data: Frame, @ConnectedSocket() client: WebSocket) {
    const subs = this.subsByClient.get(client);
    if (subs) {
      for (const s of subs) s.unsubscribe();
      this.subsByClient.set(client, []);
    }
    client.send(JSON.stringify({ type: "unsubscribed", id: data.id }));
  }
}

@Module({ imports: [SearchModule], providers: [GatewayWebSocket] })
export class GatewayWebSocketModule {}
