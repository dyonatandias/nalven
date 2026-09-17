import assert from "node:assert/strict";
import test from "node:test";
import { safeInviteReturnTo } from "../components/auth/safe-return";

test("login returnTo permits only canonical invitation paths", () => {
  const token = "aB0_-".repeat(10);
  assert.equal(safeInviteReturnTo(`/convite/${token}`), `/convite/${token}`);
  for (const value of [undefined, null, [], 1, "/erp", "/admin", "https://example.invalid/convite/" + token,
    "//example.invalid/convite/" + token, "/convite/../../admin", `/convite/${token}/../admin`,
    `/convite/${token}?returnTo=https://example.invalid`, `/convite/${token}#fragment`,
    `/convite/${token}\\evil`, `/convite/${token}%2Fextra`, "/convite/" + "a".repeat(39), "/convite/" + "a".repeat(101),
  ]) assert.equal(safeInviteReturnTo(value), undefined, String(value));
});
