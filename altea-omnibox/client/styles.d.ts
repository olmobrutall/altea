// Ambient module declaration so `import './Omnibox.css'` type-checks under tsc. Mirrors
// altea-profiler/client/styles.d.ts. Vite handles the actual CSS at bundle time.
declare module '*.css';
