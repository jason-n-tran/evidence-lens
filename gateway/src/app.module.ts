import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { GraphQLModule } from "@nestjs/graphql";
import { ApolloDriver, ApolloDriverConfig } from "@nestjs/apollo";
import { ThrottlerModule } from "@nestjs/throttler";
import { join } from "node:path";

import { CacheModule } from "./cache/cache.module.js";
import { SearchModule } from "./search/search.module.js";
import { DocumentModule } from "./document/document.module.js";
import { FacetsModule } from "./facets/facets.module.js";
import { TrialsModule } from "./trials/trials.module.js";
import { RecallsModule } from "./recalls/recalls.module.js";
import { LlmProxyModule } from "./llm-proxy/llm-proxy.module.js";
import { McpProxyModule } from "./mcp-proxy/mcp-proxy.module.js";
import { AdminModule } from "./admin/admin.module.js";
import { GatewayWebSocketModule } from "./ws/ws.module.js";
import { ExperimentsModule } from "./experiments/experiments.module.js";
import { ClicksModule } from "./internal/clicks.module.js";
import { ToolModule } from "./tool/tool.module.js";
import { HealthController } from "./health.controller.js";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    ThrottlerModule.forRoot([
      { name: "rest", ttl: 60_000, limit: 60 },
      { name: "llm",  ttl: 60_000, limit: 30 },
    ]),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      typePaths: [join(process.cwd(), "src/schema.graphql")],
      playground: true,
      introspection: true,
      path: "/graphql",
    }),
    CacheModule,
    SearchModule,
    ToolModule,
    DocumentModule,
    FacetsModule,
    TrialsModule,
    RecallsModule,
    LlmProxyModule,
    McpProxyModule,
    AdminModule,
    ExperimentsModule,
    ClicksModule,
    GatewayWebSocketModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
