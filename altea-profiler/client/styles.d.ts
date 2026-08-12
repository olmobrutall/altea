// Ambient module declarations so `import './X.css'` (the profiler pages import their stylesheets)
// type-checks under tsc. Mirrors altea-auth/client/styles.d.ts. Vite handles the actual CSS at bundle time.
declare module '*.css';
