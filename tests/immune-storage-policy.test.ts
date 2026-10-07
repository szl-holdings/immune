import assert from "node:assert/strict";
import test from "node:test";
import { isDeclaredLocalFilesystemCandidate } from "../server/routes/immune/storage-policy";

test("filesystem candidate policy accepts exactly the declared strings without qualification claims", () => {
  for (const value of ["ext4", "xfs", "btrfs"]) {
    assert.equal(isDeclaredLocalFilesystemCandidate(value), true);
  }
});

test("filesystem policy rejects network, object, ephemeral and unknown types without coercion", () => {
  for (const value of [
    "nfs", "nfs4", "cifs", "smb3", "9p", "fuse", "fuseblk", "fuse.hf-mount", "fuse.s3fs",
    "overlay", "tmpfs", "ramfs", "squashfs", "unknownfs", "", "EXT4", "ext4-like",
    " ext4", "ext4 ", "ext4\n", "ext4\u0000", "XFS", "btrfs.extra",
    null, undefined, false, true, 0, 1, ["ext4"], { type: "ext4" }, new String("ext4"),
    { toString: () => "ext4" },
  ]) {
    assert.equal(isDeclaredLocalFilesystemCandidate(value), false, JSON.stringify(value));
  }
});
