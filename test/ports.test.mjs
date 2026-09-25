// Every test gets its own lease home and its own fake tailscale config, so none
// of them can see this machine's real leases or routes. Local ports are real:
// the tests bind them, because the bugs this exists for live in the binding.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const PORTS = fileURLToPath(new URL("../bin/ports.mjs", import.meta.url));
const SHIM = fileURLToPath(new URL("../bin/tailscale.mjs", import.meta.url));
const FAKE = fileURLToPath(new URL("./fake-tailscale.mjs", import.meta.url));
const HOST = "box.example.ts.net";

function sandbox() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "ports-test-")));
  const env = {
    ...process.env,
    TAILNET_PORTS_HOME: join(dir, "home"),
    TAILSCALE_BIN: FAKE,
    FAKE_TS_STATE: join(dir, "serve.json"),
    FAKE_TS_LOG: join(dir, "calls.log"),
  };
  delete env.TAILNET_PORTS_FORCE;
  const run = (bin, args, opts = {}) => spawnSync(process.execPath, [bin, ...args], { env, encoding: "utf8", ...opts });
  const ports = (...args) => run(PORTS, args, { cwd: dir });
  const json = (...args) => {
    const r = ports(...args, "--json");
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const route = (port, proxy) => {
    const cfg = serveConfig();
    cfg.TCP[port] = { HTTPS: true };
    cfg.Web[`${HOST}:${port}`] = { Handlers: { "/": { Proxy: proxy } } };
    writeFileSync(env.FAKE_TS_STATE, JSON.stringify(cfg));
  };
  const serveConfig = () => {
    try {
      return JSON.parse(readFileSync(env.FAKE_TS_STATE, "utf8"));
    } catch {
      return { TCP: {}, Web: {} };
    }
  };
  const routeOf = (port) => serveConfig().Web[`${HOST}:${port}`]?.Handlers["/"].Proxy;
  const calls = () => {
    try {
      return readFileSync(env.FAKE_TS_LOG, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    } catch {
      return [];
    }
  };
  const shim = (args, cwd = dir) => run(SHIM, args, { cwd });
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  return { dir, env, ports, json, route, routeOf, calls, shim, cleanup };
}

function hold(port, host) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

const close = (server) => new Promise((r) => server.close(r));

test("a claim is stable, and the tailnet port is local + 10000", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const a = s.json("claim", "--project", "alpha", "--name", "one");
  const again = s.json("claim", "--project", "alpha", "--name", "one");
  assert.equal(again.port, a.port);
  assert.equal(a.tailnetPort, a.port + 10000);
  assert.ok(a.port >= 20000 && a.port < 20100, `${a.port} is in the first block`);
  assert.equal(a.url, `https://${HOST}:${a.tailnetPort}`);
});

test("each project gets its own block of 100", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const a = s.json("claim", "--project", "alpha", "--name", "one");
  const b = s.json("claim", "--project", "beta", "--name", "one");
  assert.equal(Math.floor(a.port / 100) * 100, 20000);
  assert.equal(Math.floor(b.port / 100) * 100, 20100);
});

test("simultaneous claims never share a port", async (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const N = 12;
  const outs = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [PORTS, "claim", "--project", "race", "--name", `w${i}`, "--json"], { env: s.env });
        let out = "";
        let err = "";
        child.stdout.on("data", (d) => (out += d));
        child.stderr.on("data", (d) => (err += d));
        child.on("close", (code) => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
      }),
    ),
  );
  assert.equal(new Set(outs.map((o) => o.port)).size, N);
  const leases = JSON.parse(readFileSync(join(s.env.TAILNET_PORTS_HOME, "leases.json"), "utf8")).leases;
  assert.equal(Object.keys(leases).length, N);
});

test("a port held on IPv4 loopback only is not handed out", async (t) => {
  // The 5seasons collision: another app on 127.0.0.1:<n> while a wildcard bind
  // test would still call <n> free.
  const s = sandbox();
  const server = await hold(20000, "127.0.0.1");
  t.after(async () => {
    await close(server);
    s.cleanup();
  });
  const a = s.json("claim", "--project", "alpha", "--name", "one");
  assert.notEqual(a.port, 20000);
});

test("a port held on the wildcard is not handed out", async (t) => {
  const s = sandbox();
  const server = await hold(20000);
  t.after(async () => {
    await close(server);
    s.cleanup();
  });
  assert.notEqual(s.json("claim", "--project", "alpha", "--name", "one").port, 20000);
});

test("a tailnet port somebody already routes is skipped", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  s.route(30000, "http://127.0.0.1:9999");
  const a = s.json("claim", "--project", "alpha", "--name", "one");
  assert.notEqual(a.tailnetPort, 30000);
  assert.equal(s.routeOf(30000), "http://127.0.0.1:9999");
});

test("serve routes the localhost form, and a second serve changes nothing", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const a = s.json("serve", "--project", "alpha", "--name", "one");
  assert.equal(s.routeOf(a.tailnetPort), `http://localhost:${a.port}`);
  const writes = () => s.calls().filter((c) => c[0] === "serve" && c[1] !== "status").length;
  const before = writes();
  s.json("serve", "--project", "alpha", "--name", "one");
  assert.equal(writes(), before);
});

test("serve refuses to take back a port someone routed over", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const a = s.json("serve", "--project", "alpha", "--name", "one");
  s.route(a.tailnetPort, "http://127.0.0.1:3012");
  const r = s.ports("serve", "--project", "alpha", "--name", "one");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /now routes to http:\/\/127\.0\.0\.1:3012/);
  assert.equal(s.routeOf(a.tailnetPort), "http://127.0.0.1:3012");
});

test("release turns the route off and gives the port back", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const a = s.json("serve", "--project", "alpha", "--name", "one");
  const r = s.ports("release", "alpha:one");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.routeOf(a.tailnetPort), undefined);
  assert.equal(s.json("claim", "--project", "alpha", "--name", "two").port, a.port);
});

test("release leaves a route alone that is no longer ours", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const a = s.json("serve", "--project", "alpha", "--name", "one");
  s.route(a.tailnetPort, "http://localhost:4444");
  assert.equal(s.ports("release", "alpha:one").status, 0);
  assert.equal(s.routeOf(a.tailnetPort), "http://localhost:4444");
});

test("gc releases a lease only when its checkout is gone AND its port is silent", async (t) => {
  const s = sandbox();
  const gone = join(s.dir, "gone");
  const kept = join(s.dir, "kept");
  const ghost = join(s.dir, "ghost");
  for (const d of [gone, kept, ghost]) mkdirSync(d);
  const g = s.json("serve", "--project", "alpha", "--name", "gone", "--path", gone);
  s.json("serve", "--project", "alpha", "--name", "kept", "--path", kept);
  const h = s.json("serve", "--project", "alpha", "--name", "ghost", "--path", ghost);
  rmSync(gone, { recursive: true });
  rmSync(ghost, { recursive: true });
  const server = await hold(h.port); // directory gone, server still answering
  t.after(async () => {
    await close(server);
    s.cleanup();
  });

  const dry = s.ports("gc", "--dry-run");
  assert.match(dry.stdout, /would release alpha:gone/);
  assert.ok(s.routeOf(g.tailnetPort), "a dry run changes nothing");

  assert.equal(s.ports("gc").status, 0);
  const leases = Object.keys(s.json("ls").leases.reduce((m, l) => ({ ...m, [l.key]: l }), {}));
  assert.deepEqual(leases.sort(), ["alpha:ghost", "alpha:kept"]);
  assert.equal(s.routeOf(g.tailnetPort), undefined);
  assert.ok(s.routeOf(h.tailnetPort));
});

test("gc --routes turns off unleased routes to a silent port, and only those", async (t) => {
  const s = sandbox();
  const server = await hold(20555);
  t.after(async () => {
    await close(server);
    s.cleanup();
  });
  s.route(8451, "http://127.0.0.1:20554"); // nothing there
  s.route(8454, "http://localhost:20555"); // live
  s.route(443, "path:/srv/www"); // not a local port: not ours to judge
  assert.equal(s.ports("gc").status, 0);
  assert.ok(s.routeOf(8451), "plain gc leaves hand-set routes alone");
  assert.equal(s.ports("gc", "--routes").status, 0);
  assert.equal(s.routeOf(8451), undefined);
  assert.ok(s.routeOf(8454));
  assert.ok(s.routeOf(443));
});

test("a lock left by a dead process is taken over", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" }).stdout;
  mkdirSync(s.env.TAILNET_PORTS_HOME, { recursive: true });
  writeFileSync(join(s.env.TAILNET_PORTS_HOME, "leases.lock"), `${dead}\n`);
  const started = Date.now();
  s.json("claim", "--project", "alpha", "--name", "one");
  assert.ok(Date.now() - started < 5000);
});

test("identity comes from git: main checkout is root, a linked worktree is its directory", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const repo = join(s.dir, "myproj");
  mkdirSync(repo);
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x", "--no-gpg-sign");
  const wt = join(repo, ".claude", "worktrees", "Fix-Thing");
  git("worktree", "add", "-q", wt);

  const at = (cwd) => JSON.parse(spawnSync(process.execPath, [PORTS, "claim", "--json"], { cwd, env: s.env, encoding: "utf8" }).stdout);
  assert.equal(at(repo).key, "myproj:root");
  mkdirSync(join(wt, "web"));
  const fromSubdir = at(join(wt, "web"));
  assert.equal(fromSubdir.key, "myproj:fix-thing");
  assert.equal(fromSubdir.path, wt);
  assert.equal(at(wt).port, fromSubdir.port);
});

test("shim: refuses a port leased to another checkout", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const a = s.json("claim", "--project", "alpha", "--name", "one");
  const r = s.shim(["serve", "--bg", `--https=${a.tailnetPort}`, "http://localhost:3999"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /leased to alpha:one/);
  assert.equal(s.calls().filter((c) => c[0] === "serve" && c[1] !== "status").length, 0, "no serve write reached tailscale");
});

test("shim: refuses to replace a route to a different app", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  s.route(8446, "http://localhost:3074");
  const r = s.shim(["serve", "--bg", "--https=8446", "http://localhost:3031"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /already routes to http:\/\/localhost:3074/);
  assert.equal(s.routeOf(8446), "http://localhost:3074");
});

test("shim: re-pointing a route at the same local port is allowed", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  s.route(8446, "http://127.0.0.1:3074");
  const r = s.shim(["serve", "--bg", "--https=8446", "http://localhost:3074"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.routeOf(8446), "http://localhost:3074");
});

test("shim: refuses the IPv4-only forms and says what to type", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  for (const target of ["3012", "127.0.0.1:3012", "http://127.0.0.1:3012"]) {
    const r = s.shim(["serve", "--bg", "--https=8499", target]);
    assert.equal(r.status, 1, target);
    assert.match(r.stderr, /--https=8499 http:\/\/localhost:3012/);
  }
});

test("shim: no port flag means 443", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  s.route(443, "http://127.0.0.1:8088");
  const r = s.shim(["serve", "--bg", "http://localhost:3000"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /:443 already routes/);
});

test("shim: refuses reset; passes status and a clean serve through", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  s.route(8446, "http://localhost:3074");
  assert.equal(s.shim(["serve", "reset"]).status, 1);
  assert.ok(s.routeOf(8446));
  const status = s.shim(["serve", "status", "--json"]);
  assert.equal(status.status, 0);
  assert.ok(JSON.parse(status.stdout).TCP["8446"]);
  assert.equal(s.shim(["serve", "--bg", "--https=8447", "http://localhost:3075"]).status, 0);
  assert.equal(s.routeOf(8447), "http://localhost:3075");
});

test("shim: TAILNET_PORTS_FORCE=1 bypasses it", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  s.route(8446, "http://localhost:3074");
  const r = spawnSync(process.execPath, [SHIM, "serve", "--bg", "--https=8446", "http://localhost:3031"], {
    env: { ...s.env, TAILNET_PORTS_FORCE: "1" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.routeOf(8446), "http://localhost:3031");
});

test("shim: a broken lease file fails open", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  mkdirSync(s.env.TAILNET_PORTS_HOME, { recursive: true });
  writeFileSync(join(s.env.TAILNET_PORTS_HOME, "leases.json"), "{not json");
  const r = s.shim(["serve", "--bg", "--https=8447", "http://localhost:3075"]);
  assert.equal(r.status, 0);
  assert.match(r.stderr, /passing it through/);
});

test("shim: the owner of a lease may serve and take down its own port", (t) => {
  const s = sandbox();
  t.after(s.cleanup);
  const owner = basename(s.dir);
  const a = s.json("claim"); // identity from cwd: <dir>:root
  assert.equal(a.key, `${owner.toLowerCase()}:root`);
  assert.equal(s.shim(["serve", "--bg", `--https=${a.tailnetPort}`, `http://localhost:${a.port}`]).status, 0);
  assert.equal(s.shim(["serve", `--https=${a.tailnetPort}`, "off"]).status, 0);
  assert.equal(s.routeOf(a.tailnetPort), undefined);
});
