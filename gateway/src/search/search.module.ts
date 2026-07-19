import { Module } from "@nestjs/common";
import { SearchController } from "./search.controller.js";
import { SearchResolver } from "./search.resolver.js";
import { SearchService } from "./search.service.js";

@Module({
  controllers: [SearchController],
  providers: [SearchService, SearchResolver],
  exports: [SearchService],
})
export class SearchModule {}
