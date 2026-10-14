import * as React from "react";
import type { ClientBuilder } from "../ClientBuilder";
import { ImportComponent } from "../ImportComponent";

/** `/ui-kit`: every `ui` component in both themes. A development page — an app registers it only in dev. */
export namespace UiKitClient {
    export function start(cb: ClientBuilder): void {
        cb.routes.push({ path: "/ui-kit", element: <ImportComponent onImport={() => import("./UiKitPage")} /> });
    }
}
