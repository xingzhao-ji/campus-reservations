import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { idempotencyKey } from "../web/keys.js";

test("client key uses native randomUUID when available", () => {
  assert.equal(
    idempotencyKey({
      randomUUID: () => "native-key",
      getRandomValues: () => {
        throw new Error("Unexpected fallback");
      },
    }),
    "native-key",
  );
});
test("HTTP preview fallback formats a valid version-4 key without randomUUID", () => {
  assert.equal(
    idempotencyKey({ getRandomValues: (bytes) => bytes.fill(255) }),
    "ffffffff-ffff-4fff-bfff-ffffffffffff",
  );
});
test("HTTP preview fallback uses secure random bytes and generates distinct retry keys", () => {
  const source = {
    getRandomValues: (bytes: Uint8Array) => webcrypto.getRandomValues(bytes),
  };
  const keys = Array.from({ length: 1000 }, () => idempotencyKey(source));
  assert.equal(new Set(keys).size, 1000);
  assert(
    keys.every((key) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        key,
      ),
    ),
  );
});
