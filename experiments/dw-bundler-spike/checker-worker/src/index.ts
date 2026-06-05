import { WorkerEntrypoint } from 'cloudflare:workers';
// @ts-expect-error — no declaration file for minified tsc bundle
import ts from '../../dist/typescript.min.mjs';
import libMinimalDts from '../../dist/lib.minimal.bundle';

let cachedProgram: any = null;
const fileMap = new Map<string, string>();
let host: any = null;
let firstCallDone = false;

fileMap.set('lib.d.ts', libMinimalDts);

function createVirtualHost(files: Map<string, string>) {
  return {
    getSourceFile(fileName: string, languageVersion: any) {
      const content = files.get(fileName);
      if (content !== undefined) {
        return (ts as any).createSourceFile(fileName, content, languageVersion, true);
      }
      return undefined;
    },
    writeFile() {},
    getDefaultLibFileName: () => 'lib.d.ts',
    useCaseSensitiveFileNames: () => true,
    getCanonicalFileName: (f: string) => f,
    getCurrentDirectory: () => '/',
    getNewLine: () => '\n',
    fileExists: (f: string) => files.has(f),
    readFile: (f: string) => files.get(f),
    directoryExists: () => true,
    getDirectories: () => [],
  };
}

const compilerOptions = {
  strict: true,
  noEmit: true,
  target: (ts as any).ScriptTarget.ESNext,
  module: (ts as any).ModuleKind.ESNext,
  skipLibCheck: true,
};

export class TscChecker extends WorkerEntrypoint {
  check(typeDefinitions: string, objectLiteral: string, typeName: string) {
    const code = typeDefinitions + '\nconst __validate: ' + typeName + ' = ' + objectLiteral + ';';
    fileMap.set('check.ts', code);

    if (!host) {
      host = createVirtualHost(fileMap);
    }

    const program = (ts as any).createProgram(['check.ts'], compilerOptions, host, cachedProgram);
    cachedProgram = program;

    const sourceFile = program.getSourceFile('check.ts');
    const diagnostics = (ts as any).getPreEmitDiagnostics(program, sourceFile);

    const errors = diagnostics.map((d: any) => ({
      message: (ts as any).flattenDiagnosticMessageText(d.messageText, '\n'),
      code: d.code,
      category: d.category,
    }));

    const isFirstCall = !firstCallDone;
    firstCallDone = true;

    return { isFirstCall, errorCount: errors.length, errors, tsVersion: (ts as any).version };
  }

  ping() {
    return { ok: true, tsVersion: (ts as any).version };
  }
}

export default {
  async fetch() { return new Response('tsc-checker-worker ok'); },
};
