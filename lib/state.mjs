// The lease file: which project:worktree holds which ports on this machine.
//
// One JSON file, rewritten whole under an exclusive lock. Every command that
// changes it does read → decide → write inside `withLock`, so two sessions
// claiming at the same moment are serialised instead of racing onto one port —
// the race is the whole reason this exists.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Local ports come in blocks of BLOCK, one block per project, from 20000 up.
 *  The tailnet port is always the local port + TAILNET_OFFSET, so a lease is
 *  one number to remember: local 20114 is https://<host>:30114. */
export const LOCAL_FLOOR = 20000;
export const LOCAL_CEIL = 29999;
export const BLOCK = 100;
export const TAILNET_OFFSET = 10000;

export const home = () => process.env.TAILNET_PORTS_HOME ?? join(homedir(), ".config", "tailnet-ports");
const file = () => join(home(), "leases.json");

export function load() {
  let raw;
  try {
    raw = readFileSync(file(), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return { version: 1, blocks: {}, leases: {} };
    throw e;
  }
  const state = JSON.parse(raw);
  return { version: 1, blocks: {}, leases: {}, ...state };
}

export function save(state) {
  const tmp = `${file()}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file());
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** Run `fn` holding the lease-file lock. The lock is a file created with
 *  O_EXCL holding the owner's pid; a lock whose owner has died is taken over,
 *  which is the only way a crashed claim could otherwise wedge every host-wide
 *  claim forever. */
export async function withLock(fn) {
  mkdirSync(home(), { recursive: true });
  const lock = join(home(), "leases.lock");
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      writeSync(fd, `${process.pid}\n`);
      closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    let holder = NaN;
    try {
      holder = Number(readFileSync(lock, "utf8").trim());
    } catch {
      continue; // released between our open and our read
    }
    // An empty file is a holder between open and write — not stale.
    if (Number.isInteger(holder) && holder > 0 && !alive(holder)) {
      // Re-read immediately before unlinking so we only remove the dead
      // holder's lock, not a fresh one somebody took in the meantime.
      try {
        if (Number(readFileSync(lock, "utf8").trim()) === holder) unlinkSync(lock);
      } catch {}
      continue;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${lock} (held by pid ${holder})`);
    await sleep(20 + Math.random() * 40);
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {}
  }
}

/** The project's block base, allocating the lowest unused block on first use. */
export function blockFor(state, project) {
  if (state.blocks[project] !== undefined) return state.blocks[project];
  const used = new Set(Object.values(state.blocks));
  for (let base = LOCAL_FLOOR; base + BLOCK - 1 <= LOCAL_CEIL; base += BLOCK) {
    if (used.has(base)) continue;
    state.blocks[project] = base;
    return base;
  }
  throw new Error(`every block between ${LOCAL_FLOOR} and ${LOCAL_CEIL} is allocated`);
}

export const keyOf = (project, name) => `${project}:${name}`;
