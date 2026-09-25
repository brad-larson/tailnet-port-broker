// Is a local port in use?
//
// Two questions, because one of them lies on macOS. A dev server can bind the
// IPv6 wildcard while another binds 127.0.0.1 on the SAME number — one per
// stack — and a wildcard bind test succeeds past a 127.0.0.1-only listener. So
// "is anything serving" is answered by connecting on both loopbacks, and "can
// I take it" additionally binds the wildcard the way `next dev` will.
import { connect, createServer } from "node:net";

function accepts(host, port) {
  return new Promise((resolve) => {
    const sock = connect({ host, port });
    const done = (ok) => {
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(500, () => done(false));
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
  });
}

/** True when something accepts connections on `port` over either loopback. */
export async function listening(port) {
  const [v4, v6] = await Promise.all([accepts("127.0.0.1", port), accepts("::1", port)]);
  return v4 || v6;
}

function bindable(port) {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port);
  });
}

/** True when nothing is serving `port` and a dev server could bind it. */
export async function portFree(port) {
  return !(await listening(port)) && (await bindable(port));
}
