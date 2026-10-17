<script setup lang="ts">
/**
 * The auth SPA's shell — one bundle serving every session-lifecycle screen.
 *
 * Every page on the platform host — Home at `/`, and `/auth/login`, `/auth/signup`, `/auth/emails`,
 * `/auth/magic-link` and `/auth/logout` — is served the same HTML, and this decides which screen that
 * is. The decision itself lives in `screenForPath` rather than in the template below, so it is
 * assertable.
 *
 * ⚠️ **This shell is deliberately outside Studio's bundle.** Session lifecycle used to live inside
 * the product app, which meant a person with no session at all was loading the whole Studio
 * front-end to see a login form — and meant the login form could only exist where Studio was
 * served. Home has to serve every tier, including a Star tenant who never sees Studio.
 */
import { viewState } from '../view-state';
import { computed } from 'vue';
import { screenForPath } from './routes';
import LoginScreen from './LoginScreen.vue';
import SignupScreen from './SignupScreen.vue';
import ComingSoon from '../ComingSoon.vue';
import HomeScreen from './HomeScreen.vue';
import MagicLinkScreen from './MagicLinkScreen.vue';
import LogoutScreen from './LogoutScreen.vue';

const route = computed(() => screenForPath(viewState.value.pathname));
</script>

<template>
  <main class="min-h-screen bg-base-100 flex items-center justify-center p-6">
    <LoginScreen v-if="route.screen === 'login'" />
    <SignupScreen v-else-if="route.screen === 'signup'" />
    <HomeScreen v-else-if="route.screen === 'home'" />
    <MagicLinkScreen v-else-if="route.screen === 'magic-link'" />
    <LogoutScreen v-else-if="route.screen === 'logout'" />
    <ComingSoon
      v-else-if="route.screen === 'emails'"
      title="Manage your email addresses"
      tag="email-management"
      blurb="Adding a second address to one identity, and choosing which one signs you in."
    />
    <div v-else class="text-center space-y-3">
      <p class="text-base-content/70">That page doesn't exist.</p>
      <a class="btn btn-primary btn-sm" href="/auth/login">Go to sign in</a>
    </div>
  </main>
</template>
