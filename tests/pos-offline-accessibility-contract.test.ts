import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { projectOfflineQueueIssue } from "../lib/erp/pos-offline-client";

const workspace = readFileSync("components/erp/pdv-offline-workspace.tsx", "utf8");
const css = readFileSync("components/erp/pdv-offline-workspace.module.css", "utf8");
const client = readFileSync("lib/erp/pos-offline-client.ts", "utf8");

test("offline destructive purge uses the accessible modal contract", () => {
  assert.doesNotMatch(workspace, /\b(?:window\.)?confirm\s*\(/);
  assert.match(workspace, /<PdvAccessibleModal/);
  assert.match(workspace, /returnFocusRef=\{purgeTriggerRef\}/);
  assert.match(workspace, /busy=\{busy\}/);
  assert.match(workspace, /onClick=\{\(\) => setConfirmPurge\(true\)\}/);
});

test("offline controls expose visible focus and minimum touch targets", () => {
  assert.match(css, /:focus-visible\{outline:3px solid/);
  assert.match(css, /\.card input,\.card select,\.card button\{min-height:44px/);
  assert.match(css, /\.actions button\{min-height:44px\}/);
  assert.doesNotMatch(css, /#72878f/);
});

test("offline queue projects server conflicts through an allowlisted reason code", () => {
  assert.match(client, /projectOfflineQueueIssue\(result\.conflict \?\? result\.response\)/);
  assert.match(client, /row\.error == null \? null : projectOfflineQueueIssue\(row\.error\)/);
  assert.match(client, /reasonCode: "draft_revision_conflict"/);
  assert.match(client, /reasonCode: "offline_sync_rejected"/);
  assert.doesNotMatch(workspace, /JSON\.stringify\(item\.error\)/);
  assert.match(workspace, /data-reason-code=\{item\.error\.reasonCode\}/);
  assert.deepEqual(projectOfflineQueueIssue({ code: "draft_revision_conflict", draftId: "sensitive" }), {
    reasonCode: "draft_revision_conflict",
    message: "O rascunho mudou no servidor e precisa de resolução assistida.",
  });
  assert.equal(projectOfflineQueueIssue({ code: "unexpected", payload: { customer: "secret" } }).reasonCode, "offline_sync_rejected");
});
