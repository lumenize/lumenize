# Minimal container for the local-dev matrix experiment: a trivial HTTP server on
# 8080, no npm install (node:22-slim base is already pulled), so the image build is
# ~instant and the only variable under test is wrangler-dev container networking.
FROM node:22-slim
EXPOSE 8080
CMD ["node","-e","require('http').createServer((q,s)=>{s.writeHead(200);s.end('hello from container');}).listen(8080,()=>console.log('up on 8080'))"]
