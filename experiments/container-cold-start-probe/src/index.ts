/**
 * Deployed throwaway probe: measure the REAL Cloudflare-side cost of the Nebula
 * build-box sequence — cold container start → restore source → (optional) npm install
 * → `vite build` → return dist — on CF's own x64 hardware at a chosen instance_type.
 *
 * Why this exists: the local Docker numbers in experiments/container-dep-restore-bench
 * omit CF instance acquisition entirely (no scheduling, no image pull, warm page cache),
 * and Larry rightly flagged that a 0.2 s container start can't be right when a DO cold
 * start is ~300 ms. This measures the part local Docker cannot see.
 *
 * ⚠️ Timing (see the cf-clock-traps memory): `Date.now()` is pinned WITHIN one
 * invocation but DOES advance across awaits. Every mark below is separated by an
 * awaited containerFetch (real I/O), so the deltas are real wall-clock. The harness
 * also reports an external-observer total as the sanity check the memory requires.
 *
 * Raw `ctx.container` per containers.md — deliberately NOT `extends Container`.
 */
import { DurableObject } from 'cloudflare:workers';

const CMD_PORT = 9000;
const READY_TIMEOUT_MS = 120_000;

interface Step { step: string; ms: number; detail?: string }

/** A representative generated app: a chart + several icons + daisyUI markup. */
const APP_WITH_CHART = `<script setup lang="ts">
import { ref, onMounted } from 'vue';
import * as echarts from 'echarts';
import { House, Search, Settings, ChartBar } from 'lucide-vue-next';
const el = ref<HTMLDivElement>();
onMounted(() => {
  if (!el.value) return;
  const c = echarts.init(el.value);
  c.setOption({ xAxis: { type: 'category', data: ['a','b','c'] }, yAxis: { type: 'value' },
    series: [{ data: [1,2,3], type: 'bar' }, { data: [3,2,1], type: 'line' }] });
});
</script>
<template>
  <div class="min-h-screen bg-base-200 p-8">
    <div class="navbar bg-base-100"><House class="size-5"/><Search class="size-5"/><Settings class="size-5"/><ChartBar class="size-5"/></div>
    <div class="card bg-base-100 shadow"><div class="card-body"><div ref="el" style="height:320px"></div></div></div>
  </div>
</template>
`;

const APP_SEED = `<script setup lang="ts">
import { House } from 'lucide-vue-next';
</script>
<template><main class="p-8"><House class="size-10 text-primary"/><h1 class="text-2xl font-bold">Hello</h1></main></template>
`;

export class ProbeContainer extends DurableObject<Env> {
  #monitorAttached = false;

  /** containers.md: attach monitor() or `.running` goes stale and the DO wedges. */
  #ensureMonitor() {
    if (this.#monitorAttached || !this.ctx.container) return;
    this.ctx.container.monitor().catch(() => { /* container exited; next start boots fresh */ });
    this.#monitorAttached = true;
  }

  async #cmd(path: string, body?: unknown): Promise<Response> {
    const req = new Request(`http://cmd.local${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return this.ctx.container!.getTcpPort(CMD_PORT).fetch(req);
  }

  async #exec(cmd: string, args: string[]): Promise<{ code: number; stderr: string; stdout: string }> {
    const res = await this.#cmd('/exec', { cmd, args });
    return res.json<{ code: number; stderr: string; stdout: string }>();
  }

  /**
   * @param withDep  install one big user dep (echarts) before building
   */
  async probe(withDep: boolean): Promise<{ steps: Step[]; totalMs: number; error?: string; containerColo?: string }> {
    const steps: Step[] = [];
    if (!this.ctx.container) return { steps, totalMs: 0, error: 'no container binding' };

    // Force a genuinely cold instance: tear down anything left from a prior probe.
    try { await this.ctx.container.destroy(); } catch { /* nothing running */ }

    const t0 = Date.now();
    try {
      // ---- 1. cold start → command channel ready -------------------------------
      this.#ensureMonitor();
      this.ctx.container.start({ enableInternet: true });
      let ready = false;
      while (Date.now() - t0 < READY_TIMEOUT_MS) {
        try {
          const r = await this.#cmd('/healthz');   // await = real I/O = clock advances
          if (r.ok) { ready = true; break; }
        } catch { /* still provisioning/booting — retry */ }
      }
      if (!ready) return { steps, totalMs: Date.now() - t0, error: 'container never became ready' };
      const tReady = Date.now();
      steps.push({ step: '1-cold-start', ms: tReady - t0 });

      // The build-box has no dev server; stop the image's vite child so it does not
      // compete for the (limited) vCPU during the build.
      await this.#cmd('/vite/stop').catch(() => {});
      const tStopped = Date.now();

      // ---- 2. restore source ----------------------------------------------------
      await this.#cmd('/apply', {
        files: [{ path: 'src/App.vue', content: withDep ? APP_WITH_CHART : APP_SEED }],
      });
      const tApplied = Date.now();
      steps.push({ step: '2-restore-source', ms: tApplied - tStopped });

      // ---- 3. npm install (only when the user added a dep) ----------------------
      let tInstalled = tApplied;
      if (withDep) {
        const r = await this.#exec('npm', ['install', '--no-audit', '--no-fund', 'echarts']);
        tInstalled = Date.now();
        steps.push({ step: '3-npm-install', ms: tInstalled - tApplied, detail: `exit=${r.code}` });
      } else {
        steps.push({ step: '3-npm-install', ms: 0, detail: 'baked — nothing to install' });
      }

      // ---- 4. vite build --------------------------------------------------------
      const build = await this.#exec('npx', ['vite', 'build']);
      const tBuilt = Date.now();
      steps.push({
        step: '4-vite-build',
        ms: tBuilt - tInstalled,
        detail: build.code === 0 ? 'ok' : `FAILED exit=${build.code}: ${build.stderr.slice(0, 300)}`,
      });

      // ---- 5. return results ----------------------------------------------------
      const tar = await this.#exec('sh', ['-c', 'tar czf - dist | base64 -w0 | wc -c']);
      const tReturned = Date.now();
      steps.push({ step: '5-return-dist', ms: tReturned - tBuilt, detail: 'tar+b64 of dist' });

      // ---- where did this actually RUN? -----------------------------------------
      // Ask the container itself which CF colo its egress lands in — a direct read of
      // container placement, rather than inferring it from the caller's entry PoP.
      // node:22-slim has no curl, but node 22 has global fetch.
      let containerColo = 'unknown';
      try {
        const r = await this.#exec('node', ['-e',
          "fetch('https://www.cloudflare.com/cdn-cgi/trace').then(r=>r.text()).then(t=>console.log((t.match(/colo=(\\w+)/)||[])[1]||'?'))"]);
        containerColo = r.stdout?.trim() || 'unknown';
      } catch { /* placement read is best-effort — never fail the probe for it */ }

      return { steps, totalMs: tReturned - t0, containerColo };
    } catch (e) {
      return { steps, totalMs: Date.now() - t0, error: String((e as Error)?.stack ?? e) };
    }
  }

  async teardown() {
    try { await this.ctx.container?.destroy(); } catch { /* already gone */ }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/probe') {
      const withDep = url.searchParams.get('dep') === '1';
      // A fresh DO id per run ⇒ cold DO + cold container, which is the case we care about.
      const id = env.PROBE.newUniqueId();
      const stub = env.PROBE.get(id);
      const entryColo = (request.cf as { colo?: string } | undefined)?.colo ?? 'unknown';
      const result = await stub.probe(withDep);
      await stub.teardown();
      return Response.json({ withDep, entryColo, ...result }, { headers: { 'content-type': 'application/json' } });
    }
    return new Response('POST /probe?dep=0|1\n', { status: 200 });
  },
} satisfies ExportedHandler<Env>;
