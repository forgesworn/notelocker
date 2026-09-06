import {defineConfig} from 'vitest/config'

// Everything here is a pure codec or a fake wire - no hardware, no network -
// so the default 5s budget is generous. The one thing that could hang is a
// transport awaiting a reply that never comes; a short timeout makes that
// fail as a test rather than as a wedged run.
export default defineConfig({
  test: {
    testTimeout: 10_000
  }
})
