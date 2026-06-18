// Trivial container process for the Phase-0 smoke. The DO never starts the
// container (the smoke only constructs the DO + drives one mesh call + reads
// storage), but the image must build + push for the CI deploy gate, and a valid
// long-running process keeps the image healthy if the platform probes it.
import http from 'node:http';

http
  .createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('container-node-phase0 smoke container');
  })
  .listen(8080, () => console.log('[phase0] listening on 8080'));
