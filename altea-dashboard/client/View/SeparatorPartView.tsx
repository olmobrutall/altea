import * as React from "react";
import { SeparatorPartEntity } from "../../data/Parts";
import type { PanelPartContentProps } from "../DashboardClient";

// Port of Signum's Signum.Dashboard/View/SeparatorPartView.tsx — a full-width heading between part rows.

export default function SeparatorPart(p: PanelPartContentProps<SeparatorPartEntity>): React.JSX.Element {
    return (
        <div>
            <h1>{p.content.title}</h1>
        </div>
    );
}
