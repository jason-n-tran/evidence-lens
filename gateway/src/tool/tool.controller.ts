import { Body, Controller, NotFoundException, Param, Post } from "@nestjs/common";
import { Throttle } from "@nestjs/throttler";
import { ToolService } from "./tool.service.js";

@Controller("api/tool")
export class ToolController {
  constructor(private readonly svc: ToolService) {}

  @Post(":name")
  @Throttle({ rest: { ttl: 60_000, limit: 30 } })
  async dispatch(
    @Param("name") name: string,
    @Body() body: Record<string, unknown>,
  ): Promise<unknown> {
    try {
      switch (name) {
        case "search_evidence":          return await this.svc.searchEvidence(body);
        case "get_paper":                return await this.svc.getPaper(body);
        case "get_trial":                return await this.svc.getTrial(body);
        case "get_trials_by_condition":  return await this.svc.getTrialsByCondition(body);
        case "get_recent_recalls":       return await this.svc.getRecentRecalls(body);
        case "get_author_payments":      return await this.svc.getAuthorPayments(body);
        case "get_citation_neighborhood":return await this.svc.getCitationNeighborhood(body);
        case "evaluate_evidence_quality":return await this.svc.evaluateEvidenceQuality(body);
        default:
          throw new NotFoundException(`unknown tool: ${name}`);
      }
    } catch (e) {
      if (e instanceof NotFoundException) throw e;
      return { error: (e as Error).message };
    }
  }
}
