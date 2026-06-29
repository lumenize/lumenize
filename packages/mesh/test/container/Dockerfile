# Minimal image so the wrangler `containers.image` field validates during the
# Phase-2 feasibility precheck. vitest-pool-workers never actually runs this —
# the precheck only asks whether `ctx.container` is populated (i.e. whether a
# `class X extends Container {}` constructs) in the pool-workers runtime.
FROM scratch
