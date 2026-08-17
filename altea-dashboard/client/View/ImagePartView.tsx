import * as React from "react";
import * as AppContext from "@altea/altea/client/AppContext";
import { ImagePartEntity } from "../../data/Parts";
import type { PanelPartContentProps } from "../DashboardClient";

// Port of Signum's Signum.Dashboard/View/ImagePartView.tsx — the image, optionally wrapped in a link (an
// app-relative "~/…" URL navigates in place instead of reloading).

export default function ImagePart(p: PanelPartContentProps<ImagePartEntity>): React.JSX.Element {
    return (
        <div>
            <a href={p.content.clickActionURL ? AppContext.toAbsoluteUrl(p.content.clickActionURL) : undefined}
                onClick={p.content.clickActionURL?.startsWith("~")
                    ? (e => { e.preventDefault(); AppContext.navigate(p.content.clickActionURL!); })
                    : undefined}>
                <img src={p.content.imageSrcContent} style={{ width: "100%" }} alt={p.content.altText ?? "Image part"} />
            </a>
        </div>
    );
}
