import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  AuthorityError,
  AuthorityStore,
  actionEnvelopeBytes,
  authorityStorageBindingMatches,
  observeAuthorityStorage,
  type AuthorityStorageFileSystem,
  type AuthorityStoragePhase,
  type SignedActionEnvelope,
} from "../server/routes/immune/state";

const DATABASE = "/data/immune/authority.sqlite";
const SOURCE = "a".repeat(40);
const DEPLOYMENT = "b".repeat(40);
const EPOCH = "c".repeat(32);
const NOW = new Date("2026-09-26T12:00:00.000Z");
const MOUNTS = "1 0 0:1 / / rw - overlay overlay rw\n2 1 8:1 / /data rw - ext4 /dev/sda rw\n";

function stat(ino: number, directory = false, dev = 8, symlink = false) {
  return { dev, ino, isDirectory: () => directory, isFile: () => !directory,
    isSymbolicLink: () => symlink };
}

function storageFixture() {
  const entries = new Map([
    ["/data", stat(1, true)], ["/data/immune", stat(2, true)],
    [DATABASE, stat(3)], [`${DATABASE}-wal`, stat(4)], [`${DATABASE}-shm`, stat(5)],
  ]);
  const accessed: string[] = [];
  const io: AuthorityStorageFileSystem = {
    readMountInfo: () => MOUNTS,
    lstat: (file) => {
      const value = entries.get(file);
      if (!value) throw Object.assign(new Error("absent"), { code: "ENOENT" });
      return value;
    },
    realpath: (file) => file,
    access: (file) => { accessed.push(file); },
  };
  return { io, entries, accessed };
}

test("authority storage observes existing DB/WAL/SHM metadata without opening any database descriptor", (t) => {
  const fixture = storageFixture();
  // A mandatory static proof on every platform, plus live traps: metadata
  // observation may never bypass SQLite's ownership of its file descriptors.
  const source = fs.readFileSync(new URL("../server/routes/immune/state.ts", import.meta.url), "utf8");
  const observerSource = source.slice(source.indexOf("const AUTHORITY_STORAGE_FILESYSTEM"), source.indexOf("export class AuthorityStore"));
  assert.doesNotMatch(observerSource, /\b(?:openSync|closeSync|fsyncSync|fstatSync|openExisting)\b/u);
  const forbidden = () => { throw new Error("observer attempted a database descriptor operation"); };
  for (const method of ["openSync", "closeSync", "fsyncSync", "fstatSync"] as const) {
    t.mock.method(fs, method, forbidden);
  }
  Object.assign(fixture.io, { openExisting: forbidden, fstat: forbidden, fsync: forbidden, close: forbidden });
  const result = observeAuthorityStorage(DATABASE, { fileSystem: fixture.io });
  assert.equal(result.available, true);
  assert.equal(result.mountId, "2");
  assert.deepEqual(result.database, { dev: 8, ino: 3 });
  assert.deepEqual(fixture.accessed, ["/data", "/data/immune", DATABASE, `${DATABASE}-wal`, `${DATABASE}-shm`, DATABASE, `${DATABASE}-wal`, `${DATABASE}-shm`]);
  assert.equal(observeAuthorityStorage(DATABASE, { fileSystem: fixture.io, preopen: true }).available, true);
  assert.match(result.reason, /metadata/u);
  assert.match(result.reason, /restart proof.*separate/u);
});

test("bootstrap allows missing files only before open, never orphaned sidecars", () => {
  const fixture = storageFixture();
  for (const file of ["/data/immune", DATABASE, `${DATABASE}-wal`, `${DATABASE}-shm`]) fixture.entries.delete(file);
  assert.equal(observeAuthorityStorage(DATABASE, { fileSystem: fixture.io, preopen: true }).available, true);
  assert.equal(observeAuthorityStorage(DATABASE, { fileSystem: fixture.io }).available, false);
  fixture.entries.set("/data/immune", stat(2, true));
  fixture.entries.set(`${DATABASE}-wal`, stat(4));
  assert.equal(observeAuthorityStorage(DATABASE, { fileSystem: fixture.io, preopen: true }).available, false);
});

test("canonical exact path, mount, persistence, and complete observations fail closed", () => {
  for (const candidate of ["/tmp/authority.sqlite", "/data/immune/../authority.sqlite", "/data/immune/sub/a.sqlite", "/data/immune/a.db"]) {
    assert.equal(observeAuthorityStorage(candidate, { fileSystem: storageFixture().io }).available, false, candidate);
  }
  for (const mounts of [
    "", "invalid mount line", MOUNTS.split("\n")[0],
    MOUNTS.replace("/data rw", "/data ro"),
    MOUNTS.replace("ext4 /dev/sda rw", "ext4 /dev/sda ro"),
    ...["overlay", "tmpfs", "ramfs", "squashfs"].map((kind) => MOUNTS.replace("ext4", kind)),
    MOUNTS + "3 1 8:1 / /data rw - ext4 /dev/sda rw\n",
    MOUNTS + "2 1 8:1 / /elsewhere rw - ext4 /dev/sda rw\n",
    ...["/data/immune", DATABASE, `${DATABASE}-wal`, `${DATABASE}-shm`].map((target) =>
      MOUNTS + `3 2 8:2 / ${target} rw - ext4 /dev/sdb rw\n`),
  ]) {
    const fixture = storageFixture();
    fixture.io.readMountInfo = () => mounts;
    assert.equal(observeAuthorityStorage(DATABASE, { fileSystem: fixture.io }).available, false, mounts);
  }
});

test("all actual authority paths reject symlinks, escapes, wrong devices, and non-files", () => {
  for (const target of ["/data", "/data/immune", DATABASE, `${DATABASE}-wal`, `${DATABASE}-shm`]) {
    const fixture = storageFixture();
    const previous = fixture.entries.get(target)!;
    fixture.entries.set(target, stat(previous.ino, previous.isDirectory(), 8, true));
    assert.equal(observeAuthorityStorage(DATABASE, { fileSystem: fixture.io }).available, false, `symlink ${target}`);
    fixture.entries.set(target, previous);
    fixture.io.realpath = (file) => file === target ? "/outside" : file;
    assert.equal(observeAuthorityStorage(DATABASE, { fileSystem: fixture.io }).available, false, `escape ${target}`);
  }
  for (const target of ["/data/immune", DATABASE, `${DATABASE}-wal`, `${DATABASE}-shm`]) {
    const fixture = storageFixture();
    const previous = fixture.entries.get(target)!;
    fixture.entries.set(target, stat(previous.ino, previous.isDirectory(), 9));
    assert.equal(observeAuthorityStorage(DATABASE, { fileSystem: fixture.io }).available, false, `device ${target}`);
    fixture.entries.set(target, stat(previous.ino, !previous.isDirectory()));
    assert.equal(observeAuthorityStorage(DATABASE, { fileSystem: fixture.io }).available, false, `kind ${target}`);
  }
  for (const target of [DATABASE, `${DATABASE}-wal`, `${DATABASE}-shm`]) {
    const fixture = storageFixture();
    fixture.entries.delete(target);
    assert.equal(observeAuthorityStorage(DATABASE, { fileSystem: fixture.io }).available, false, `missing ${target}`);
  }
});

test("metadata identity, permissions, and mount races deny proof without descriptor operations", () => {
  for (const fault of ["replacement", "late-replacement", "access", "mount", "directory", "data"] as const) {
    const fixture = storageFixture();
    if (fault === "replacement") {
      fixture.io.access = (file) => { if (file === DATABASE) fixture.entries.set(file, stat(999)); };
    }
    if (fault === "late-replacement") {
      fixture.io.access = (file) => { if (file === `${DATABASE}-shm`) fixture.entries.set(DATABASE, stat(999)); };
    }
    if (fault === "access") fixture.io.access = () => { throw new Error("EACCES"); };
    if (fault === "mount") {
      let reads = 0;
      fixture.io.readMountInfo = () => ++reads === 1 ? MOUNTS : MOUNTS.replace("2 1", "3 1");
    }
    if (fault === "directory" || fault === "data") {
      const target = fault === "directory" ? "/data/immune" : "/data";
      fixture.io.access = (file) => { if (file === DATABASE) fixture.entries.set(target, stat(999, true)); };
    }
    assert.equal(observeAuthorityStorage(DATABASE, { fileSystem: fixture.io }).available, false, fault);
  }
  const fresh = storageFixture();
  fresh.entries.delete(`${DATABASE}-shm`);
  let observations = 0;
  const originalStat = fresh.io.lstat;
  fresh.io.lstat = (file) => {
    if (file === `${DATABASE}-shm` && ++observations === 2) fresh.entries.set(file, stat(5));
    return originalStat(file);
  };
  assert.equal(observeAuthorityStorage(DATABASE, { fileSystem: fresh.io, preopen: true }).available, false);
});

test("lifetime bindings reject every replaced inode or mount without adopting the replacement", () => {
  const previous = observeAuthorityStorage(DATABASE, { fileSystem: storageFixture().io });
  assert.equal(authorityStorageBindingMatches(previous, structuredClone(previous)), true);
  for (const field of ["data", "directory", "database", "wal", "shm"] as const) {
    const current = structuredClone(previous);
    current[field]!.ino += 1;
    assert.equal(authorityStorageBindingMatches(previous, current), false, field);
    current[field] = null;
    assert.equal(authorityStorageBindingMatches(previous, current), false, `missing ${field}`);
  }
  assert.equal(authorityStorageBindingMatches(previous, { ...previous, mountId: "99" }), false);
  assert.equal(authorityStorageBindingMatches(previous, { ...previous, available: false }), false);
  const fresh = { ...previous, directory: null, database: null, wal: null, shm: null };
  assert.equal(authorityStorageBindingMatches(fresh, previous), false);
  assert.equal(authorityStorageBindingMatches(fresh, previous, true), true);
  assert.equal(authorityStorageBindingMatches(fresh, fresh, true), false);
});

function storeFixture(t: test.TestContext, check: (phase: AuthorityStoragePhase) => boolean) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "immune-storage-lifecycle-"));
  const databasePath = path.join(directory, "immune", "authority.sqlite");
  const keys = crypto.generateKeyPairSync("ed25519");
  const publicKey = (keys.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  const options = { databasePath, publicKeyB64: publicKey.toString("base64"),
    sourceRevision: SOURCE, deploymentRevision: DEPLOYMENT, trustEpoch: EPOCH, now: () => NOW };
  const stores: AuthorityStore[] = [];
  t.after(() => { for (const store of stores) store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const create = () => {
    const store = new AuthorityStore({ ...options, requireDurableStorage: true,
      durabilityCheck: (_file, phase) => check(phase) });
    stores.push(store);
    return store;
  };
  const sign = (store: AuthorityStore, requestId: string): SignedActionEnvelope => {
    const head = store.snapshot();
    const receipts = store.receipts();
    const unsigned: Omit<SignedActionEnvelope, "signature"> = {
      version: "immune.action.v2", requestId, trustEpoch: EPOCH, authorityInstanceId: head.authority.instanceId!,
      expectedRevision: receipts.length, expectedReceiptHash: receipts.at(-1)?.receiptHash ?? "GENESIS",
      issuedAt: NOW.toISOString(), expiresAt: new Date(NOW.getTime() + 30_000).toISOString(),
      validUntil: new Date(NOW.getTime() + 60_000).toISOString(), actor: "operator:storage-test",
      keyId: crypto.createHash("sha256").update(publicKey).digest("hex").slice(0, 16),
      audience: "hf-space:SZLHOLDINGS/immune", source: { repository: "szl-holdings/immune", revision: SOURCE },
      deployment: { space: "SZLHOLDINGS/immune", revision: DEPLOYMENT }, action: { type: "SET_MODE", mode: "PASS" },
    };
    return { ...unsigned, signature: crypto.sign(null, actionEnvelopeBytes(unsigned), keys.privateKey).toString("base64") };
  };
  return { create, sign, options, databasePath, stores };
}

test("preopen failure creates no database; opened failure closes initialization handle", (t) => {
  const before = storeFixture(t, (phase) => phase !== "preopen");
  assert.throws(before.create, (error: unknown) => error instanceof AuthorityError && error.code === "DURABLE_AUTHORITY_STORAGE_UNAVAILABLE");
  assert.equal(fs.existsSync(before.databasePath), false);
  const originalClose = DatabaseSync.prototype.close;
  let closes = 0;
  t.mock.method(DatabaseSync.prototype, "close", function (this: DatabaseSync) { closes += 1; return originalClose.call(this); });
  const after = storeFixture(t, (phase) => phase !== "opened");
  assert.throws(after.create, (error: unknown) => error instanceof AuthorityError && error.code === "DURABLE_AUTHORITY_STORAGE_UNAVAILABLE");
  assert.equal(closes, 1);
  const reopened = new AuthorityStore(after.options);
  after.stores.push(reopened);
  assert.equal(reopened.receipts().length, 0);
  assert.equal(reopened.snapshot().mode, "SENTRA_REJECT");
});

for (const phase of ["admission", "locked", "precommit"] as const) {
  test(`${phase} storage loss preserves existing receipts and rejects new authority`, (t) => {
    let fail = false;
    const fixture = storeFixture(t, (observed) => !(fail && observed === phase));
    const store = fixture.create();
    store.apply(fixture.sign(store, "storage-first-0001"));
    const before = store.receipts();
    const next = fixture.sign(store, "storage-next-0002");
    fail = true;
    assert.throws(() => store.apply(next), (error: unknown) => error instanceof AuthorityError && error.code === "DURABLE_AUTHORITY_STORAGE_UNAVAILABLE");
    assert.deepEqual(store.receipts(), before);
    assert.equal(store.snapshot().evidenceState, "UNAVAILABLE");
    assert.equal(store.snapshot().authority.durability.verified, false);
    // Even a restored path cannot bless an old potentially detached SQLite handle.
    fail = false;
    assert.throws(() => store.apply(next), (error: unknown) => error instanceof AuthorityError && error.code === "DURABLE_AUTHORITY_STORAGE_UNAVAILABLE");
    store.close();
    const reopened = new AuthorityStore(fixture.options);
    fixture.stores.push(reopened);
    assert.deepEqual(reopened.receipts(), before);
  });
}

test("postcommit storage loss preserves uncertain committed receipt for reconciliation, never retry/reset", (t) => {
  let fail = false;
  const fixture = storeFixture(t, (phase) => !(fail && phase === "snapshot"));
  const store = fixture.create();
  const envelope = fixture.sign(store, "storage-postcommit-0001");
  fail = true;
  assert.throws(() => store.apply(envelope), (error: unknown) => error instanceof AuthorityError && error.code === "POSTCONDITION_FAILED" && /may already be committed/.test(error.message));
  const receipts = store.receipts();
  assert.equal(receipts.length, 1);
  assert.equal(store.receipt(envelope.requestId, receipts[0].envelopeDigest)?.receiptHash, receipts[0].receiptHash);
  assert.equal(store.snapshot().evidenceState, "UNAVAILABLE");
  store.close();
  const reopened = new AuthorityStore(fixture.options);
  fixture.stores.push(reopened);
  assert.deepEqual(reopened.receipts(), receipts);
  assert.throws(() => reopened.apply(envelope), (error: unknown) => error instanceof AuthorityError && error.code === "ALREADY_APPLIED");
});

for (const pragma of ["journal_mode", "synchronous"] as const) {
  test(`SQLite-owned ${pragma} must verify at initialization and remain verified for admission`, (t) => {
    const originalPrepare = DatabaseSync.prototype.prepare;
    let invalid = true;
    t.mock.method(DatabaseSync.prototype, "prepare", function (this: DatabaseSync, sql: string) {
      if (invalid && sql === `PRAGMA ${pragma}`) {
        return { get: () => ({ [pragma]: pragma === "journal_mode" ? "delete" : 1 }) } as ReturnType<typeof originalPrepare>;
      }
      return originalPrepare.call(this, sql);
    });
    const fixture = storeFixture(t, () => true);
    assert.throws(fixture.create, (error: unknown) => error instanceof AuthorityError && error.code === "DURABLE_AUTHORITY_STORAGE_UNAVAILABLE");
    invalid = false;
    const store = fixture.create();
    store.apply(fixture.sign(store, `storage-pragma-${pragma}-first`));
    const before = store.receipts();
    const next = fixture.sign(store, `storage-pragma-${pragma}-next`);
    invalid = true;
    assert.throws(() => store.apply(next), (error: unknown) => error instanceof AuthorityError && error.code === "DURABLE_AUTHORITY_STORAGE_UNAVAILABLE");
    assert.deepEqual(store.receipts(), before);
    assert.equal(store.snapshot().authority.durability.verified, false);
    invalid = false;
    assert.throws(() => store.apply(next), (error: unknown) => error instanceof AuthorityError && error.code === "DURABLE_AUTHORITY_STORAGE_UNAVAILABLE");
  });
}

function competingWriter(databasePath: string): boolean {
  // A distinct OS process is essential: same-process SQLite connections share
  // lock bookkeeping and would hide raw-close POSIX lock loss.
  const program = `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1]);
    try {
      db.exec("PRAGMA busy_timeout=0");
      try {
        db.exec("BEGIN IMMEDIATE");
        db.exec("ROLLBACK");
        process.stdout.write(JSON.stringify({ acquired: true }));
      } catch (error) {
        if (!Number.isInteger(error.errcode) || (error.errcode & 255) !== 5) throw error;
        process.stdout.write(JSON.stringify({ acquired: false }));
      }
    } finally { db.close(); }
  `;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", program, databasePath], {
    encoding: "utf8", timeout: 10_000, maxBuffer: 16_384, windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot ?? "", NODE_NO_WARNINGS: "1" },
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  const observation = JSON.parse(child.stdout) as { acquired: boolean };
  assert.equal(typeof observation.acquired, "boolean");
  return observation.acquired;
}

test("metadata observation preserves real separate-process WAL exclusion through commit and rollback", (t) => {
  const lockedPhases: AuthorityStoragePhase[] = [];
  const deviceIds = new Map<bigint, number>();
  const inodeIds = new Map<string, number>();
  const fixture = storeFixture(t, (phase) => {
    // Virtualize only the production /data namespace and mount declaration.
    // All file identities/access checks and both SQLite processes are real.
    const root = path.dirname(path.dirname(fixture.databasePath));
    const localPath = (file: string) => file === "/data" ? root
      : file === "/data/immune" ? path.dirname(fixture.databasePath)
      : file.replace(DATABASE, fixture.databasePath);
    const io: AuthorityStorageFileSystem = {
      readMountInfo: () => MOUNTS,
      lstat: (file) => {
        // NTFS file IDs may exceed Number.MAX_SAFE_INTEGER. Map exact bigint
        // identities bijectively for this cross-platform namespace adapter;
        // never round away an actual file replacement or device change.
        const observed = fs.lstatSync(localPath(file), { bigint: true });
        if (!deviceIds.has(observed.dev)) deviceIds.set(observed.dev, deviceIds.size + 1);
        const inode = `${observed.dev}:${observed.ino}`;
        if (!inodeIds.has(inode)) inodeIds.set(inode, inodeIds.size + 1);
        return { dev: deviceIds.get(observed.dev)!, ino: inodeIds.get(inode)!,
          isDirectory: () => observed.isDirectory(), isFile: () => observed.isFile(),
          isSymbolicLink: () => observed.isSymbolicLink() };
      },
      realpath: (file) => fs.realpathSync(localPath(file)) === fs.realpathSync(root) + localPath(file).slice(root.length)
        ? file : "/noncanonical",
      access: (file) => fs.accessSync(localPath(file), fs.constants.R_OK | fs.constants.W_OK),
    };
    const observed = observeAuthorityStorage(DATABASE, { fileSystem: io, preopen: phase === "preopen" });
    if (!observed.available) t.diagnostic(`${phase}: ${observed.reason}`);
    assert.equal(observed.available, true, `${phase}: ${observed.reason}`);
    if (phase === "locked" || phase === "precommit") {
      assert.equal(competingWriter(fixture.databasePath), false, `${phase} must not release SQLite's write lock`);
      lockedPhases.push(phase);
    }
    return observed.available;
  });
  const store = fixture.create();
  assert.equal(competingWriter(fixture.databasePath), true, "contender can acquire outside a transaction");
  const envelope = fixture.sign(store, "storage-exclusion-0001");
  store.apply(envelope);
  assert.deepEqual(lockedPhases, ["locked", "precommit"]);
  assert.equal(competingWriter(fixture.databasePath), true, "COMMIT releases the actual write lock");
  const before = store.receipts();
  assert.throws(() => store.apply(envelope), (error: unknown) => error instanceof AuthorityError && error.code === "ALREADY_APPLIED");
  assert.deepEqual(lockedPhases, ["locked", "precommit", "locked"]);
  assert.deepEqual(store.receipts(), before);
  assert.equal(competingWriter(fixture.databasePath), true, "ROLLBACK releases the actual write lock");
  assert.equal(store.snapshot().evidenceState, "VERIFIED");
});

test("production and canonical Space reject test overrides and cannot opt out of durability", (t) => {
  const fixture = storeFixture(t, () => true);
  const oldNodeEnv = process.env.NODE_ENV;
  const oldSpace = process.env.SPACE_ID;
  try {
    for (const [nodeEnv, space] of [["production", ""], ["test", "SZLHOLDINGS/immune"]]) {
      process.env.NODE_ENV = nodeEnv;
      process.env.SPACE_ID = space;
      assert.throws(fixture.create, (error: unknown) => error instanceof AuthorityError && error.code === "INVALID_CONFIGURATION");
      assert.throws(() => new AuthorityStore({ ...fixture.options, requireDurableStorage: false }),
        (error: unknown) => error instanceof AuthorityError && error.code === "DURABLE_AUTHORITY_STORAGE_UNAVAILABLE");
      assert.equal(fs.existsSync(fixture.databasePath), false);
    }
  } finally {
    if (oldNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNodeEnv;
    if (oldSpace === undefined) delete process.env.SPACE_ID; else process.env.SPACE_ID = oldSpace;
  }
});
