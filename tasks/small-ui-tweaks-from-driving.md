# Small UI tweaks from driving

**Status:** a running list, not a task file. Larry adds to it as he drives the app by hand; nothing here is designed or scheduled yet.

## Conventions

Each item is `T1`, `T2`, …, numbered in the order it was raised and never reused, so "T2" still means the same item after others are fixed and deleted. Type a new one at the bottom, numbered or not; an unnumbered one gets the next number when it is first picked up. An item says what was seen and where. A fix, when it is obvious, goes on the same line.

## The list

- **T1. Home has no way to create an account.** Found 2026-11-16: signed in locally as the platform admin on a stack with no accounts, Home showed the address and an unclickable `_platform` row, and nothing else. The form exists, behind **Create a new account** on `/auth/login`, and nothing on Home links to it (`apps/nebula-studio-ui/src/auth/HomeScreen.vue`). It matters for anyone who wants a second account, not only for the platform admin.
- **T2. Home has no log-out control.** Found the same day. `/auth/logout` works, and is reached from Home only by typing the path.
