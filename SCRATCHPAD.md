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

## Database/ORM Ideas

We want to create a new kind of database/ORM

JSON stored in SQLite

### Indexes on JSON Fields

```sql
CREATE INDEX idx_users_age ON users (json_extract(data, '$.age'));
SELECT * FROM users WHERE json_extract(data, '$.age') > 30;
```

One table with the same structure in SQL fields for meta like validFrom, validTo, etc., but different schemas in the actual content

A separate JSON "type" field that is an array so rows can be more than one thing (e.g. defect and ticket, or story and ticket). All schemas are assumed to be partial. You only invalidate for extra fields against the union of all specified schemas. This allows for type inheritance or mixins.

Partial indexes per type (or maybe just compound indexes where the type is the first thing?) so you can quickly query all defects for example.

## SQLite in Cloudflare

### DO SQLite Storage Engine

DO SQLite Storage engine uses SQLite version 3.47 or later

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

## Access Control

### ReBAC - Relationship-based Access Control

Call what I'm doing ReBAC - Relationship-based Access Control

## Svelte + Tailwind

### TailwindCSS Container Queries

Consider using TailwindCSS container queries:

https://github.com/tailwindlabs/tailwindcss-container-queries

### To Style Things with Svelte and Tailwind/Daisy

As someone who used to be against tailwind because I believed it was used by people who didn't really understand CSS/SASS, I am now a huge fan of tailwind - especially with Svelte. The trick is to create shallow components for styling. You don't want to be repeating class lists in the same component or across your app.

Example:

**MyList.svelte**

```svelte
<ul class="...bunch of tw classes">
  <li class="...bunch of other tw classes"> stuff </li>
  ...
</ul>
```

Even for simple components like the one above, create nested items like so:

**List.svelte**

```svelte
<ul class="...bunch of classes">
  <slot />
</ul>
```

**ListItem.svelte**

```svelte
<li class="...bunch of other classes">
  <slot />
</li>
```

**MyList.svelte**

```svelte
<List>
  <ListItem> stuff </ListItem>
  ...
</List>
```

Use these globally in your app as they are appropriate, and make generous use of Svelte's class merging capability via clsx. Example:

**ListItem.svelte**

```svelte
<script lang="ts">
  const { classList, ...rest } = $props()
</script>

<li class={["...bunch of other classes", classList]} {...$rest}> // ...$rest syntax not tested
  <slot />
</li>
```

Now you can extend them quite easily:

```svelte
<ListItem class="intellisense-will-work-here"> stuff </ListItem>
```

This does several advantages. It keeps your app consistent throughout. You might think it's similar to having a class, but actually it's way easier. When styling is literally in the markup, it just makes so much more sense. Second, it doesn't clutter the parts of your app that are actually processing UI logic. You can read semantically what each item is and its purpose. You also have the ability to refactor the html code for certain components

IMO You should always abstract any repeated styled element into its own component with a slot. This has worked great for me and it's a way of staying organised especially as the app scales.

### Svelte Handlers

Handlers should always be arrow functions, never Class methods because the `this` will be the tag not the Class instance if you use regular Class methods. See: https://svelte.dev/docs/svelte/$state#Classes

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
