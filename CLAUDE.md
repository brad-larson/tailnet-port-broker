# CLAUDE.md

`ports` — a host-wide broker for dev-server ports and `tailscale serve` routes.
README.md is the spec; every rule in it has an incident behind it.

- **Zero dependencies.** It runs on every machine before anything is installed,
  and inside the shim on every `tailscale` call.
- **The shim fails open.** Any error while judging a command → pass it to the
  real CLI. A bug here must never take tailscale away.
- **The live `tailscale serve` config is the route registry.** Never cache routes
  in the lease file.
- **Every read → decide → write of the lease file goes inside `withLock`.**
- **Targets are always `http://localhost:<port>`** — see README, "Why".
- `npm test` runs against a fake tailscale (`test/fake-tailscale.mjs`) and a
  throwaway `TAILNET_PORTS_HOME`; it binds real local ports, because the port
  bugs live in the binding. A new guard gets a test, and the test must fail with
  the guard removed.
- To try it against the real tailscale without touching this machine's leases:
  `TAILNET_PORTS_HOME=$(mktemp -d) node bin/ports.mjs ls`.
