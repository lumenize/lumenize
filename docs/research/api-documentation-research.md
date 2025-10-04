# API Documentation Research (Phase 1.2)

**Date**: October 3, 2025  
**Goal**: Select and configure a tool to extract JSDoc comments from TypeScript source code and generate API reference documentation for Docusaurus.

## Requirements

From WIP.md Phase 1.2:

- ✅ Extract JSDoc comments from TypeScript source
- ✅ Generate Docusaurus-compatible markdown/mdx
- ✅ Render call signatures, types, interfaces
- 🤔 Optionally: support runnable examples in JSDoc (or skip)

Additional implicit requirements:
- Must work with monorepo structure (`lumenize/packages/*`)
- Should integrate into existing Docusaurus build process
- Must handle TypeScript features (generics, utility types, etc.)
- Should support cross-linking between packages
- Ideally minimal configuration overhead

## Tools Evaluated

### 1. TypeDoc

**Official Site**: https://typedoc.org/  
**GitHub**: https://github.com/TypeStrong/typedoc  
**Stars**: ~7.8k ⭐  
**Last Updated**: Active (2025)

#### Description
TypeDoc is the de facto standard for TypeScript API documentation. It reads TypeScript source files and JSDoc comments to generate HTML documentation.

#### Key Features
- ✅ **TypeScript-first**: Built specifically for TypeScript
- ✅ **Rich type rendering**: Handles generics, unions, intersections, utility types
- ✅ **Multiple output formats**: HTML (default), JSON, Markdown via plugins
- ✅ **Monorepo support**: Can document multiple packages
- ✅ **Themes**: Customizable themes
- ✅ **Navigation**: Auto-generates navigation hierarchy
- ✅ **Reflection system**: Powerful introspection of TypeScript declarations

#### Integration Options for Docusaurus

**Option A: typedoc-plugin-markdown**
- Plugin: `typedoc-plugin-markdown`
- GitHub: https://github.com/tgreyuk/typedoc-plugin-markdown
- Generates markdown files that Docusaurus can consume
- Actively maintained
- ~1.5k stars

**Option B: docusaurus-plugin-typedoc**  
- Plugin: `docusaurus-plugin-typedoc`
- GitHub: https://github.com/tgreyuk/typedoc-plugin-markdown/tree/main/packages/docusaurus-plugin-typedoc
- **Recommended**: Purpose-built for Docusaurus integration
- Wraps TypeDoc + typedoc-plugin-markdown
- Handles Docusaurus sidebar generation automatically
- Configuration in `docusaurus.config.js`

#### Example Configuration

```typescript
// docusaurus.config.ts
plugins: [
  [
    'docusaurus-plugin-typedoc',
    {
      // TypeDoc options
      entryPoints: [
        '../packages/rpc/src/index.ts',
        '../packages/utils/src/index.ts',
        '../packages/testing/src/index.ts',
      ],
      tsconfig: '../packages/rpc/tsconfig.json',
      
      // Output options
      out: 'docs/api',
      sidebar: {
        categoryLabel: 'API Reference',
        position: 10,
      },
      
      // Rendering options
      readme: 'none',
      disableSources: false,
      excludePrivate: true,
      excludeProtected: false,
      excludeInternal: true,
    },
  ],
],
```

#### Pros
- ✅ Industry standard for TypeScript
- ✅ Excellent TypeScript support (handles complex types)
- ✅ Active development and community
- ✅ Docusaurus integration plugin exists
- ✅ Automatic sidebar generation
- ✅ Supports monorepo via multiple entry points
- ✅ Good default styling
- ✅ Can run during Docusaurus build

#### Cons
- ⚠️ Markdown output can be verbose
- ⚠️ Limited customization of markdown structure
- ⚠️ No built-in support for runnable examples in JSDoc
- ⚠️ May need custom styling to match Docusaurus theme

#### Verdict
**⭐ RECOMMENDED** - Best fit for our needs. Mature, well-maintained, purpose-built for TypeScript + Docusaurus.

---

### 2. API Extractor (@microsoft/api-extractor)

**Official Site**: https://api-extractor.com/  
**GitHub**: https://github.com/microsoft/rushstack/tree/main/apps/api-extractor  
**Stars**: ~5.8k ⭐ (rushstack monorepo)  
**Last Updated**: Active (Microsoft maintains)

#### Description
Microsoft's tool for analyzing TypeScript libraries and generating API reports, .d.ts rollups, and API documentation models.

#### Key Features
- ✅ **API review workflow**: Generates API reports for tracking breaking changes
- ✅ **.d.ts rollup**: Generates single .d.ts file for package
- ✅ **API documentation model**: Outputs JSON model of API
- ✅ **TSDoc support**: Uses Microsoft's TSDoc standard (enhanced JSDoc)
- ✅ **Monorepo-friendly**: Part of Rush Stack
- ⚠️ **Not a doc generator**: Needs separate tool to render docs

#### Integration Path
API Extractor → API Documenter → Markdown → Docusaurus

1. Run `api-extractor` to generate `.api.json` files
2. Run `api-documenter` to convert to markdown
3. Copy markdown to Docusaurus docs folder

#### Example Configuration

```json
// api-extractor.json
{
  "mainEntryPointFilePath": "<projectFolder>/lib/index.d.ts",
  "apiReport": {
    "enabled": true,
    "reportFolder": "<projectFolder>/etc/"
  },
  "docModel": {
    "enabled": true,
    "apiJsonFilePath": "<projectFolder>/dist/<unscopedPackageName>.api.json"
  }
}
```

#### Pros
- ✅ Microsoft-backed (likely long-term support)
- ✅ API review workflow for detecting breaking changes
- ✅ Generates .d.ts rollups (useful for package consumers)
- ✅ TSDoc support (richer than JSDoc)
- ✅ Good for large enterprises with strict API governance

#### Cons
- ❌ Two-step process (extractor → documenter)
- ❌ More complex setup than TypeDoc
- ❌ Requires building .d.ts files first (extra build step)
- ❌ No direct Docusaurus integration
- ⚠️ Overkill for smaller projects
- ⚠️ Generated markdown less polished than TypeDoc

#### Verdict
**Not Recommended** - Too complex for our needs. Better suited for large enterprises with API governance requirements. We don't need .d.ts rollups or API reports.

---

### 3. TypeDoc with Custom Plugins

**Approach**: Use TypeDoc core + custom plugins for specific needs

#### Available Plugins
- `typedoc-plugin-markdown` - Markdown output (covered above)
- `typedoc-plugin-merge-modules` - Merge modules for cleaner structure
- `typedoc-plugin-missing-exports` - Auto-discover missing exports
- `typedoc-plugin-extras` - Additional features (favicon, CSS, etc.)
- `typedoc-plugin-versions` - Multi-version documentation

#### Custom Plugin Development
TypeDoc has a plugin API for custom transformations:
```typescript
import { Application, Converter } from 'typedoc';

export function load(app: Application) {
  app.converter.on(Converter.EVENT_RESOLVE_BEGIN, (context) => {
    // Custom transformation logic
  });
}
```

#### Use Cases for Custom Plugins
- Add "Copy to Clipboard" buttons to code examples
- Inject testable code block metadata
- Link to source code on GitHub
- Add custom frontmatter for Docusaurus

#### Verdict
**Future Enhancement** - Start with `docusaurus-plugin-typedoc`, add custom plugins if needed.

---

### 4. Documentation.js

**GitHub**: https://github.com/documentationjs/documentation  
**Stars**: ~5.8k ⭐  
**Last Updated**: ⚠️ Limited activity (2023)

#### Description
General-purpose documentation tool for JavaScript/TypeScript. Uses JSDoc comments.

#### Key Features
- ✅ JavaScript/TypeScript support
- ✅ Multiple output formats (HTML, Markdown, JSON)
- ✅ Simple configuration
- ⚠️ TypeScript support via `@typescript-eslint/parser`
- ⚠️ Less sophisticated than TypeDoc for TS types

#### Pros
- ✅ Simple to use
- ✅ Markdown output built-in
- ✅ Good for simple JavaScript projects

#### Cons
- ❌ TypeScript support is second-class (via parser plugin)
- ❌ Doesn't handle complex TypeScript types well
- ❌ Less active development
- ❌ No Docusaurus-specific integration
- ❌ Inferior to TypeDoc for TypeScript

#### Verdict
**Not Recommended** - Superseded by TypeDoc for TypeScript projects.

---

### 5. TSDoc + Custom Solution

**Approach**: Use TSDoc parser directly and build custom generator

**TSDoc**: https://tsdoc.org/ (Microsoft's JSDoc successor)

#### What is TSDoc?
- Standardized format for TypeScript doc comments
- Richer tag set than JSDoc (`@remarks`, `@example`, `@typeParam`, etc.)
- Parser library: `@microsoft/tsdoc`

#### Custom Generator Approach
```typescript
import * as ts from 'typescript';
import { TSDocParser } from '@microsoft/tsdoc';

// 1. Parse TypeScript with ts.createProgram()
// 2. Visit each node with TSDocParser
// 3. Extract comments + type information
// 4. Generate markdown with custom templates
```

#### Pros
- ✅ Full control over output format
- ✅ Can integrate with testable docs system
- ✅ Tailored exactly to our needs
- ✅ Learning experience

#### Cons
- ❌ Significant development effort (weeks, not hours)
- ❌ Maintenance burden (TypeScript version updates)
- ❌ Reinventing the wheel
- ❌ TypeDoc already solves 95% of this
- ❌ Would delay documentation release

#### Verdict
**Not Recommended** - Only consider if TypeDoc proves inadequate. Not a good use of time when TypeDoc exists.

---

## Comparison Matrix

| Feature | TypeDoc + Docusaurus Plugin | API Extractor | Documentation.js | Custom TSDoc |
|---------|---------------------------|---------------|------------------|--------------|
| **TypeScript Support** | ⭐⭐⭐⭐⭐ Excellent | ⭐⭐⭐⭐⭐ Excellent | ⭐⭐⭐ Good | ⭐⭐⭐⭐⭐ Perfect |
| **Docusaurus Integration** | ⭐⭐⭐⭐⭐ Native plugin | ⭐⭐ Manual | ⭐⭐ Manual | ⭐⭐⭐⭐ Custom |
| **Setup Complexity** | ⭐⭐⭐⭐ Easy | ⭐⭐ Complex | ⭐⭐⭐⭐ Easy | ⭐ Very Hard |
| **Maintenance** | ⭐⭐⭐⭐⭐ Active | ⭐⭐⭐⭐ Active | ⭐⭐ Slow | ⭐ High Burden |
| **Monorepo Support** | ⭐⭐⭐⭐ Good | ⭐⭐⭐⭐⭐ Excellent | ⭐⭐⭐ OK | ⭐⭐⭐⭐ Custom |
| **Output Quality** | ⭐⭐⭐⭐ Good | ⭐⭐⭐ OK | ⭐⭐⭐ OK | ⭐⭐⭐⭐⭐ Perfect |
| **Community** | ⭐⭐⭐⭐⭐ Large | ⭐⭐⭐⭐ Microsoft | ⭐⭐⭐ Medium | ⭐ None |
| **Time to Implement** | 🟢 1-2 hours | 🟡 4-8 hours | 🟢 2-4 hours | 🔴 2-4 weeks |

---

## Recommendation: TypeDoc with docusaurus-plugin-typedoc

### Why TypeDoc?

1. **Perfect for TypeScript**: Built specifically for TypeScript, handles all type system features
2. **Docusaurus Integration**: `docusaurus-plugin-typedoc` provides seamless integration
3. **Active Community**: Large community, active development, frequent updates
4. **Low Effort, High Value**: Can be set up in 1-2 hours with good results
5. **Monorepo Support**: Handles multiple packages via entry points
6. **Extensible**: Plugin system if we need customization later

### Implementation Plan (Phase 3)

**Phase 3.1: Configure TypeDoc**
```bash
# Install dependencies
cd website
npm install --save-dev typedoc typedoc-plugin-markdown docusaurus-plugin-typedoc

# Configure in docusaurus.config.ts (see example above)

# Generate docs
npm run build  # Plugin runs during Docusaurus build
```

**Phase 3.2: Styling & Customization**
- Review generated markdown
- Add custom CSS if needed to match theme
- Configure TypeDoc options (e.g., `excludePrivate`, `categorizeByGroup`)
- Set up sidebar structure

**Phase 3.3: Multi-Package Setup**
- Configure separate entry points for each package
- Organize output: `docs/api/rpc/`, `docs/api/utils/`, etc.
- Add package-level READMEs to API docs

### Example Output Structure
```
website/docs/
├── intro.mdx
├── rpc/
│   ├── quick-start.mdx          # Testable guides
│   ├── manual-instrumentation.mdx
│   └── ...
├── api/                          # Generated API docs
│   ├── rpc/
│   │   ├── README.md
│   │   ├── classes/
│   │   │   ├── RpcClient.md
│   │   │   └── ...
│   │   ├── functions/
│   │   │   ├── createRpcClient.md
│   │   │   └── ...
│   │   └── interfaces/
│   │       └── RpcOptions.md
│   ├── utils/
│   │   └── ...
│   └── testing/
│       └── ...
```

---

## Runnable Examples in JSDoc

### Question: Should API docs include runnable examples?

**Option 1: Skip runnable examples in API docs**
- API docs focus on signatures, parameters, return types
- Runnable examples live in guides (e.g., `quick-start.mdx`)
- Clearer separation: guides = narrative, API = reference
- **Recommended** ✅

**Option 2: Include @example tags, but not testable**
```typescript
/**
 * Creates an RPC client
 * @example
 * ```typescript
 * const client = createRpcClient<MyDO>({
 *   doBindingName: 'MY_DO',
 *   doInstanceNameOrId: 'test-123',
 * });
 * ```
 */
```
- TypeDoc renders @example blocks as code
- Not extracted or tested
- Can get out of sync with actual API

**Option 3: Link from API docs to testable guides**
```typescript
/**
 * Creates an RPC client
 * @see {@link /docs/rpc/quick-start | Quick Start Guide} for runnable examples
 */
```
- Best of both worlds
- API docs stay focused
- Examples are tested and up-to-date
- **Recommended if we use @example tags** ✅

### Recommendation
Start with **Option 1** (no examples in API docs). Add **Option 3** (links to guides) if we find users need more guidance in API reference.

---

## Alternative Considered: API Docs as Code

**Idea**: Write API docs as `.mdx` files (like guides), manually maintained

**Pros**:
- Full control over structure and narrative
- Can include testable examples
- More tutorial-like

**Cons**:
- Manual maintenance (high burden)
- Can get out of sync with code
- Doesn't scale to large APIs
- Duplicates effort (JSDoc + manual docs)

**Verdict**: ❌ Not recommended. Use auto-generated API docs from JSDoc.

---

## Next Steps

1. **Get approval** on TypeDoc + docusaurus-plugin-typedoc approach
2. **Phase 3.1**: Install and configure TypeDoc for @lumenize/rpc
3. **Phase 3.2**: Review output and adjust configuration
4. **Phase 3.3**: Extend to other packages (utils, testing)
5. **Iterate**: Refine based on user feedback

---

## References

- TypeDoc: https://typedoc.org/
- docusaurus-plugin-typedoc: https://github.com/tgreyuk/typedoc-plugin-markdown/tree/main/packages/docusaurus-plugin-typedoc
- TSDoc: https://tsdoc.org/
- API Extractor: https://api-extractor.com/
- Documentation.js: https://documentation.js.org/

---

**Status**: ✅ Research complete, ready for checkpoint review!
