#!/usr/bin/env node
// A stand-in for the tailscale CLI: the serve config lives in $FAKE_TS_STATE,
// and every invocation is appended to $FAKE_TS_LOG. It stores targets the way
// the real one does — a bare port becomes http://127.0.0.1:<port>.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const HOST = "box.example.ts.net";
const args = process.argv.slice(2);
if (process.env.FAKE_TS_LOG) appendFileSync(process.env.FAKE_TS_LOG, `${JSON.stringify(args)}\n`);

let config;
try {
  config = JSON.parse(readFileSync(process.env.FAKE_TS_STATE, "utf8"));
} catch {
  config = { TCP: {}, Web: {} };
}

if (args[0] === "status") {
  console.log(JSON.stringify({ Self: { DNSName: `${HOST}.` } }));
  process.exit(0);
}
if (args[0] !== "serve") process.exit(2);
if (args[1] === "status") {
  console.log(JSON.stringify(config));
  process.exit(0);
}
if (args[1] === "reset") {
  writeFileSync(process.env.FAKE_TS_STATE, JSON.stringify({ TCP: {}, Web: {} }));
  process.exit(0);
}

let port = 443;
let target = null;
for (const a of args.slice(1)) {
  if (a.startsWith("--https=")) port = Number(a.slice("--https=".length));
  else if (!a.startsWith("-")) target = a;
}
if (target === "off") {
  delete config.TCP[port];
  delete config.Web[`${HOST}:${port}`];
} else {
  const proxy = /^\d+$/.test(target) ? `http://127.0.0.1:${target}` : target.includes("://") ? target : `http://${target}`;
  config.TCP[port] = { HTTPS: true };
  config.Web[`${HOST}:${port}`] = { Handlers: { "/": { Proxy: proxy } } };
}
writeFileSync(process.env.FAKE_TS_STATE, JSON.stringify(config));
