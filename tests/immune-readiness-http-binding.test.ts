import assert from "node:assert/strict";
import test from "node:test";

import { assertReadinessHttpBinding } from "../frontend/src/lib/readiness-http-binding.ts";

test("readiness HTTP status is bound to the parsed ready claim", () => {
  assert.doesNotThrow(() => assertReadinessHttpBinding(200, { ready: true }));
  assert.doesNotThrow(() => assertReadinessHttpBinding(503, { ready: false }));

  assert.throws(
    () => assertReadinessHttpBinding(503, { ready: true }),
    /contradicts parsed ready claim/,
  );
  assert.throws(
    () => assertReadinessHttpBinding(200, { ready: false }),
    /contradicts parsed ready claim/,
  );
});
