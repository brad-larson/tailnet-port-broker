// Which project and worktree is this checkout?
//
// Derived from git so an agent can type `ports serve` with no arguments and get
// the same answer every time: the project is the main checkout's directory name,
// the worktree is the linked worktree's directory name, and the main checkout
// itself is `root`.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

export function slug(value, what) {
  const s = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!s) throw new Error(`${what} ${JSON.stringify(value)} has nothing usable in it`);
  return s;
}

export function identify({ project, name, path } = {}) {
  const cwd = real(path ?? process.cwd());
  let top = null;
  let main = null;
  try {
    top = real(git(cwd, ["rev-parse", "--show-toplevel"]));
    main = real(dirname(git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"])));
  } catch {}
  return {
    project: slug(project ?? basename(main ?? cwd), "project"),
    name: slug(name ?? (top && top !== main ? basename(top) : "root"), "worktree name"),
    path: top ?? cwd,
  };
}
