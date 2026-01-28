#!/usr/bin/env node

/**
 * Removes @skip-check and @skip-check-approved annotations from code blocks
 * that are now auto-skipped by the check-examples plugin.
 *
 * Usage: node scripts/cleanup-skip-annotations.mjs [--dry-run]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

const AUTO_SKIP_LANGUAGES = new Set([
  'bash',
  'sh',
  'shell',
  'zsh',
  'mermaid',
  'text',
  'txt',
  'plain',
  'diff',
  'markdown',
  'md',
  'yaml',
  'yml',
  'toml',
  'ini',
  'csv',
  'sql',
  'graphql',
  'gql',
  'json',
  'jsonc',
]);

const dryRun = process.argv.includes('--dry-run');

function findMdxFiles(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMdxFiles(fullPath));
    } else if (entry.name.endsWith('.mdx')) {
      files.push(fullPath);
    }
  }
  return files;
}

function cleanupFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  let modified = false;
  const changes = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match code block start with language and skip annotation
    const match = line.match(/^(```(\w+))\s+(@skip-check(?:-approved)?(?:\([^)]*\))?)\s*$/);
    if (match) {
      const [, fence, lang, annotation] = match;

      if (AUTO_SKIP_LANGUAGES.has(lang.toLowerCase())) {
        // Remove the annotation, keep just the fence with language
        lines[i] = fence;
        modified = true;
        changes.push({ line: i + 1, lang, annotation });
      }
    }
  }

  if (modified) {
    if (dryRun) {
      console.log(`\n${filePath}:`);
      for (const change of changes) {
        console.log(`  Line ${change.line}: \`\`\`${change.lang} ${change.annotation} → \`\`\`${change.lang}`);
      }
    } else {
      fs.writeFileSync(filePath, lines.join('\n'));
      console.log(`${filePath}: removed ${changes.length} annotation(s)`);
    }
  }

  return changes.length;
}

// Main
const docsDir = path.join(process.cwd(), 'website/docs');
const files = findMdxFiles(docsDir);

let totalChanges = 0;
for (const file of files) {
  totalChanges += cleanupFile(file);
}

if (dryRun) {
  console.log(`\n${totalChanges} annotation(s) would be removed. Run without --dry-run to apply.`);
} else {
  console.log(`\nRemoved ${totalChanges} annotation(s).`);
}
