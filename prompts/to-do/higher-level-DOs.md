# Create DOs for higher levels (multiverse, universe, and galaxy)

## Multiverse (aka "lumenize" for now, but could be others in the future)

- Allows for signup and management of a SaaS provider company (aka "universe")
- Per-universe billing info so lumenize can bill the SaaS provider
- Only Lumenize employees can manage the multiverse level

## Universe (an enterprise or B2B SaaS provider)

- Allows for creation and management of applications (aka "galaxies")
- Users and authentication are done at this level instead of at the Galaxy level because the SaaS provider may have multiple SaaS applications (galaxies) and want to share users between them
- The SaaS provider's employees can manage the universe and galaxy levels

## Galaxy (an enterprise or B2B SaaS application)

Features:
  - Entity types for the application. They are currently defined at the star level but that work was done with a mind towards splitting it out to the galaxy level so it's relatively well encapsulated.
  - Assets (html, css, js, images, etc) are stored at this level in an R2 bucket with the key /universe/{universeId}/galaxy/{galaxyId}/public/{assetPath}
  - Signup for and creation of orgs (aka "stars")
  - Per-star usage so the SaaS provider can bill their customers
  - This Galaxy's overall usage and billing information

Configuration:
  - Asset serving mode mimicking the modes for Cloudflare assets (e.g. `"not_found_handling": "single-page-application"`)
  - Application type: enterprise or saas. Enterprise apps have only one star

Future:
  - Galaxy-wide queries and aggregations

## Star (an instance of the application, one org tree)

Open questions:
- In an enterprise app, we'll want one shared org tree. Maybe we synchronize it from the Galaxy level?

Features:
- An org is customer of the SaaS provider
- Organized into a tree (actually a DAG - directed acyclic graph)
- Entity instances are attached to a branch of the org tree
- People are granted permissions (admin, write, read, aggregate-read) for branches of the org tree
- Rich queries and aggregations
- Access control by org tree
