import { Module } from "@nestjs/common";
import { SearchModule } from "../search/search.module.js";
import { ToolController } from "./tool.controller.js";
import { ToolService } from "./tool.service.js";

@Module({
  imports: [SearchModule],
  controllers: [ToolController],
  providers: [ToolService],
})
export class ToolModule {}
