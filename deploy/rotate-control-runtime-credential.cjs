#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS maintenance helper, without a loader or project dependencies. */
// Root-reviewed, one-shot rotation. Invoke under the production maintenance flock.
"use strict";
const fs = require("node:fs");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
if (process.getuid() !== 0 || process.argv.length !== 2) process.exit(1);
const files = ["/etc/nalven/app.env", "/etc/nalven/tenant-provisioner.env"];
const records = files.map(path => {
  const stat = fs.lstatSync(path);
  if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o007)) throw new Error("Unsafe configuration permissions");
  const text = fs.readFileSync(path, "utf8");
  const matches = [...text.matchAll(/^CONTROL_DATABASE_URL=(.+)$/gm)];
  if (matches.length !== 1) throw new Error("Ambiguous control configuration");
  const url = new URL(matches[0][1]);
  if (url.username !== "nalven_app" || url.hostname !== "127.0.0.1" || url.port !== "5432" || url.pathname !== "/nalven") throw new Error("Unexpected database identity");
  return { path, stat, text, url, original: matches[0][1] };
});
if (records[0].original !== records[1].original) throw new Error("Consumers disagree; manual review required");
const oldPassword = decodeURIComponent(records[0].url.password);
const password = crypto.randomBytes(48).toString("hex");
function command(file, args, options = {}) {
  const result = spawnSync(file, args, { stdio: ["pipe", "pipe", "pipe"], timeout: 60000, ...options });
  if (result.status !== 0) throw new Error("Privileged operation failed; secret output suppressed");
}
function setPassword(value) {
  // Only a SCRAM verifier, not the plaintext password, reaches SQL or SQL logs.
  const salt = crypto.randomBytes(16);
  const salted = crypto.pbkdf2Sync(value, salt, 4096, 32, "sha256");
  const client = crypto.createHmac("sha256", salted).update("Client Key").digest();
  const stored = crypto.createHash("sha256").update(client).digest("base64");
  const server = crypto.createHmac("sha256", salted).update("Server Key").digest("base64");
  const verifier = `SCRAM-SHA-256$4096:${salt.toString("base64")}$${stored}:${server}`;
  command("/usr/sbin/runuser", ["-u", "postgres", "--", "/usr/bin/psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-d", "nalven"], { input: `ALTER ROLE nalven_app PASSWORD '${verifier}';\n` });
}
function replace(record, text) {
  const temporary = `${record.path}.rotation-${process.pid}`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fchownSync(fd, record.stat.uid, record.stat.gid);
    fs.fchmodSync(fd, record.stat.mode & 0o777);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, record.path);
}
let changed = false;
try {
  setPassword(password);
  changed = true;
  for (const record of records) {
    record.url.password = password;
    replace(record, record.text.replace(`CONTROL_DATABASE_URL=${record.original}`, `CONTROL_DATABASE_URL=${record.url.href}`));
  }
  command("/usr/bin/psql", ["-X", "-w", "-h", "127.0.0.1", "-U", "nalven_app", "-d", "nalven", "-Atqc", "SELECT 1"], { env: { PATH: "/usr/bin:/bin", PGPASSWORD: password } });
  command("/usr/bin/systemctl", ["restart", "nalven.service"]);
  console.log("Runtime control credential rotated; both consumers updated; database login verified; application restarted.");
} catch {
  if (changed) {
    try {
      setPassword(oldPassword);
      for (const record of records) replace(record, record.text);
      command("/usr/bin/systemctl", ["restart", "nalven.service"]);
      console.error("Rotation failed; previous configuration restored. Rotation remains required.");
    } catch { console.error("Rotation failed and rollback incomplete. Immediate operator intervention required."); }
  } else console.error("Rotation refused before configuration changes.");
  process.exitCode = 1;
}
