// The only registry of tailnet ports that exists: `tailscale serve status`.
//
// The broker never keeps its own copy of what is routed — it reads the live
// config every time, so a route someone set by hand is seen, not assumed away.
import { execFileSync } from "node:child_process";
import { accessSync, constants, realpathSync } from "node:fs";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

const SHIM = fileURLToPath(new URL("../bin/tailscale.mjs", import.meta.url));

/** The real tailscale CLI — never our own shim of the same name, which would
 *  otherwise call itself. */
export function realTailscale() {
  if (process.env.TAILSCALE_BIN) return process.env.TAILSCALE_BIN;
  const shim = realpathSync(SHIM);
  const candidates = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "tailscale"));
  candidates.push("/Applications/Tailscale.app/Contents/MacOS/Tailscale");
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (realpathSync(candidate) === shim) continue;
      return candidate;
    } catch {}
  }
  throw new Error("tailscale CLI not found on PATH (set TAILSCALE_BIN)");
}

function run(args) {
  return execFileSync(realTailscale(), args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** Every port `tailscale serve` holds on this node → what it routes to. */
export function routes() {
  const raw = run(["serve", "status", "--json"]).trim();
  const config = raw ? JSON.parse(raw) : {};
  const out = new Map();
  for (const [port, tcp] of Object.entries(config.TCP ?? {})) {
    let target = tcp.TCPForward ? `tcp://${tcp.TCPForward}` : "(unknown)";
    for (const [hostPort, web] of Object.entries(config.Web ?? {})) {
      if (!hostPort.endsWith(`:${port}`)) continue;
      const handlers = web.Handlers ?? {};
      const root = handlers["/"] ?? Object.values(handlers)[0];
      if (root?.Proxy) target = root.Proxy;
      else if (root?.Path) target = `path:${root.Path}`;
      else if (root?.Text !== undefined) target = "text";
    }
    out.set(Number(port), target);
  }
  return out;
}

let dns;
/** This node's MagicDNS name, e.g. myhost.example-tailnet.ts.net. */
export function dnsName() {
  dns ??= JSON.parse(run(["status", "--json"])).Self.DNSName.replace(/\.$/, "");
  return dns;
}

export function serve(port, target) {
  run(["serve", "--bg", `--https=${port}`, target]);
}

export function unserve(port) {
  run(["serve", `--https=${port}`, "off"]);
}

/** Always `localhost`, never 127.0.0.1 or a bare port: both of those register
 *  an IPv4-only target, and `next dev` binds IPv6 — so the route can reach a
 *  different process holding the same number on the other stack. */
export const localTarget = (port) => `http://localhost:${port}`;

/** The local port a route target points at, when it points at this machine. */
export function targetPort(target) {
  const m = /^(?:(?:https?(?:\+insecure)?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\]):)?(\d+)\/?$/.exec(target ?? "");
  return m ? Number(m[1]) : null;
}
