import assert from "node:assert/strict";
import test from "node:test";
import {
  ledgerDurability,
  type LedgerDurabilityFileSystem,
} from "../server/routes/immune/ledger";

const DATA_DIR = "/data/immune/evidence";
const LEDGER = `${DATA_DIR}/ledger.jsonl`;
const EVIDENCE = `${DATA_DIR}/huklla_evidence.jsonl`;
const MOUNT_INFO = [
  "10 1 0:1 / / rw,relatime - overlay overlay rw",
  "20 10 8:1 / /data rw,relatime - ext4 /dev/example-volume rw",
].join("\n");

type Stat = ReturnType<LedgerDurabilityFileSystem["lstat"]>;
type TraceEntry = [operation: string, target: string | number];

function stat(kind: "directory" | "file" | "symlink", ino: number, dev = 7): Stat {
  return {
    dev,
    ino,
    isDirectory: () => kind === "directory",
    isFile: () => kind === "file",
    isSymbolicLink: () => kind === "symlink",
  };
}

function fixture() {
  const stats = new Map<string, Stat>([
    ["/data", stat("directory", 1)],
    ["/data/immune", stat("directory", 2)],
    [DATA_DIR, stat("directory", 3)],
    [LEDGER, stat("file", 4)],
    [EVIDENCE, stat("file", 5)],
  ]);
  const opened = new Map<number, string>();
  const trace: TraceEntry[] = [];
  let nextDescriptor = 100;
  const lookup = (file: string): Stat => {
    const value = stats.get(file);
    if (!value) throw new Error("fixture file absent");
    return value;
  };
  const io: LedgerDurabilityFileSystem = {
    readMountInfo: () => {
      trace.push(["readMountInfo", "/proc/self/mountinfo"]);
      return MOUNT_INFO;
    },
    lstat: (file) => {
      trace.push(["lstat", file]);
      return lookup(file);
    },
    realpath: (file) => {
      trace.push(["realpath", file]);
      lookup(file);
      return file;
    },
    access: (file) => {
      trace.push(["access", file]);
      lookup(file);
    },
    openExisting: (file) => {
      trace.push(["openExisting", file]);
      assert.ok(file === LEDGER || file === EVIDENCE);
      lookup(file);
      const descriptor = nextDescriptor++;
      opened.set(descriptor, file);
      return descriptor;
    },
    fstat: (descriptor) => {
      trace.push(["fstat", descriptor]);
      const file = opened.get(descriptor);
      assert.ok(file, "only an already-open descriptor can be observed");
      return lookup(file);
    },
    fsync: (descriptor) => {
      trace.push(["fsync", descriptor]);
      assert.ok(opened.has(descriptor));
    },
    close: (descriptor) => {
      trace.push(["close", descriptor]);
      assert.ok(opened.delete(descriptor), "a descriptor is closed exactly once");
    },
  };
  return { io, stats, opened, trace };
}

test("ledger durability observes existing exact-volume files without creating or appending evidence", () => {
  const subject = fixture();
  const before = [...subject.stats.entries()];
  const result = ledgerDurability({ dataDir: DATA_DIR, fileSystem: subject.io });
  assert.equal(result.required, true);
  assert.equal(result.verified, true);
  assert.equal(result.path, DATA_DIR);
  assert.equal(result.mount_path, "/data");
  assert.match(result.reason, /restart proof remains separate/);
  assert.deepEqual([...subject.stats.entries()], before);
  assert.equal(subject.opened.size, 0);
  assert.deepEqual(subject.trace.filter(([operation]) =>
    ["openExisting", "fstat", "fsync", "close"].includes(operation)), [
    ["openExisting", LEDGER], ["fstat", 100], ["fsync", 100], ["close", 100],
    ["openExisting", EVIDENCE], ["fstat", 101], ["fsync", 101], ["close", 101],
  ]);
});

test("ledger durability rejects noncanonical locations before filesystem observation", () => {
  for (const dataDir of [
    "/app/data/immune", "/data/immune", `${DATA_DIR}/`,
    "/data/immune/../immune/evidence", "C:\\data\\immune\\evidence", "",
  ]) {
    const subject = fixture();
    const result = ledgerDurability({ dataDir, fileSystem: subject.io });
    assert.equal(result.verified, false, dataDir);
    assert.equal(result.path, dataDir);
    assert.deepEqual(subject.trace, [], dataDir);
  }
});

test("ledger durability rejects missing, ambiguous, malformed, ephemeral, or read-only mounts", () => {
  const cases: Array<[string, string]> = [
    ["missing /data", "10 1 0:1 / / rw - overlay overlay rw"],
    ["duplicate /data", `${MOUNT_INFO}\n21 10 8:2 / /data rw - ext4 /dev/other rw`],
    ["malformed mount separator", "not-a-mount-observation"],
    ["malformed mount fields", "20 10 - ext4 /dev/example-volume rw"],
    ["read-only mount", MOUNT_INFO.replace("/data rw,relatime", "/data ro,relatime")],
    ["read-only superblock", MOUNT_INFO.replace("/dev/example-volume rw", "/dev/example-volume ro")],
    ...["overlay", "tmpfs", "ramfs", "squashfs"].map((kind): [string, string] => [
      `ephemeral ${kind}`, MOUNT_INFO.replace("- ext4 /dev/example-volume", `- ${kind} example-volume`),
    ]),
    ...["/data/immune", DATA_DIR, LEDGER, EVIDENCE].map((target): [string, string] => [
      `nested mount at ${target}`,
      `${MOUNT_INFO}\n30 20 8:2 / ${target} rw - ext4 /dev/nested rw`,
    ]),
  ];
  for (const [name, mountInfo] of cases) {
    const subject = fixture();
    subject.io.readMountInfo = () => mountInfo;
    const result = ledgerDurability({ dataDir: DATA_DIR, fileSystem: subject.io });
    assert.equal(result.verified, false, name);
    assert.equal(subject.trace.some(([operation]) => operation === "openExisting"), false, name);
    assert.equal(subject.opened.size, 0, name);
  }
});

test("ledger durability rejects symlinks, incorrect kinds, device changes, and missing evidence", () => {
  const cases: Array<[string, (subject: ReturnType<typeof fixture>) => void]> = [];
  for (const target of ["/data", "/data/immune", DATA_DIR, LEDGER, EVIDENCE]) {
    cases.push([`symlink ${target}`, ({ stats }) => stats.set(target, stat("symlink", 9))]);
    cases.push([`realpath escape ${target}`, ({ io }) => {
      io.realpath = (file) => file === target ? "/elsewhere" : file;
    }]);
  }
  for (const target of ["/data/immune", DATA_DIR, LEDGER, EVIDENCE]) {
    cases.push([`device changed ${target}`, ({ stats }) => {
      stats.set(target, stat(target.endsWith(".jsonl") ? "file" : "directory", 9, 8));
    }]);
  }
  for (const target of [LEDGER, EVIDENCE]) {
    cases.push([`missing ${target}`, ({ stats }) => { stats.delete(target); }]);
    cases.push([`directory instead of file ${target}`, ({ stats }) => {
      stats.set(target, stat("directory", 9));
    }]);
  }
  cases.push(["file instead of directory", ({ stats }) => {
    stats.set(DATA_DIR, stat("file", 9));
  }]);
  for (const [name, mutate] of cases) {
    const subject = fixture();
    mutate(subject);
    const result = ledgerDurability({ dataDir: DATA_DIR, fileSystem: subject.io });
    assert.equal(result.verified, false, name);
    assert.equal(subject.opened.size, 0, name);
  }
});

test("ledger durability closes opened descriptors after observation races and fsync failures", () => {
  const cases: Array<[string, (subject: ReturnType<typeof fixture>) => void]> = [
    ["inode changed", ({ io }) => { io.fstat = () => stat("file", 999); }],
    ["device changed after open", ({ io }) => { io.fstat = () => stat("file", 4, 999); }],
    ["descriptor is no longer a regular file", ({ io }) => { io.fstat = () => stat("directory", 4); }],
    ["fstat failure", ({ io }) => { io.fstat = () => { throw new Error("fstat failed"); }; }],
    ["fsync failure", ({ io }) => { io.fsync = () => { throw new Error("fsync failed"); }; }],
    ["second-file fsync failure", ({ io }) => {
      const original = io.fsync;
      io.fsync = (descriptor) => {
        if (descriptor === 101) throw new Error("second fsync failed");
        original(descriptor);
      };
    }],
  ];
  for (const [name, mutate] of cases) {
    const subject = fixture();
    mutate(subject);
    assert.equal(ledgerDurability({ dataDir: DATA_DIR, fileSystem: subject.io }).verified, false, name);
    assert.equal(subject.opened.size, 0, name);
    const opens = subject.trace.filter(([operation]) => operation === "openExisting");
    const closes = subject.trace.filter(([operation]) => operation === "close");
    assert.equal(closes.length, opens.length, name);
  }
});

test("ledger durability fails closed on unavailable observation without opening or seeding files", () => {
  for (const method of ["readMountInfo", "lstat", "realpath", "access", "openExisting"] as const) {
    const subject = fixture();
    subject.io[method] = () => { throw new Error(`${method} unavailable`); };
    const before = [...subject.stats.entries()];
    const result = ledgerDurability({ dataDir: DATA_DIR, fileSystem: subject.io });
    assert.equal(result.verified, false, method);
    assert.equal(subject.opened.size, 0, method);
    assert.deepEqual([...subject.stats.entries()], before, method);
  }
});

test("ledger durability rejects malformed filesystem observation results without seeding evidence", () => {
  const cases: Array<[string, (subject: ReturnType<typeof fixture>) => void]> = [
    ["missing mount text", ({ io }) => { io.readMountInfo = () => undefined as unknown as string; }],
    ["array mount text", ({ io }) => { io.readMountInfo = () => [] as unknown as string; }],
    ["missing stat", ({ io }) => { io.lstat = () => undefined as unknown as Stat; }],
    ["missing stat methods", ({ io }) => { io.lstat = () => ({ dev: 7, ino: 1 }) as Stat; }],
    ["missing realpath", ({ io }) => { io.realpath = () => undefined as unknown as string; }],
    ["missing opened stat", ({ io }) => { io.fstat = () => undefined as unknown as Stat; }],
  ];
  for (const [name, mutate] of cases) {
    const subject = fixture();
    const before = [...subject.stats.entries()];
    mutate(subject);
    const result = ledgerDurability({ dataDir: DATA_DIR, fileSystem: subject.io });
    assert.equal(result.required, true, name);
    assert.equal(result.verified, false, name);
    assert.equal(result.path, DATA_DIR, name);
    assert.equal(result.mount_path, "/data", name);
    assert.equal(subject.opened.size, 0, name);
    assert.deepEqual([...subject.stats.entries()], before, name);
  }
});

test("ledger durability cannot report verified after close reports an observation failure", () => {
  const subject = fixture();
  const originalClose = subject.io.close;
  subject.io.close = (descriptor) => {
    originalClose(descriptor);
    throw new Error("descriptor close reported failure");
  };
  const result = ledgerDurability({ dataDir: DATA_DIR, fileSystem: subject.io });
  assert.equal(result.verified, false);
  assert.equal(subject.opened.size, 0);
  assert.deepEqual(subject.trace.filter(([operation]) => operation === "openExisting"), [
    ["openExisting", LEDGER],
  ]);
});
