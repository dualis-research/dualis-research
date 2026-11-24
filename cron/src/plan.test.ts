import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dispatchBody, dispatchFor, OWN_WORKFLOW, SCHEDULE } from "./plan.ts";

test("each slot starts collect.yml on main with its dimension, marked as a scheduled run", () => {
  assert.deepEqual(dispatchBody("0 2 * * *"), {
    ref: "main",
    inputs: { dimension: "all,daily-email", trigger: "schedule" },
  });
  assert.equal(Object.keys(SCHEDULE).length, 1);
});

test("Cloudflare's free plan allows 5 cron triggers", () => {
  assert.ok(Object.keys(SCHEDULE).length + Object.keys(OWN_WORKFLOW).length <= 5);
});

test("an unknown cron fails loud", () => {
  assert.throws(() => dispatchBody("0 3 * * *"), /Unknown cron/);
});

test("wrangler.jsonc declares exactly the crons the schedule knows", () => {
  const config = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const crons = JSON.parse(config.match(/"crons":\s*(\[[^\]]*\])/)![1]) as string[];
  assert.deepEqual([...crons].sort(), [...Object.keys(SCHEDULE), ...Object.keys(OWN_WORKFLOW)].sort());
});

test("the X slot starts x-publish.yml, the alert slot news-alert.yml, the daily slot collect.yml", () => {
  assert.deepEqual(dispatchFor("10 3-16 * * *"), { workflow: "x-publish.yml", body: { ref: "main" } });
  assert.deepEqual(dispatchFor("40 */6 * * *"), { workflow: "news-alert.yml", body: { ref: "main", inputs: { trigger: "schedule" } } });
  assert.equal(dispatchFor("0 2 * * *").workflow, "collect.yml");
  assert.throws(() => dispatchFor("0 3 * * *"), /Unknown cron/);
});
