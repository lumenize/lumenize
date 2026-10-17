// Keeps the Cap'n Web column of website/docs/_partials/_type-support-table.mdx
// honest. Each row's cell is read from the table itself and checked against
// what the installed capnweb actually does, so a capnweb bump that changes a
// behaviour, or a table edit that misstates one, turns a row red here instead
// of the column going quietly stale.
//
// Cell meanings: ✅ round-trips · ⚠️ arrives, but loses something · ❌ throws.
// For an arrow like ❌→✅ the left side is what the installed release does.
//
// The probes talk to their own RpcTarget over a MessageChannel rather than to
// the DO in src/, whose source is printed on the docs page. Type support lives
// in capnweb's serializer, which is the same whatever the transport.
import { it, expect } from 'vitest';
import { newMessagePortRpcSession, RpcTarget } from 'capnweb';
// @ts-expect-error - Vite resolves ?raw imports; this workspace has no vite/client types
import table from '../../../../website/docs/_partials/_type-support-table.mdx?raw';

type Outcome = 'round-trips' | 'partial' | 'throws' | 'lossy';

const bytes = (s: string) => new TextEncoder().encode(s);

// Fetch messages carry their bodies as streams, so like streams they are
// probed one way at a time, read on the far side and described in a string
const request = () => new Request('https://example.com/r', {
  method: 'POST', headers: { 'x-a': '1' }, body: 'hi',
});
const response = () => new Response('hi', { status: 201, headers: { 'x-a': '1' } });
const REQUEST = 'POST https://example.com/r x-a=1 hi';
const RESPONSE = '201 x-a=1 hi';

async function describe(message: unknown): Promise<string> {
  if (message instanceof Request) {
    return `${message.method} ${message.url} x-a=${message.headers.get('x-a')} ${await message.text()}`;
  }
  if (message instanceof Response) {
    return `${message.status} x-a=${message.headers.get('x-a')} ${await message.text()}`;
  }
  return 'neither a Request nor a Response';
}

class ProbeTarget extends RpcTarget {
  describe(message: unknown) {
    return describe(message);
  }

  makeRequest() {
    return request();
  }

  makeResponse() {
    return response();
  }

  echo(value: unknown) {
    return value;
  }

  throwError(): never {
    throw new Error('Intentional error from ProbeTarget');
  }

  readText(stream: ReadableStream) {
    return new Response(stream).text();
  }

  makeStream(text: string) {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(bytes(text));
        controller.close();
      },
    });
  }

  async writeText(sink: WritableStream, text: string) {
    const writer = sink.getWriter();
    await writer.write(bytes(text));
    await writer.close();
  }
}

function probeSession() {
  const { port1, port2 } = new MessageChannel();
  newMessagePortRpcSession(port1, new ProbeTarget());
  const client: any = newMessagePortRpcSession<ProbeTarget>(port2);
  return {
    client,
    [Symbol.dispose]() {
      client[Symbol.dispose]();
      port1.close();
      port2.close();
    },
  };
}

async function outcomeOf(
  send: () => Promise<any>,
  judge: (got: any) => Outcome | Promise<Outcome>,
): Promise<Outcome> {
  let got: any;
  try {
    got = await send();
  } catch {
    return 'throws';
  }
  return judge(got);
}

const exact = (ok: boolean): Outcome => (ok ? 'round-trips' : 'lossy');

// One probe per table row, keyed by the row's label. A row with no probe fails.
const probes: Record<string, (client: any) => Promise<Outcome>> = {
  'Cycles': (c) => {
    const root: any = { name: 'root' };
    root.self = root;
    return outcomeOf(() => c.echo(root), (got) => exact(got?.self === got));
  },
  // Partial = both references arrive, but as separate copies
  'Aliases': (c) => {
    const shared = { a: 1 };
    return outcomeOf(() => c.echo({ x: shared, y: shared }), (got) => {
      if (got?.x?.a !== 1 || got?.y?.a !== 1) return 'lossy';
      return got.x === got.y ? 'round-trips' : 'partial';
    });
  },
  'undefined': (c) => outcomeOf(() => c.echo(undefined), (got) => exact(got === undefined)),
  'null': (c) => outcomeOf(() => c.echo(null), (got) => exact(got === null)),
  'NaN': (c) => outcomeOf(() => c.echo(NaN), (got) => exact(Number.isNaN(got))),
  'Infinity': (c) => outcomeOf(() => c.echo(Infinity), (got) => exact(got === Infinity)),
  '-Infinity': (c) => outcomeOf(() => c.echo(-Infinity), (got) => exact(got === -Infinity)),
  'BigInt': (c) => outcomeOf(() => c.echo(2n ** 64n), (got) => exact(got === 2n ** 64n)),
  'Date': (c) => {
    const date = new Date('2026-01-02T03:04:05.006Z');
    return outcomeOf(() => c.echo(date), (got) =>
      exact(got instanceof Date && got.getTime() === date.getTime()));
  },
  'RegExp': (c) => outcomeOf(() => c.echo(/a+b/gi), (got) =>
    exact(got instanceof RegExp && got.source === 'a+b' && got.flags === 'gi')),
  'Map': (c) => outcomeOf(() => c.echo(new Map([['k', 1]])), (got) =>
    exact(got instanceof Map && got.get('k') === 1)),
  'Set': (c) => outcomeOf(() => c.echo(new Set([1])), (got) =>
    exact(got instanceof Set && got.has(1))),
  'ArrayBuffer': (c) => outcomeOf(() => c.echo(new Uint8Array([1, 2, 3]).buffer), (got) =>
    exact(got instanceof ArrayBuffer && new Uint8Array(got).join() === '1,2,3')),
  'Uint8Array': (c) => outcomeOf(() => c.echo(new Uint8Array([1, 2, 3])), (got) =>
    exact(got instanceof Uint8Array && got.join() === '1,2,3')),
  // Partial = the message survives but the remote stack doesn't
  'Error (thrown)': (c) => outcomeOf(
    async () => {
      try {
        await c.throwError();
      } catch (e) {
        return e;
      }
      throw new Error('throwError() did not throw');
    },
    (e) => {
      if (!(e instanceof Error) || !e.message.includes('Intentional error')) return 'lossy';
      return e.stack?.includes('throwError') ? 'round-trips' : 'partial';
    },
  ),
  // Partial = the message survives but the name or the original stack doesn't
  'Error (value)': (c) => {
    class CustomError extends Error {
      constructor(message: string) {
        super(message);
        this.name = 'CustomError';
      }
    }
    const error = new CustomError('Test error');
    return outcomeOf(() => c.echo(error), (got) => {
      if (!(got instanceof Error) || got.message !== 'Test error') return 'lossy';
      return got.name === 'CustomError' && got.stack === error.stack ? 'round-trips' : 'partial';
    });
  },
  'Request': (c) => outcomeOf(
    async () => [await c.describe(request()), await describe(await c.makeRequest())],
    ([there, back]) => exact(there === REQUEST && back === REQUEST),
  ),
  'Response': (c) => outcomeOf(
    async () => [await c.describe(response()), await describe(await c.makeResponse())],
    ([there, back]) => exact(there === RESPONSE && back === RESPONSE),
  ),
  'Headers': (c) => outcomeOf(() => c.echo(new Headers({ 'x-a': '1' })), (got) =>
    exact(got instanceof Headers && got.get('x-a') === '1')),
  'URL': (c) => outcomeOf(() => c.echo(new URL('https://example.com/a?b=1')), (got) =>
    exact(got instanceof URL && got.href === 'https://example.com/a?b=1')),
  'CryptoKey': async (c) => {
    const key = await crypto.subtle.generateKey(
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
    );
    const signature = (k: CryptoKey) =>
      crypto.subtle.sign('HMAC', k, bytes('hi')).then((b) => new Uint8Array(b).join());
    return outcomeOf(() => c.echo(key), async (got) =>
      exact(got instanceof CryptoKey && await signature(got) === await signature(key)));
  },
  'Blob': (c) => outcomeOf(() => c.echo(new Blob(['hi'], { type: 'text/plain' })), async (got) =>
    exact(got instanceof Blob && got.type === 'text/plain' && await got.text() === 'hi')),
  // Streams are one-way in real use, so each direction is probed on its own:
  // the other side reads what we send, and we read what it sends
  'ReadableStream': (c) => outcomeOf(
    async () => [
      await c.readText(new ReadableStream({
        start(controller) {
          controller.enqueue(bytes('to server'));
          controller.close();
        },
      })),
      await new Response(await c.makeStream('to client')).text(),
    ],
    ([received, sent]) => exact(received === 'to server' && sent === 'to client'),
  ),
  // Round-trips = the other side's writes reach the sink we sent
  'WritableStream': (c) => {
    const written: string[] = [];
    const sink = new WritableStream({
      write(chunk) {
        written.push(new TextDecoder().decode(chunk));
      },
    });
    return outcomeOf(() => c.writeText(sink, 'hi'), () => exact(written.join('') === 'hi'));
  },
};

function cells(line: string): string[] {
  return line.split('|').slice(1, -1).map((cell) => cell.trim());
}

function expected(cell: string): Outcome {
  const installed = cell.split('→')[0];
  if (installed.includes('⚠️')) return 'partial';
  if (installed.includes('✅')) return 'round-trips';
  if (installed.includes('❌')) return 'throws';
  throw new Error(`Unrecognised Cap'n Web cell "${cell}"`);
}

const tableLines = (table as string).split('\n')
  .filter((line) => line.startsWith('|') && !/^\|[-:\s|]+$/.test(line)); // drop the |---| line
const column = cells(tableLines[0]).indexOf("Cap'n Web");
const rows = tableLines.slice(1)
  .map(cells)
  .map((row) => ({ type: row[0].replace(/\*\*/g, ''), cell: row[column] }))
  .filter((row) => row.cell); // section headings have no cells

it('reads every row of the Cap\'n Web column, one probe per row', () => {
  expect(column).toBeGreaterThan(0);
  expect(rows.map((row) => row.type).sort()).toEqual(Object.keys(probes).sort());
});

it.each(rows)('Cap\'n Web: $type is $cell', async ({ type, cell }) => {
  const probe = probes[type];
  expect(probe, `no probe for table row "${type}"`).toBeDefined();
  using session = probeSession();
  expect(await probe(session.client)).toBe(expected(cell));
});
