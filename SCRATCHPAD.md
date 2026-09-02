# Scratchpad

## Cloudflare Links

- DO lifecycle with diagram:
  https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/

- The Cloudflare WebSocket API is documented in a strange place:
  https://developers.cloudflare.com/durable-objects/api/state

- The DurableObject base class is defined here: 
  https://developers.cloudflare.com/durable-objects/api/base

### What COLO Is This DO In?

- Hit [https://1.1.1.1/cdn-cgi/trace] and check the colo line.

### Multiple Wrangler Configs

You can pass multiple wrangler.jsonc configs to wrangler dev w/ multiple Worker projects talking to each other in local dev:

```bash
wrangler dev --ip=0.0.0.0 -c wrangler.jsonc -c ../other-service/wrangler.jsonc
```

### Multiple workers projects, envs, and preview urls

**`project-a/wrangler.jsonc`**

```jsonc
{
  "name": "project-a",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-29",
  "services": [
    { "binding": "B", "service": "project-b" }
  ],
  "env": {
    "preview": {
      "services": [
        { "binding": "B", "service": "project-b-preview" }
      ]
    }
  }
}
```

**`project-b/wrangler.jsonc`**

```jsonc
{
  "name": "project-b",
  "main": "src/index.ts",
  "compatibility_date": "2026-04-29",
  "env": {
    "preview": {}
  }
}
```

**Deploy commands and resulting URLs**

```bash
# from project-b/ — deploy leaf project first so project-a's binding can resolve
wrangler deploy
# → https://project-b.my-account.workers.dev

wrangler deploy --env preview
# → https://project-b-preview.my-account.workers.dev

# from project-a/
wrangler deploy
# → https://project-a.my-account.workers.dev   (its B binding resolves to project-b)

wrangler deploy --env preview
# → https://project-a-preview.my-account.workers.dev   (its B binding resolves to project-b-preview)
```

## SQLite in Cloudflare

### DO SQLite Storage Engine

DO SQLite Storage engine uses SQLite version 3.53.4 or later.

It seems to now support JSONB (3.45) but not json_pretty (3.46). See the workerd allowlist to confirm what is actually available: https://github.com/cloudflare/workerd/blob/main/src/workerd/util/sqlite.c%2B%2B#L268

For querying against a long list of orgIds use this trick: https://www.powersync.com/blog/sqlite-optimizations-for-ultra-high-performance#strongstrong7-use-json1-functions

### Cloudflare SQLite PRAGMA Commands

https://developers.cloudflare.com/d1/sql-api/sql-statements/#compatible-pragma-statements

### Cloudflare DO SQLite databaseSize

```javascript
let size = ctx.storage.sql.databaseSize;
```

## JSON Merge Patch

Use "application/merge-patch+json" as the media type for patched content... if we even both with Accept headers.

## Miscellaneous

### SVG to PNG

Try this: https://thewebdev.info/2021/03/20/how-to-convert-an-svg-to-an-image-in-the-browser/


### Merging Histograms

https://arxiv.org/pdf/1606.05633.pdf

### MongoDB-like Query

The list below is from my research in 2022. However, now that Cloudflare DOs have the SQLite backend, I think it would be best to use my sql-from-mongo library and maybe update it to support SQLite operators instead of DocumentDB/CosmosDB ones.

- https://github.com/protobi/query - My favorite. Most likely to work in Cloudflare. Has a few early aggregation functions that I don't want but it's implemented as a single javascript file and I can see easily how to remove those. DeepEqual prefers lodash implementation but will fallback to JSON.stringify which is not great. We could substitute it with something like this: https://stackoverflow.com/questions/25456013/javascript-deepequal-comparison/25456134

- https://www.npmjs.com/package/sift - small and very popular but only supports a subset of operators. Missing are ones like $like and $likel

- https://github.com/mirek/node-json-criteria - also small and missing some stuff. Hasn't been updated in years but code is easy to read

- https://www.npmjs.com/package/underscore-query - Similar to ftw-cloud/query. Was more popular but hasn't been updated in 5 years.
