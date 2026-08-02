import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const PAGES = ["/", "/search?q=heart+failure", "/recalls", "/about", "/licenses"];

for (const p of PAGES) {
  test(`a11y: ${p}`, async ({ page }) => {
    await page.goto(p);
    const results = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag22aa"])
      .analyze();
    expect(results.violations).toEqual([]);
  });
}
