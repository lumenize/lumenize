import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';
import { docTestPlugin } from '@lumenize/doc-testing';
import checkExamplesPlugin from '@lumenize/docusaurus-plugin-check-examples';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: 'Lumenize',
  tagline: 'De✨light✨ful Developer eXperience (DDX) on Cloudflare Durable Objects',
  favicon: 'img/favicon.ico',

  // Future flags, see https://docusaurus.io/docs/api/docusaurus-config#future
  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  // Set the production url of your site here
  url: 'https://lumenize.com',
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: '/',

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: 'lumenize', // Usually your GitHub org/user name.
  projectName: 'lumenize', // Usually your repo name.

  onBrokenLinks: 'throw',

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  plugins: [
    [
        'docusaurus-plugin-typedoc',
        {
          entryPoints: ['../packages/rpc/src/index.ts'],
          tsconfig: '../packages/rpc/tsconfig.json',
          out: 'docs/rpc/api',
          sidebar: {
            autoConfiguration: true,
          },
          plugin: ['typedoc-plugin-markdown', 'typedoc-docusaurus-theme'],
          excludeInternal: true,
          excludeExternals: true,
          excludePrivate: true,
          readme: 'none',
          hideBreadcrumbs: true, // Hide the TypeDoc breadcrumbs
        },
      ],
      [
        'docusaurus-plugin-typedoc',
        {
          id: 'utils',
          entryPoints: ['../packages/utils/src/index.ts'],
          tsconfig: '../packages/utils/tsconfig.json',
          out: 'docs/utils/api',
          sidebar: {
            autoConfiguration: true,
          },
          plugin: ['typedoc-plugin-markdown', 'typedoc-docusaurus-theme'],
          excludeInternal: true,
          excludeExternals: true,
          excludePrivate: true,
          readme: 'none',
          hideBreadcrumbs: true, // Hide the TypeDoc breadcrumbs
        },
      ],
      [
        'docusaurus-plugin-typedoc',
        {
          id: 'testing',
          entryPoints: ['../packages/testing/src/index.ts'],
          tsconfig: '../packages/testing/tsconfig.json',
          out: 'docs/testing/api',
          sidebar: {
            autoConfiguration: true,
          },
          plugin: ['typedoc-plugin-markdown', 'typedoc-docusaurus-theme'],
          excludeInternal: true,
          excludeExternals: true,
          excludePrivate: true,
          readme: 'none',
          hideBreadcrumbs: true, // Hide the TypeDoc breadcrumbs
        },
      ],
      [
        'docusaurus-plugin-typedoc',
        {
          id: 'proxy-fetch',
          entryPoints: ['../packages/proxy-fetch/src/index.ts'],
          tsconfig: '../packages/proxy-fetch/tsconfig.json',
          out: 'docs/proxy-fetch/api',
          sidebar: {
            autoConfiguration: true,
          },
          plugin: ['typedoc-plugin-markdown', 'typedoc-docusaurus-theme'],
          excludeInternal: true,
          excludeExternals: true,
          excludePrivate: true,
          readme: 'none',
          hideBreadcrumbs: true, // Hide the TypeDoc breadcrumbs
        },
      ],
      // Doc-test plugin - generates docs from test files
      [
        docTestPlugin,
        {
          verbose: true,
          injectNotice: true,
        },
      ],
      // Check-examples plugin - verifies hand-written doc examples
      [
        checkExamplesPlugin,
        {
          // Options can be added later if needed
        },
      ],
  ],

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          // Please change this to your repo.
          // Remove this to remove the "edit this page" links.
          editUrl: 'https://github.com/lumenize/lumenize/tree/main/website/',
        },
        blog: {
          showReadingTime: true,
          feedOptions: {
            type: ['rss', 'atom'],
            xslt: true,
          },
          // Please change this to your repo.
          // Remove this to remove the "edit this page" links.
          editUrl: 'https://github.com/lumenize/lumenize/tree/main/website/',
          // Useful options to enforce blogging best practices
          onInlineTags: 'warn',
          onInlineAuthors: 'warn',
          onUntruncatedBlogPosts: 'warn',
        },
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  // Enable Mermaid and configure Markdown hooks
  markdown: {
    mermaid: true,
    hooks: {
      onBrokenMarkdownLinks: 'warn',
    },
  },
  themes: ['@docusaurus/theme-mermaid'],

  themeConfig: {
    // Replace with your project's social card
    image: 'img/docusaurus-social-card.jpg',
    navbar: {
      title: 'Lumenize',
      logo: {
        alt: 'Lumenize Logo',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {to: '/blog', label: 'Blog', position: 'left'},
        {
          href: 'https://github.com/lumenize/lumenize',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'What is Lumenize?',
              to: '/docs/introduction#what-is-lumenize',
            },
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'Discord',
              href: 'https://discordapp.com/invite/lumenize',
            },
          ],
        },
        {
          title: 'More',
          items: [
            {
              label: 'Blog',
              to: '/blog',
            },
            {
              label: 'GitHub',
              href: 'https://github.com/lumenize/lumenize',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} Lumenize`,
    },
    colorMode: {
      defaultMode: 'light',
      disableSwitch: false,
      respectPrefersColorScheme: true,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
