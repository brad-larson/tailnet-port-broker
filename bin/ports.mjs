#!/usr/bin/env node
// ports — one host-wide broker for dev-server ports and their tailnet routes.
//
// Every project and every worktree on this machine asks here instead of picking
// a number by eye. A lease is `project:worktree` → a local port and a tailnet
// port (local + 10000), stable for as long as the lease lives, so a preview link
// survives restarts. See README.md for why each rule exists.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { identify } from "../lib/identify.mjs";
import { listening, portFree } from "../lib/net.mjs";
import { BLOCK, TAILNET_OFFSET, blockFor, keyOf, load, save, withLock } from "../lib/state.mjs";
import * as ts from "../lib/tailscale.mjs";

const HELP = `ports — host-wide broker for dev ports and tailnet previews

  ports claim   [--project P] [--name N] [--path DIR] [--env|--json]
                  this checkout's lease: a local port and its tailnet port.
                  Same answer every time for the same project:worktree.
  ports serve   [same flags]            claim, then route https://<host>:<tailnet>
                                        → http://localhost:<port>, refusing to
                                        replace anyone else's route
  ports unserve [project:name]          take this lease's route down
  ports release [project:name]          route down and lease given back
  ports ls      [--json]                every lease and every route on this host
  ports gc      [--dry-run] [--routes]  release leases whose checkout is gone and
                                        whose port is silent; --routes also turns
                                        off unleased routes to a silent local port
  ports whose   <port>                  who holds a local or tailnet port

With no flags, project and worktree come from git: the main checkout's
directory name, and the linked worktree's directory name (\`root\` for the main
checkout itself).`;

class Refusal extends Error {}

function parse(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      opts._.push(a);
      continue;
    }
    const [k, v] = a.slice(2).split(/=(.*)/s);
    if (v !== undefined) opts[k] = v;
    else if (["project", "name", "path"].includes(k)) opts[k] = argv[++i];
    else opts[k] = true;
  }
  return opts;
}

const tilde = (p) => (p.startsWith(homedir()) ? `~${p.slice(homedir().length)}` : p);

function url(lease) {
  try {
    return `https://${ts.dnsName()}:${lease.tailnetPort}`;
  } catch {
    return null;
  }
}

/** Routes, or an empty map with a warning — claiming a local port must still
 *  work on a machine where tailscale is down or absent. */
function routesOrEmpty() {
  try {
    return ts.routes();
  } catch (e) {
    console.error(`ports: tailscale unavailable (${e.message.split("\n")[0]}); tailnet ports are unchecked`);
    return new Map();
  }
}

/** The key a command acts on: `project:name` given, or this checkout's. */
function keyFor(opts) {
  if (opts._[1]) return opts._[1];
  const id = identify(opts);
  return keyOf(id.project, id.name);
}

async function claim(state, id, routes) {
  const key = keyOf(id.project, id.name);
  const held = state.leases[key];
  if (held) {
    held.path = id.path;
    return { key, lease: held, fresh: false };
  }
  const base = blockFor(state, id.project);
  const taken = new Set(Object.values(state.leases).map((l) => l.port));
  for (let port = base; port < base + BLOCK; port++) {
    if (taken.has(port) || routes.has(port + TAILNET_OFFSET)) continue;
    if (!(await portFree(port))) continue;
    const lease = {
      project: id.project,
      name: id.name,
      path: id.path,
      port,
      tailnetPort: port + TAILNET_OFFSET,
      claimedAt: new Date().toISOString(),
    };
    state.leases[key] = lease;
    return { key, lease, fresh: true };
  }
  throw new Error(`${id.project}'s block ${base}-${base + BLOCK - 1} is full — \`ports gc\`, then \`ports ls\``);
}

function report(opts, key, lease, extra = {}) {
  const preview = url(lease);
  if (opts.json) {
    console.log(JSON.stringify({ key, ...lease, url: preview, ...extra }, null, 2));
  } else if (opts.env) {
    console.log(`PORT=${lease.port}`);
    console.log(`TAILNET_PORT=${lease.tailnetPort}`);
    if (preview) console.log(`PREVIEW_URL=${preview}`);
  } else {
    console.log(`${key}${extra.fresh ? "  (new lease)" : ""}`);
    console.log(`  port     ${lease.port}    PORT=${lease.port} npm run dev`);
    if (preview) console.log(`  preview  ${preview}${extra.routed ? "" : "    (not routed — \`ports serve\`)"}`);
  }
}

async function cmdClaim(opts) {
  const id = identify(opts);
  const { key, lease, fresh, routed } = await withLock(async () => {
    const state = load();
    const routes = routesOrEmpty();
    const out = await claim(state, id, routes);
    save(state);
    return { ...out, routed: routes.get(out.lease.tailnetPort) === ts.localTarget(out.lease.port) };
  });
  report(opts, key, lease, { fresh, routed });
}

async function cmdServe(opts) {
  const id = identify(opts);
  const { key, lease, fresh } = await withLock(async () => {
    const state = load();
    const routes = ts.routes();
    const out = await claim(state, id, routes);
    save(state);
    const { tailnetPort: port } = out.lease;
    const target = ts.localTarget(out.lease.port);
    const current = routes.get(port);
    if (current && current !== target) {
      // A fresh claim never lands on a routed port, so this is a route somebody
      // put over ours after we took it. Say so; do not fight over it.
      throw new Refusal(
        `tailnet :${port} is leased to ${out.key} but now routes to ${current}, not ${target}.\n` +
          `  Someone served over it by hand. \`ports whose ${port}\` shows the lease;\n` +
          `  \`ports release ${out.key}\` and serve again for a fresh port.`,
      );
    }
    if (!current) {
      ts.serve(port, target);
      const after = ts.routes().get(port);
      if (after !== target) throw new Error(`served :${port} but tailscale now reports ${after ?? "no route"}`);
    }
    return out;
  });
  report(opts, key, lease, { fresh, routed: true });
  if (!(await listening(lease.port))) {
    console.error(`ports: nothing is listening on localhost:${lease.port} yet — the link returns 502 until`);
    console.error(`       the dev server is up (PORT=${lease.port}), and it must outlive this shell (tmux).`);
  }
}

/** Take a lease's route down if — and only if — it is still ours. */
function dropRoute(lease, routes) {
  const current = routes.get(lease.tailnetPort);
  if (!current) return "none";
  if (current !== ts.localTarget(lease.port)) return `left alone — routes to ${current}, not this lease`;
  ts.unserve(lease.tailnetPort);
  return "off";
}

async function cmdUnserve(opts) {
  const key = keyFor(opts);
  const lease = load().leases[key];
  if (!lease) throw new Refusal(`no lease for ${key}`);
  await withLock(async () => console.log(`${key}: route ${dropRoute(lease, ts.routes())}`));
}

async function cmdRelease(opts) {
  const key = keyFor(opts);
  await withLock(async () => {
    const state = load();
    const lease = state.leases[key];
    if (!lease) throw new Refusal(`no lease for ${key}`);
    const route = dropRoute(lease, routesOrEmpty());
    delete state.leases[key];
    save(state);
    console.log(`${key}: released ${lease.port}/${lease.tailnetPort}, route ${route}`);
  });
}

async function inventory() {
  const state = load();
  const routes = routesOrEmpty();
  const leases = await Promise.all(
    Object.entries(state.leases).map(async ([key, l]) => {
      const current = routes.get(l.tailnetPort);
      const route = !current ? "none" : current === ts.localTarget(l.port) ? "ours" : `STOLEN → ${current}`;
      return { key, ...l, up: await listening(l.port), route, pathExists: existsSync(l.path) };
    }),
  );
  const leased = new Set(Object.values(state.leases).map((l) => l.tailnetPort));
  const unleased = await Promise.all(
    [...routes]
      .filter(([port]) => !leased.has(port))
      .map(async ([port, target]) => {
        const local = ts.targetPort(target);
        return { port, target, up: local === null ? null : await listening(local) };
      }),
  );
  return { state, routes, leases, unleased };
}

function table(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(widths[i])).join("  ").trimEnd());
}

async function cmdLs(opts) {
  const { state, leases, unleased } = await inventory();
  if (opts.json) {
    console.log(JSON.stringify({ blocks: state.blocks, leases, unleasedRoutes: unleased }, null, 2));
    return;
  }
  if (leases.length) {
    table([
      ["LEASE", "PORT", "UP", "TAILNET", "ROUTE", "CHECKOUT"],
      ...leases
        .sort((a, b) => a.port - b.port)
        .map((l) => [l.key, l.port, l.up ? "yes" : "-", l.tailnetPort, l.route, `${l.pathExists ? "" : "(gone) "}${tilde(l.path)}`]),
    ]);
  } else {
    console.log("no leases");
  }
  if (unleased.length) {
    console.log("\nRoutes with no lease (set by hand):");
    table([
      ["TAILNET", "TARGET", "TARGET UP"],
      ...unleased.sort((a, b) => a.port - b.port).map((r) => [r.port, r.target, r.up === null ? "?" : r.up ? "yes" : "no"]),
    ]);
  }
}

async function cmdGc(opts) {
  const dry = Boolean(opts["dry-run"]);
  const say = (line) => console.log(`${dry ? "would " : ""}${line}`);
  await withLock(async () => {
    const { state, routes, leases, unleased } = await inventory();
    let n = 0;
    for (const l of leases) {
      // Both, never either: a checkout that still exists is a worktree between
      // servers, and a port still answering is a server that outlived its
      // directory — somebody is looking at it.
      if (l.pathExists || l.up) continue;
      const route = dry ? (l.route === "ours" ? "off" : l.route) : dropRoute(l, routes);
      delete state.leases[l.key];
      say(`release ${l.key} (${l.port}/${l.tailnetPort}; checkout gone; route ${route})`);
      n++;
    }
    if (opts.routes) {
      for (const r of unleased) {
        if (r.up !== false) continue; // a live target, or not a local one: not ours to judge
        if (!dry) ts.unserve(r.port);
        say(`turn off :${r.port} → ${r.target} (unleased, nothing listening)`);
        n++;
      }
    }
    if (!dry) save(state);
    if (!n) console.log("nothing to collect");
  });
}

async function cmdWhose(opts) {
  const port = Number(opts._[1]);
  if (!Number.isInteger(port)) throw new Refusal("usage: ports whose <port>");
  const { leases, unleased } = await inventory();
  const lease = leases.find((l) => l.port === port || l.tailnetPort === port);
  if (lease) {
    console.log(`${lease.key}  ${lease.port} → :${lease.tailnetPort}  ${tilde(lease.path)}  route ${lease.route}`);
    return;
  }
  const route = unleased.find((r) => r.port === port || ts.targetPort(r.target) === port);
  if (route) {
    console.log(`no lease; tailnet :${route.port} → ${route.target} (set by hand)`);
    return;
  }
  console.log(`${port}: no lease, no route${(await listening(port)) ? " — but something is listening on it" : ""}`);
}

const COMMANDS = {
  claim: cmdClaim,
  serve: cmdServe,
  unserve: cmdUnserve,
  release: cmdRelease,
  ls: cmdLs,
  gc: cmdGc,
  whose: cmdWhose,
};

const opts = parse(process.argv.slice(2));
const command = COMMANDS[opts._[0]];
if (!command) {
  console.log(HELP);
  process.exit(opts._[0] && !["help", "-h", "--help"].includes(opts._[0]) ? 1 : 0);
}
command(opts).catch((e) => {
  console.error(`ports: ${e.message}`);
  process.exit(1);
});
