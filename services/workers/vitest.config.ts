// Heavier tests here (property tests with thousands of cases, PDF rendering) run well under 5 s on a
// laptop but can pass it on a busy CI machine; 20 s keeps them reliable without hiding a real hang.
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { testTimeout: 20_000 } });
