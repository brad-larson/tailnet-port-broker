#!/usr/bin/env node
// A `tailscale` that refuses to clobber — installed AHEAD of the real CLI on
// PATH, so it protects routes from every project, including the ones whose docs
// never mention `ports`.
//
// `tailscale serve --https=N <target>` replaces whatever was on N without a
// word. This passes every command straight through except the handful that
// would take a port away from somebody else:
//
//   serve|funnel on a port leased to another checkout      refused
//   serve|funnel over an existing route to a different app  refused
//   serve reset                                             refused (every route
//                                                            on the machine)
//   serve|funnel at 127.0.0.1 or a bare port number         allowed, with a note
//                                                            (IPv4-only target)
//
// TAILNET_PORTS_FORCE=1 bypasses all of it. If the broker itself is broken the
// shim fails OPEN — a bug here must never take tailscale away.
import { spawnSync } from "node:child_process";
import { identify } from "../lib/identify.mjs";
import { keyOf, load, ownsTailnet } from "../lib/state.mjs";
import { realTailscale, routes, targetPort } from "../lib/tailscale.mjs";

const VALUE_FLAGS = new Set(["https", "http", "tcp", "tls-terminated-tcp", "set-path", "service", "proxy-protocol", "accept-app-caps"]);
const PASS = new Set(["status", "get-config", "set-config", "clear", "drain", "advertise"]);

function judge(args) {
  if (args[0] !== "serve" && args[0] !== "funnel") return null;
  const flags = {};
  const positional = [];
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith("-")) {
      positional.push(a);
      continue;
    }
    const [k, v] = a.replace(/^--?/, "").split(/=(.*)/s);
    if (v !== undefined) flags[k] = v;
    else if (VALUE_FLAGS.has(k)) flags[k] = args[++i];
    else flags[k] = true;
  }
  const sub = positional[0];
  if (PASS.has(sub) || flags.service) return null;
  if (sub === "reset") {
    return "`tailscale serve reset` removes EVERY route on this machine, including other projects' previews.\n  Take down your own with `ports unserve` (or `tailscale serve --https=<port> off`).";
  }
  if (sub === undefined) return null; // help / usage — let the real CLI say it

  // No port flag means 443: `tailscale serve 3000` is a claim on the default port.
  const port = Number(flags.https ?? flags.http ?? flags["tls-terminated-tcp"] ?? flags.tcp ?? 443);
  const off = positional.at(-1) === "off";
  const target = off ? null : positional.at(-1);

  const me = (() => {
    try {
      const id = identify();
      return keyOf(id.project, id.name);
    } catch {
      return null;
    }
  })();
  const owner = Object.entries(load().leases).find(([, l]) => ownsTailnet(l, port));
  if (owner && owner[0] !== me) {
    return `tailnet :${port} is leased to ${owner[0]} (${owner[1].path}).\n  \`ports serve\` gives this checkout a port of its own.`;
  }
  if (off) return null;

  const local = targetPort(target);
  if (flags["set-path"] === undefined || flags["set-path"] === "/") {
    const current = routes().get(port);
    if (current && !(local !== null && targetPort(current) === local)) {
      return `tailnet :${port} already routes to ${current}; this would silently replace it.\n  \`ports serve\` picks a free port, or \`ports whose ${port}\` to see whose it is.`;
    }
  }
  if (local !== null && !/localhost|\[::1\]/.test(target)) {
    // A warning, never a refusal. An IPv4 target is WRONG for a server on the
    // IPv6 wildcard (next dev's default) and exactly RIGHT for one bound to
    // 127.0.0.1 on purpose — 5seasons' dev-queue-preview does that so the plain
    // HTTP port never reaches the tailnet, and refusing it broke every one of
    // its previews on nigel (2026-09-25). The shim cannot see which server the
    // caller means, so it says what can go wrong and lets the command through.
    console.error(
      `tailscale (ports shim): note — "${target}" dials IPv4 only. Right for a server bound to 127.0.0.1;\n` +
        `  wrong for one on the IPv6 wildcard (next dev's default), where another app on 127.0.0.1:${local}\n` +
        `  would answer instead. For that case: http://localhost:${local}`,
    );
  }
  return null;
}

const args = process.argv.slice(2);
let verdict = null;
if (!process.env.TAILNET_PORTS_FORCE) {
  try {
    verdict = judge(args);
  } catch (e) {
    console.error(`tailscale (ports shim): could not check this command (${e.message}); passing it through`);
  }
}
if (verdict) {
  console.error(`tailscale (ports shim): refused.\n  ${verdict}\n  TAILNET_PORTS_FORCE=1 to do it anyway.`);
  process.exit(1);
}
const r = spawnSync(realTailscale(), args, { stdio: "inherit" });
process.exit(r.status ?? 1);
