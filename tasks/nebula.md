# Lumenize Nebula

This file is currently just a scratchpad for thinking about the Lumenize Nebula

## Scratchpad

- universe.galaxy.star auth and access control model
- The OrgTree DAG is the heart of each star. Everything hangs off of it.
- Richard Snodgrass style temporal data model with permenant history (like the original npm `lumenize` package assumed and the Rally Lookback API implemented)
  - The star DO will keep the most recent copy of every entity and a small cache of history "snapshots". Snapshots other than the latest are lazily copied to a DO just for that entity which can grow indefinitely
  - Old school npm pacakge `lumenize` aggregations
    - There might be a huge