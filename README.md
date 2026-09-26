# tailnet-port-broker

One broker per machine for dev-server ports and their `tailscale serve` routes,
so projects and worktrees stop taking each other's ports.

```sh
cd ~/coding/brain/.claude/worktrees/fix-thing
ports serve
# brain:fix-thing  (new lease)
#   port     20114    PORT=20114 npm run dev
#   preview  https://myhost.example-tailnet.ts.net:30114
```

## Why

Every project on a host picks ports by eye, from the same few numbers, and
`tailscale serve --https=N <target>` replaces whatever was on `N` without a word.
This is what one dev machine looked like on 2026-09-25:

- **10 tailnet routes, 7 of them pointing at nothing.** Nothing ever takes a
  route down, so dead routes pile up. Every session then walks upward from the
  same numbers, so the collisions all land on the same few free ports.
- **5seasons was using local 3001, 3002, 3008 and 3012**, all inside the
  3001–3089 range Brain's `wt:up` hands out.
- **5 of 10 routes targeted `127.0.0.1`.** `next dev` binds the IPv6 wildcard, and
  macOS lets a different app hold the same number on 127.0.0.1. A route to
  `127.0.0.1:3012` reached a *5seasons* server while Brain's server sat on
  `[::]:3012`: 500s, and nothing in the dev log.
- On 2026-09-19 a Brain preview on `:8456` was re-mapped by another session
  within the hour. The link still returned 200, but it was serving someone
  else's app.

Instructions ("read `tailscale serve status` first") had already been written and
did not help. Reading and then serving is check-then-act between agents that
cannot see each other, and a 5seasons agent never reads Brain's docs.

## Model

- **A lease** is `project:worktree` → a local port and a tailnet port. Asking
  again returns the same lease, so a preview link survives restarts and
  re-runs.
- **Each project gets a block of 100 local ports** (20000–20099, 20100–20199, …),
  allocated on first use and recorded. You never maintain a table by hand.
- **The tailnet port is always the local port + 10000.** Local 20114 is
  `https://<host>:30114`, so there is only one number to remember.
- **A lease can be a block.** `--count 10` leases ten contiguous local ports and
  the ten tailnet ports beside them (each + 10000). Meridian runs web, api, pdf
  and mcp per worktree and routes three of them. One lease covering the whole
  block is what lets the shim refuse another checkout on any of them, and lets
  `release` take every route down. A lease never changes size in place.
- **A port is free only if nothing answers on *either* loopback** and the IPv6
  wildcard binds. Brain's `wt:up` once handed out a port someone was
  already serving on, because the only check was a bind test.
- **Routes always target `http://localhost:<port>`**, never `127.0.0.1` or a
  bare port.
- **The live `tailscale serve` config is the only registry of routes.** The
  broker reads it on every call instead of keeping a copy, so a route someone
  set by hand is still seen.
- **One lock file** (`~/.config/tailnet-ports/leases.lock`, O_EXCL + pid)
  serialises every change. If the process holding it has died, the next caller
  takes it over.

## Commands

| | |
|---|---|
| `ports claim [--count N] [--env\|--json]` | this checkout's lease. `--env` prints `PORT=`, `TAILNET_PORT=`, `PREVIEW_URL=`. `--count N` leases N contiguous ports and the N tailnet ports beside them, as one lease |
| `ports serve` | claim, then route the tailnet port → `http://localhost:<port>`. Refuses if someone has since routed over it |
| `ports unserve [project:name]` | take the route down, only if it is still ours |
| `ports release [project:name]` | route down and lease given back. Do this when the worktree goes away |
| `ports ls [--json]` | every lease (listening? route ours/stolen? checkout gone?) and every route set by hand |
| `ports gc [--dry-run]` | release leases whose checkout is gone **and** whose port is silent. It lists hand-set routes to a silent port but never turns them off |
| `ports unroute <port>...` | turn off a hand-set route once you know it is dead. Refuses a leased port, and a target that is answering unless `--force` |
| `ports whose <port>` | who holds a local or tailnet port |

With no arguments, identity comes from git: the project is the main checkout's
directory name, and the worktree is the linked worktree's directory name
(`root` for the main checkout). It works from any subdirectory. Override with
`--project`, `--name`, `--path`.

## The shim

`ports` only protects projects that call it. The shim covers everyone else. It
is a `tailscale` placed ahead of the real one on PATH that passes every command
through except:

- `serve`/`funnel` on a tailnet port **leased to another checkout**
- `serve`/`funnel` **over an existing route to a different app** (re-pointing
  the same local port, e.g. from `127.0.0.1` to `localhost`, is allowed)
- `serve reset`, which removes every route on the machine

A target at **`127.0.0.1` or a bare port** is let through with a note, not
refused. It is wrong for a server on the IPv6 wildcard (`next dev`'s default)
and exactly right for one bound to 127.0.0.1 on purpose. 5seasons'
`dev-queue-preview` binds that way so the plain-HTTP port never reaches the
tailnet, and the first version of this shim refused it, breaking every one of
its previews. `ports serve` always writes `http://localhost:<port>`, which
reaches a server on either stack.

With no `--https` flag, `serve` targets port 443, and the shim checks it that way.
`TAILNET_PORTS_FORCE=1` bypasses the shim. If the broker is broken, or node is
not on PATH, the shim **fails open** and runs the real CLI: a bug here must
never take tailscale away.

## Install

```sh
git clone git@github.com:brad-larson/tailnet-port-broker.git ~/coding/tailnet-port-broker
~/coding/tailnet-port-broker/install.sh --shim
```

Then put this line in **three** files: `~/.zshenv`, `~/.zprofile`, and the end
of `~/.zshrc`:

```sh
export PATH="$HOME/.local/share/tailnet-ports/shim:$PATH"
```

All three are needed on macOS. `.zshenv` is the only file a plain `zsh -c`
reads. Login shells then run `/etc/zprofile`, whose `path_helper` moves
`/opt/homebrew/bin` (from `/etc/paths.d/homebrew`) back ahead of the shim, so
`.zprofile` has to prepend it again. `.zshrc` rebuilds PATH itself (asdf, mise),
so interactive shells need the line after that. Check with
`for f in -c -lc -ic -lic; do zsh $f 'command -v tailscale'; done`: all four
should print the shim. A shell that was already running keeps its old PATH, so
agent sessions that were open before the install get the shim only once they
restart.

Zero dependencies, Node ≥ 20. Leases are per machine (`~/.config/tailnet-ports/`,
or `$TAILNET_PORTS_HOME`), because ports are per machine.

## Paste into a project's CLAUDE.md / AGENTS.md

```md
## Ports and tailnet previews
Never pick a port or run `tailscale serve` by hand. In your checkout:
- `ports claim --env` → the `PORT` to start the dev server on (same answer every time).
- `ports serve` → routes it and prints the https preview URL. Put the server in tmux
  first; a route to nothing returns 502.
- `ports release` when the worktree is torn down.
`ports ls` shows who has what; `ports whose <port>` answers "is that mine?".
```

## Adopting it on a host that already has routes

Hand-set routes keep working. `ports ls` lists them under *Routes with no
lease*, claims skip their ports, and the shim refuses to overwrite them.

Nothing turns them off automatically. A hand-set route has no lease, so there
is no checkout to check, and a worktree whose server is merely stopped looks
exactly like a dead one. On nigel, 5 of 7 silent routes still belonged to live
worktrees. Find the owner (a worktree's `.env`/`.env.local` naming the port is
the usual tell), then `ports unroute <port>`.

## Not done

- **Per-worktree hostnames instead of ports** (Tailscale Services,
  `svc:<name>`) would give nicer URLs, but each one needs a service definition
  and approval in the admin console.
- **The shim cannot stop a racing pair of raw `tailscale serve` calls.** It
  reads and then writes without the lock. `ports serve` holds the lock around
  its read, write and verify.
