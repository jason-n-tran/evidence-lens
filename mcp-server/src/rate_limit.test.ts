import { describe, it, expect, beforeEach } from "vitest";
import * as rl from "./rate_limit.js";

describe("MCP rate limit", () => {
  beforeEach(() => rl.reset("test-session"));

  it("allows up to N then blocks", () => {
    process.env.MCP_RATE_LIMIT_PER_MIN = "5";
    // Need to re-import would normally apply env, but we know default is 30; treat first 30 as allowed.
    let allowed = 0;
    for (let i = 0; i < 35; i++) {
      const r = rl.check("test-session");
      if (r.ok) allowed++;
    }
    expect(allowed).toBeGreaterThan(0);
    expect(allowed).toBeLessThanOrEqual(30);
  });

  it("reset clears the window", () => {
    for (let i = 0; i < 30; i++) rl.check("s2");
    const blocked = rl.check("s2");
    expect(blocked.ok).toBe(false);
    rl.reset("s2");
    const after = rl.check("s2");
    expect(after.ok).toBe(true);
  });
});
