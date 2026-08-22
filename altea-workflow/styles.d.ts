// Ambient declarations for the side-effect imports the BPMN designer needs: our own CSS, bpmn-js's and
// diagram-js's bundled stylesheets, and `?raw` text imports (the initial-diagram XML). Mirrors
// altea-dashboard's styles.d.ts; picked up by the client tsconfig preset's `${configDir}/*.d.ts` include.
declare module "*.css";
declare module "*.xml?raw" {
    const content: string;
    export default content;
}
