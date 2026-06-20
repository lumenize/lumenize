import { LumenizeContainer } from '@lumenize/mesh/container';

// allowedHosts (host-specific outbound interception) requires the Worker to export
// ContainerProxy, or the container fails to start (phase0 finding). The block-all
// default (enableInternet=false, no allowedHosts) does NOT need it.
export { ContainerProxy } from '@cloudflare/containers';

const CMD_PORT = 8080;

type ExecResult = { stdout: string; stderr: string; code: number; durationMs: number };

/**
 * Egress + CA-trust probe node. LumenizeContainer already pins enableInternet=false
 * (secure by default); we open a single allow-listed HTTPS host (github.com — the
 * stand-in for *.artifacts.cloudflare.net) with interceptHttps on. The question this
 * experiment answers: does the runtime CA-trust recipe make that allow-listed HTTPS
 * host reachable by a real git/curl client — and does any of this engage under LOCAL
 * `wrangler dev` on Docker Desktop?
 */
export class EgressContainer extends LumenizeContainer {
  defaultPort = CMD_PORT;
  sleepAfter = '10m';
  override enableInternet = false;        // explicit (LumenizeContainer pins this too)
  override allowedHosts = ['github.com']; // deny-by-default allow-list, single host (Artifacts analogue)
  override interceptHttps = true;         // HTTPS allow-list interception is gated on this

  // Plain method (raw RPC, fine in experiment code) — drives a shell command in the
  // container via containerFetch to the command-server. First call may race cold boot.
  async runExec(cmd: string): Promise<ExecResult> {
    const res = await this.containerFetch(
      new Request('http://cmd.local/exec', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cmd }),
      }),
      CMD_PORT,
    );
    const text = await res.text();
    if (!res.ok) throw new Error(`container unavailable ${res.status}: ${text.slice(0, 200)}`);
    try {
      return JSON.parse(text) as ExecResult;
    } catch {
      throw new Error(`non-JSON from command-server (cold boot?): ${text.slice(0, 200)}`);
    }
  }
}

const CA = '/etc/cloudflare/certs/cloudflare-containers-ca.crt';

export default {
  async fetch(request: Request, env: { EGRESS: DurableObjectNamespace; ARTIFACTS?: any }): Promise<Response> {
    const url = new URL(request.url);
    const stub = (env.EGRESS as any).getByName('probe') as { runExec(cmd: string): Promise<ExecResult> };
    const exec = (cmd: string) => stub.runExec(cmd);

    try {
      if (url.pathname === '/artifacts-info') {
        // Stage A: the decisive fact — does the Artifacts binding instantiate under LOCAL
        // wrangler dev (no beta?), and what does create() hand back (real *.artifacts.cloudflare.net
        // URL, a localhost sim URL, or an entitlement error)?
        const A = env.ARTIFACTS;
        if (!A) return Response.json({ error: 'no ARTIFACTS binding present' }, { status: 500 });
        const name = 'egress-test';
        try {
          const created = await A.create(name);
          return Response.json({
            probe: 'artifacts-info',
            action: 'create',
            keys: Object.keys(created ?? {}),
            remote: created?.remote,
            defaultBranch: created?.defaultBranch,
            tokenKind: typeof created?.token,
            tokenPrefix: typeof created?.token === 'string' ? created.token.slice(0, 14) : undefined,
          });
        } catch (e) {
          // Maybe it already exists — try get() — or it's an entitlement/unsupported error.
          try {
            const repo = await A.get(name);
            const info = await repo.info?.();
            return Response.json({
              probe: 'artifacts-info',
              action: 'get(after create threw)',
              createError: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
              remote: info?.remote,
              defaultBranch: info?.defaultBranch,
              infoKeys: Object.keys(info ?? {}),
            });
          } catch (e2) {
            return Response.json({
              probe: 'artifacts-info',
              createError: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
              getError: e2 instanceof Error ? `${e2.name}: ${e2.message}` : String(e2),
            }, { status: 500 });
          }
        }
      }

      if (url.pathname === '/healthz') {
        return Response.json(await exec('echo ok'));
      }

      if (url.pathname === '/blocktest') {
        // Disambiguate the deny-by-default check: with the CA trusted, TLS succeeds, so a
        // non-allow-listed host now fails at the HTTP/egress layer (a real block) rather than
        // at TLS (a cert error). Allow-listed host stays 200 for contrast. One warm call.
        const cmd =
          `cp ${CA} /usr/local/share/ca-certificates/cf.crt 2>/dev/null && update-ca-certificates >/dev/null 2>&1; ` +
          `echo '--- example.com (NON-allow-listed, CA trusted) ---'; ` +
          `curl -sS -m 8 -o /dev/null -w 'HTTP %{http_code}\\n' https://example.com 2>&1; echo "exit=$?"; ` +
          `echo '--- github.com (allow-listed, CA trusted) ---'; ` +
          `curl -sS -m 8 -o /dev/null -w 'HTTP %{http_code}\\n' https://github.com 2>&1; echo "exit=$?"`;
        return Response.json(await exec(cmd));
      }

      if (url.pathname === '/probe') {
        // Warm the channel — the first containerFetch races cold boot.
        let warmed = false;
        for (let i = 0; i < 12; i++) {
          try { await exec('echo warm'); warmed = true; break; }
          catch { await new Promise((r) => setTimeout(r, 1500)); }
        }

        const curl = (host: string) =>
          `curl -sS -m 8 -o /dev/null -w 'HTTP %{http_code}\\n' ${host} 2>&1; echo "exit=$?"`;

        const steps: Record<string, ExecResult> = {};
        // 1. Is the ephemeral CF interception CA even present at runtime (locally)?
        steps['1_caPresent'] = await exec(`ls -la /etc/cloudflare/certs/ 2>&1; echo "exit=$?"`);
        // 2. Non-allow-listed host must be BLOCKED (deny-by-default, allowedHosts set).
        steps['2_blocked_example'] = await exec(curl('https://example.com'));
        // 3. Allow-listed host BEFORE CA trust — if interception MITMs, expect a cert error.
        steps['3_github_beforeCA'] = await exec(curl('https://github.com'));
        // 4. Install the ephemeral CA into the system trust store at runtime.
        steps['4_installCA'] = await exec(
          `if [ -f ${CA} ]; then cp ${CA} /usr/local/share/ca-certificates/cf-containers.crt && update-ca-certificates 2>&1 | tail -2; else echo NO_CA_FILE; fi; echo "exit=$?"`,
        );
        // 5. Allow-listed host AFTER CA trust — expect HTTP 200/301.
        steps['5_github_afterCA'] = await exec(curl('https://github.com'));
        // 6. The real target: git clone over the intercepted HTTPS, CA now trusted.
        steps['6_gitClone'] = await exec(
          `rm -rf /tmp/hw; git clone --depth 1 https://github.com/octocat/Hello-World.git /tmp/hw 2>&1 | tail -4; echo "clone_exit=$?"; ls /tmp/hw 2>&1 | head`,
        );

        return Response.json({ warmed, steps });
      }

      return new Response('routes: /probe, /healthz');
    } catch (e) {
      return Response.json(
        { error: e instanceof Error ? `${e.name}: ${e.message}` : String(e) },
        { status: 500 },
      );
    }
  },
};
