// Heavier tests here (the final report's PDF, catching up a month of plays) run in a few seconds on
// a laptop but can pass 5 s when the whole suite shares one database; 20 s keeps them reliable
// without hiding a real hang (as in services/workers and packages/domain).
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { testTimeout: 20_000 } });
