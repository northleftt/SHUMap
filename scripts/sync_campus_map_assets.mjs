#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(root, "data/campus-map-assets.json");
const entries = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const upload = process.argv.slice(2);

if (upload.length > 1 || (upload.length === 1 && upload[0] !== "--upload-remote")) {
  throw new Error("Usage: node scripts/sync_campus_map_assets.mjs [--upload-remote]");
}

const seenKeys = new Set();
for (const entry of entries) {
  assertEntry(entry);
  if (seenKeys.has(entry.objectKey)) throw new Error(`Duplicate R2 object key: ${entry.objectKey}`);
  seenKeys.add(entry.objectKey);
  const source = path.join(root, entry.sourcePath);
  const bytes = fs.readFileSync(source);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== entry.byteSize) {
    throw new Error(`${entry.sourcePath} has ${bytes.byteLength} bytes; expected ${entry.byteSize}`);
  }
  if (digest !== entry.sha256) {
    throw new Error(`${entry.sourcePath} has SHA-256 ${digest}; expected ${entry.sha256}`);
  }
}

if (upload[0] === "--upload-remote") {
  for (const entry of entries) {
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "node_modules/wrangler/bin/wrangler.js"),
        "r2", "object", "put", `shumap-assets/${entry.objectKey}`,
        "--file", path.join(root, entry.sourcePath),
        "--content-type", "image/svg+xml",
        "--cache-control", "private, no-store",
        "--remote",
        "--force",
      ],
      { cwd: root, stdio: "inherit" },
    );
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Wrangler failed for ${entry.objectKey} with exit code ${result.status}`);
  }
}

console.log(`${entries.length} canonical campus SVG assets verified${upload[0] === "--upload-remote" ? " and uploaded" : " locally"}.`);

function assertEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Campus map asset entries must be objects");
  const keys = Object.keys(entry).sort();
  const expected = ["byteSize", "campusId", "key", "objectKey", "sha256", "sourcePath"].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    throw new Error("Campus map asset entries must contain exactly campusId, key, sourcePath, objectKey, byteSize, and sha256");
  }
  for (const field of ["campusId", "key", "sourcePath", "objectKey"]) {
    if (typeof entry[field] !== "string" || !entry[field]) throw new Error(`${field} must be a non-empty string`);
  }
  if (!Number.isSafeInteger(entry.byteSize) || entry.byteSize <= 0) throw new Error("byteSize must be a positive integer");
  if (!/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error("sha256 must be a lowercase hexadecimal SHA-256 digest");
}
