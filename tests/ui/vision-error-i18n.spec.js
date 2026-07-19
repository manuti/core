const { test, expect } = require("@playwright/test");
const { waitForStatusApplied } = require("./helpers");

// LiteRT (via inferno) rejects images with "Vision input is not supported…",
// whereas llama.cpp says "image input is not supported". Both must be caught
// so the user sees the localized text-only notice, not the raw English error.
test("LiteRT vision-not-supported error surfaces the localized notice", async ({ page }) => {
  await page.goto("/");
  await waitForStatusApplied(page);
  const result = await page.evaluate(async () => {
    const mod = await import("/app/chat/assets/chat-engine.js");
    return mod.formatChatFailureMessage(
      400,
      { error: { message: "Vision input is not supported by this model/runtime configuration" } },
      { hasImageRequest: true },
    );
  });
  expect(result).not.toContain("Vision input is not supported"); // not the raw backend text
  expect(result).not.toContain("Request failed");                // not the generic fallback
  expect(result.length).toBeGreaterThan(0);
});

test("llama.cpp image-not-supported error still surfaces the localized notice", async ({ page }) => {
  await page.goto("/");
  await waitForStatusApplied(page);
  const result = await page.evaluate(async () => {
    const mod = await import("/app/chat/assets/chat-engine.js");
    return mod.formatChatFailureMessage(
      400,
      { error: { message: "image input is not supported by this model" } },
      { hasImageRequest: true },
    );
  });
  expect(result).not.toContain("Request failed");
  expect(result.length).toBeGreaterThan(0);
});

test("backend error code (invalid_json) is localized via errcode.*", async ({ page }) => {
  await page.goto("/");
  await waitForStatusApplied(page);
  const result = await page.evaluate(async () => {
    const mod = await import("/app/chat/assets/chat-engine.js");
    return mod.formatChatFailureMessage(400, { detail: "invalid_json" }, {});
  });
  expect(result).not.toContain("invalid_json");   // raw code not shown
  expect(result).toContain("400");                // generic request-failed path
});
