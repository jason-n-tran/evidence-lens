import { Args, Query, Resolver } from "@nestjs/graphql";
import { SearchService } from "./search.service.js";

@Resolver("Search")
export class SearchResolver {
  constructor(private readonly svc: SearchService) {}

  @Query("search")
  search(
    @Args("query") q: string,
    @Args("filters", { nullable: true }) filters?: any,
    @Args("topK", { nullable: true }) topK?: number,
    @Args("variant", { nullable: true }) variant?: string,
    @Args("sessionId", { nullable: true }) sessionId?: string,
  ) {
    return this.svc.search(q, filters, topK, variant, sessionId);
  }
}
