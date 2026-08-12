// Ambient module declarations so `import './X.css'` type-checks under tsc (the AuthAdmin admin controls
// import their stylesheet). Vite handles the actual CSS at build time. Mirrors altea/client/styles.d.ts.
declare module '*.css';
declare module '*.scss';
