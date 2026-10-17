import { createServer } from 'node:http';

createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('container-ok');
}).listen(8080, () => console.log('spike container listening on 8080'));
