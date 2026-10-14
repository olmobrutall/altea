import { config } from "@fortawesome/fontawesome-svg-core";
import "@fortawesome/fontawesome-svg-core/styles.css";

// Font Awesome injects its stylesheet at runtime, outside every cascade layer, where it beats altea's
// layered icon rules. Imported as a stylesheet it goes through the build like any other CSS instead.
// An app imports this module before anything that renders an icon.
config.autoAddCss = false;
