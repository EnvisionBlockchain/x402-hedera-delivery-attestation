/**
 * Reading `.env` back from disk.
 *
 * `npm start` provisions in a child process, which writes `.env`, and then has
 * to name the topic that child created. `dotenv` runs once, when config.js is
 * first imported, which on a first run is before that file exists. Reading the
 * value through `process.env` therefore threw *after* bootstrap and the demo
 * had both succeeded: a zero-value crash at the very end of the one command a
 * newcomer runs. Under `--reprovision` it was quieter and worse, reporting the
 * previous run's topic as though it were the new one.
 *
 * These tests pin the property that fixes both: the value comes from the file,
 * not from the environment this process started with.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isProvisioned, readEnvFile, updateEnvFile } from "../src/envfile.js";

let dir: string;
let envPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "envfile-test-"));
  envPath = join(dir, ".env");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("readEnvFile", () => {
  it("reads a value a different process just wrote, with process.env unset", () => {
    delete process.env.ATTESTATION_TOPIC_ID;
    writeFileSync(envPath, "ATTESTATION_TOPIC_ID=0.0.4242\n", "utf8");
    expect(readEnvFile(envPath).ATTESTATION_TOPIC_ID).toBe("0.0.4242");
    expect(process.env.ATTESTATION_TOPIC_ID).toBeUndefined();
  });

  // The --reprovision case: the stale value is the one already in the
  // environment, so anything reading process.env silently reports the old topic.
  it("prefers the file over a stale value in process.env", () => {
    process.env.ATTESTATION_TOPIC_ID = "0.0.1111";
    try {
      writeFileSync(envPath, "ATTESTATION_TOPIC_ID=0.0.2222\n", "utf8");
      expect(readEnvFile(envPath).ATTESTATION_TOPIC_ID).toBe("0.0.2222");
    } finally {
      delete process.env.ATTESTATION_TOPIC_ID;
    }
  });

  it("returns an empty record when the file does not exist", () => {
    expect(readEnvFile(join(dir, "absent"))).toEqual({});
  });

  it("round-trips through updateEnvFile", () => {
    updateEnvFile({ ATTESTATION_TOPIC_ID: "0.0.7", SELLER_DID: "did:hedera:testnet:x_0.0.8" }, envPath);
    const read = readEnvFile(envPath);
    expect(read.ATTESTATION_TOPIC_ID).toBe("0.0.7");
    expect(read.SELLER_DID).toBe("did:hedera:testnet:x_0.0.8");
  });

  it("does not report an unprovisioned file as provisioned", () => {
    writeFileSync(envPath, "BUYER_ACCOUNT_ID=0.0.1\n", "utf8");
    expect(isProvisioned(envPath)).toBe(false);
  });
});
