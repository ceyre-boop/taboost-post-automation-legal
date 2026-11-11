import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevice, getDevice, deleteDevice, loadDevices, profileOf } from "./devices.ts";

const dir = () => mkdtempSync(join(tmpdir(), "poster-dev-"));

test("create → get round trip, own profile and port", () => {
  const d = dir();
  const a = createDevice("Skyler", d);
  const b = createDevice("Colin", d);
  assert.equal(getDevice(a.id, d)?.name, "Skyler");
  assert.notEqual(a.cdpPort, b.cdpPort);
  assert.notEqual(a.profileDir, b.profileDir);
  assert.equal(a.cdpPort, 9230);
  assert.deepEqual(profileOf(a), { dir: a.profileDir, port: a.cdpPort });
});

test("unknown or malformed ids resolve to null", () => {
  const d = dir();
  assert.equal(getDevice("nope", d), null);
  assert.equal(getDevice("../../etc/pas", d), null);
  assert.equal(getDevice(null, d), null);
});

test("delete frees the port for reuse; names are sanitised", () => {
  const d = dir();
  const a = createDevice("<script>x", d);
  assert.equal(a.name, "scriptx");
  assert.ok(deleteDevice(a.id, d));
  assert.equal(Object.keys(loadDevices(d)).length, 0);
  assert.equal(createDevice("again", d).cdpPort, 9230);
});
