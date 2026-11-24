import base from './vite.config.ts';

// The same build with Rolldown's JSDoc comments dropped, which it keeps by default and esbuild (wrangler) does not.
// Legal and annotation comments stay, as esbuild keeps them.
export default { ...base, build: { rolldownOptions: { output: { comments: { legal: true, annotation: true, jsdoc: false } } } } };
