/**
 * Q1 — Vue createApp + jsdom smoke.
 *
 * Validates the foundational claim: Vue 3 in-DOM mode (no SFC build step,
 * template strings + `v-*` directives) works inside jsdom. If this fails, the
 * rest of the Vue layer is moot. Pure Vue — no factory/client.
 */
import { describe, it, expect } from 'vitest';
import { loadVue } from './vue-harness';

describe('Q1 — Vue createApp + jsdom', () => {
  it('mounts a component, renders ref value, re-renders on ref change', async () => {
    const Vue = await loadVue();
    const { createApp, ref, nextTick } = Vue;

    document.body.innerHTML = `<div id="app">{{ count }}</div>`;
    const count = ref(0);
    const app = createApp({
      setup() {
        return { count };
      },
    });
    app.mount('#app');

    expect(document.getElementById('app')!.textContent).toBe('0');

    count.value = 42;
    await nextTick();
    expect(document.getElementById('app')!.textContent).toBe('42');

    count.value = 100;
    await nextTick();
    expect(document.getElementById('app')!.textContent).toBe('100');

    app.unmount();
  });

  it('compiles + renders a registered child component with props', async () => {
    const Vue = await loadVue();
    const { createApp, ref, nextTick } = Vue;

    document.body.innerHTML = `<div id="app"><greet :name="who" /></div>`;
    const who = ref('world');
    const app = createApp({
      setup() {
        return { who };
      },
    });
    app.component('greet', {
      props: ['name'],
      template: `<span class="greeting">hello, {{ name }}!</span>`,
    });
    app.mount('#app');

    expect(document.querySelector('.greeting')!.textContent).toBe('hello, world!');

    who.value = 'larry';
    await nextTick();
    expect(document.querySelector('.greeting')!.textContent).toBe('hello, larry!');

    app.unmount();
  });
});
