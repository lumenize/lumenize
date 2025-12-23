import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

// Import TypeDoc sidebars - these may not exist on first build
// Note: TypeDoc plugin exports the items array directly, not an object with items property
let typedocRpcSidebar: any[] = [];
let typedocUtilsSidebar: any[] = [];
let typedocTestingSidebar: any[] = [];
let typedocFetchSidebar: any[] = [];
let typedocStructuredCloneSidebar: any[] = [];
let typedocAlarmsSidebar: any[] = [];
let typedocLumenizeBaseSidebar: any[] = [];

try {
  typedocRpcSidebar = require('./docs/rpc/api/typedoc-sidebar.cjs');
  console.log('✅ Loaded rpc sidebar, items:', typedocRpcSidebar?.length);
} catch (e) {
  console.warn('⚠️  TypeDoc rpc sidebar not yet generated, using empty sidebar');
}

try {
  typedocUtilsSidebar = require('./docs/utils/api/typedoc-sidebar.cjs');
  console.log('✅ Loaded utils sidebar, items:', typedocUtilsSidebar?.length);
} catch (e) {
  console.warn('⚠️  TypeDoc utils sidebar not yet generated, using empty sidebar');
}

try {
  typedocTestingSidebar = require('./docs/testing/api/typedoc-sidebar.cjs');
  console.log('✅ Loaded testing sidebar, items:', typedocTestingSidebar?.length);
} catch (e) {
  console.warn('⚠️  TypeDoc testing sidebar not yet generated, using empty sidebar');
}

try {
  typedocFetchSidebar = require('./docs/fetch/api/typedoc-sidebar.cjs');
  console.log('✅ Loaded fetch sidebar, items:', typedocFetchSidebar?.length);
} catch (e) {
  console.warn('⚠️  TypeDoc fetch sidebar not yet generated, using empty sidebar');
}

try {
  typedocStructuredCloneSidebar = require('./docs/structured-clone/api/typedoc-sidebar.cjs');
  console.log('✅ Loaded structured-clone sidebar, items:', typedocStructuredCloneSidebar?.length);
} catch (e) {
  console.warn('⚠️  TypeDoc structured-clone sidebar not yet generated, using empty sidebar');
}

try {
  typedocAlarmsSidebar = require('./docs/alarms/api/typedoc-sidebar.cjs');
  console.log('✅ Loaded alarms sidebar, items:', typedocAlarmsSidebar?.length);
} catch (e) {
  console.warn('⚠️  TypeDoc alarms sidebar not yet generated, using empty sidebar');
}

try {
  typedocLumenizeBaseSidebar = require('./docs/lumenize-base/api/typedoc-sidebar.cjs');
  console.log('✅ Loaded lumenize-base sidebar, items:', typedocLumenizeBaseSidebar?.length);
} catch (e) {
  console.warn('⚠️  TypeDoc lumenize-base sidebar not yet generated, using empty sidebar');
}

/**
 * Recursively transform TypeDoc sidebar items to customize labels.
 */
function transformTypeDocSidebar(items: any[]): any[] {
  if (!items || !Array.isArray(items)) {
    return [];
  }
  
  return items.map((item) => {
    if (item.type === 'category') {
      const newItem = { ...item };
      // Change "Type Aliases" to "Type Utilities"
      if (item.label === 'Type Aliases') {
        newItem.label = 'Type Utilities';
      }
      // Recursively transform child items
      if (item.items) {
        newItem.items = transformTypeDocSidebar(item.items);
      }
      return newItem;
    }
    return item;
  });
}

/**
 * Transform structured-clone sidebar to highlight main functions and group specialized ones.
 */
function transformStructuredCloneSidebar(items: any[]): any[] {
  if (!items || !Array.isArray(items)) {
    return [];
  }
  
  const mainFunctions = ['stringify', 'parse', 'preprocess', 'postprocess'];
  const result: any[] = [];
  const specializedFunctions: any[] = [];
  
  items.forEach((item) => {
    if (item.type === 'category' && item.label === 'Functions') {
      // Split functions into main and specialized
      const orderedMain: any[] = [];
      
      // First, collect all function items
      item.items?.forEach((funcItem: any) => {
        const funcName = funcItem.id?.split('/').pop()?.replace(/\.md$/, '');
        if (mainFunctions.includes(funcName || '')) {
          orderedMain.push(funcItem);
        } else {
          specializedFunctions.push(funcItem);
        }
      });
      
      // Sort main functions in the desired order
      orderedMain.sort((a, b) => {
        const aName = a.id?.split('/').pop()?.replace(/\.md$/, '') || '';
        const bName = b.id?.split('/').pop()?.replace(/\.md$/, '') || '';
        return mainFunctions.indexOf(aName) - mainFunctions.indexOf(bName);
      });
      
      // Add ordered main functions first
      result.push(...orderedMain);
      
      // Add specialized functions in a submenu if there are any
      if (specializedFunctions.length > 0) {
        result.push({
          type: 'category',
          label: 'Encoders/Decoders',
          items: specializedFunctions.sort((a, b) => {
            const aLabel = a.label || '';
            const bLabel = b.label || '';
            return aLabel.localeCompare(bLabel);
          }),
        });
      }
    } else {
      // Keep other categories as-is (with normal transformation)
      result.push(item);
    }
  });
  
  return transformTypeDocSidebar(result);
}

/**
 * Wrap TypeDoc items in an "API Reference" category
 */
function wrapInApiReference(items: any[], label: string = 'API Reference', transformer?: (items: any[]) => any[]): any {
  return {
    type: 'category',
    label,
    items: transformer ? transformer(items) : transformTypeDocSidebar(items),
  };
}

/**
 * Creating a sidebar enables you to:
 - create an ordered group of docs
 - render a sidebar for each doc of that group
 - provide next/previous navigation

 The sidebars can be generated from the filesystem, or explicitly defined here.

 Create as many sidebars as you want.
 */
const sidebars: SidebarsConfig = {
  // Option 2: Mix autogenerated sections with manual TypeDoc imports
  docsSidebar: [
    'introduction',

    // Concepts
    {
      type: 'category',
      label: 'Concepts',
      items: [
        'concepts/continuations',
        'concepts/managing-context',
      ],
    },

    // Testing
    {
      type: 'category',
      label: 'Testing',
      items: [
        {
          type: 'doc',
          id: 'testing/usage',
          customProps: {
            docTest: 'doc-test/testing/testing-plain-do/test/usage.test.ts'
          }
        },
        'testing/alarm-simulation',
        {
          type: 'doc',
          id: 'testing/agents',
          customProps: {
            docTest: 'doc-test/testing/testing-agent-with-agent-client/test/agents.test.ts'
          }
        },
        ...(typedocTestingSidebar && typedocTestingSidebar.length > 0
          ? [wrapInApiReference(typedocTestingSidebar, 'API Reference')]
          : []),
      ],
    },
    
    // RPC
    {
      type: 'category',
      label: 'RPC',
      items: [
        'rpc/introduction',
        {
          type: 'doc',
          id: 'rpc/quick-start',
          customProps: {
            docTest: 'doc-test/rpc/quick-start/test/quick-start.test.ts'
          }
        },
        {
          type: 'doc',
          id: 'rpc/operation-chaining-and-nesting',
          customProps: {
            docTest: 'doc-test/rpc/operation-chaining-and-nesting/test/ocan.test.ts'
          }
        },
        'rpc/downstream-messaging',
        'rpc/security-patterns',
        'rpc/capn-web-comparison',
        {
          type: 'doc',
          id: 'rpc/capn-web-comparison-just-works',
          customProps: {
            docTest: 'doc-test/rpc/capn-web-comparison-just-works/test/just-works.test.ts'
          }
        },
        {
          type: 'doc',
          id: 'rpc/capn-web-comparison-basics-and-types',
          customProps: {
            docTest: 'doc-test/rpc/capn-web-comparison-basics-and-types/test/basics-and-types.test.ts'
          }
        },
        {
          type: 'doc',
          id: 'rpc/capn-web-comparison-performance',
          customProps: {
            docTest: 'doc-test/rpc/capn-web-comparison-performance/test/performance.test.ts'
          }
        },
        ...(typedocRpcSidebar && typedocRpcSidebar.length > 0
          ? [wrapInApiReference(typedocRpcSidebar, 'API Reference')]
          : []),
      ],
    },
    
    // Utils
    {
      type: 'category',
      label: 'Utils',
      items: [
        'utils/route-do-request',
        'utils/cors-support',
        ...(typedocUtilsSidebar && typedocUtilsSidebar.length > 0
          ? [wrapInApiReference(typedocUtilsSidebar, 'API Reference')]
          : []),
      ],
    },

    // Structured Clone
    {
      type: 'category',
      label: 'Structured Clone',
      items: [
        'structured-clone/index',
        'structured-clone/maps-and-sets',
        ...(typedocStructuredCloneSidebar && typedocStructuredCloneSidebar.length > 0
          ? [wrapInApiReference(typedocStructuredCloneSidebar, 'API Reference', transformStructuredCloneSidebar)]
          : []),
      ],
    },

    // Fetch
    {
      type: 'category',
      label: 'Fetch',
      items: [
        'fetch/index',
        'fetch/architecture-and-failure-modes',
        ...(typedocFetchSidebar && typedocFetchSidebar.length > 0
          ? [wrapInApiReference(typedocFetchSidebar, 'API Reference')]
          : []),
      ],
    },

    // Lumenize Mesh
    {
      type: 'category',
      label: 'Lumenize Mesh',
      items: [
        'lumenize-mesh/index',
        'lumenize-mesh/auth-integration',
        'lumenize-mesh/client-api',
        'lumenize-mesh/gateway',
      ],
    },

    // LumenizeBase
    {
      type: 'category',
      label: 'LumenizeBase',
      items: [
        'lumenize-base/index',
        'lumenize-base/creating-plugins',
        'lumenize-base/sql',
        'lumenize-base/debug',
        ...(typedocLumenizeBaseSidebar && typedocLumenizeBaseSidebar.length > 0
          ? [wrapInApiReference(typedocLumenizeBaseSidebar, 'API Reference')]
          : []),
      ],
    },

    {
      type: 'category',
      label: 'Alarms',
      items: [
        'alarms/index',
        ...(typedocAlarmsSidebar && typedocAlarmsSidebar.length > 0
          ? [wrapInApiReference(typedocAlarmsSidebar, 'API Reference')]
          : []),
      ],
    },

    // Auth
    {
      type: 'category',
      label: 'Auth',
      items: [
        'auth/index',
      ],
    },

    // Lumenize
    {
      type: 'category',
      label: 'Lumenize',
      items: [
        'lumenize/introduction',
        // ...(typedocLumenizeSidebar && typedocLumenizeSidebar.length > 0
        //   ? [wrapInApiReference(typedocUtilsSidebar, 'API Reference')]
        //   : []),
      ],
    },

  ],
};

export default sidebars;
