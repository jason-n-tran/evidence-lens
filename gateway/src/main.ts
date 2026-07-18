import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { WsAdapter } from "@nestjs/platform-ws";
import { AppModule } from "./app.module.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  app.useWebSocketAdapter(new WsAdapter(app));
  app.enableShutdownHooks();
  const port = parseInt(process.env.GATEWAY_PORT ?? "8080", 10);
  await app.listen(port, "0.0.0.0");
  console.log(JSON.stringify({ event: "gateway.listening", port }));
}
bootstrap();
