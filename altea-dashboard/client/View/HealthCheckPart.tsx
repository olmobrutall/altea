import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import * as AppContext from "@altea/altea/client/AppContext";
import { ajaxGet, ServiceError } from "@altea/altea/client/Services";
import { useAPI } from "@altea/altea/client/Hooks";
import { cleanTypeName } from "@altea/altea/data/registration";
import { JavascriptMessage } from "@altea/altea/data/uiMessages";
import { HealthCheckElementEmbedded, HealthCheckPartEntity } from "../../data/Parts";
import { DashboardClient, type PanelPartContentProps } from "../DashboardClient";
import { parseIcon, fallbackIcon, getContrastingTextColor } from "@altea/altea/client/Components/IconHelpers";

// Port of Signum's Signum.Dashboard/View/HealthCheckPart.tsx — a board of tiles, each polling its own
// ASP.NET-health-style endpoint (`{ status: "Healthy"|"Degraded"|"Unhealthy", description }`) and colouring
// itself by the answer; clicking a tile opens its navigate URL.
//
// altea divergence: Signum tinted the foreground with `Color.lerp(.5, …opositePole())` from
// @framework/Basics/Color (not ported) — here the text colour is the WCAG-contrasting black/white of the
// tile background (IconHelpers.getContrastingTextColor).

export default function HealthCheckPart(p: PanelPartContentProps<HealthCheckPartEntity>): React.JSX.Element {
    const part = p.partEmbedded;
    const defaultIcon = DashboardClient.partRenderers[cleanTypeName(HealthCheckPartEntity)]?.icon?.();
    const icon = parseIcon(part.iconName) ?? defaultIcon?.icon;
    const iconColor = part.iconColor ?? defaultIcon?.iconColor;

    const title = !icon ? part.title :
        <span>
            <FontAwesomeIcon aria-hidden={true} icon={fallbackIcon(icon)} color={iconColor} className="me-1" />{part.title}
        </span>;

    return (
        <div className="my-3">
            <h2 className="h5" style={{ color: part.titleColor ?? undefined }}>{title}</h2>
            <div className="d-flex flex-wrap">
                {(p.content.items ?? []).map((le, i) => <HealthCheckElement key={i} element={le} />)}
            </div>
        </div>
    );
}

type HealthResult = "Healthy" | "Degraded" | "Unhealthy";

interface HealthCheckResult {
    status: HealthResult;
    description: string;
    data?: Record<string, unknown>;
}

type StatusInfo = { result: HealthCheckResult } | { error: unknown };

function HealthCheckElement(p: { element: HealthCheckElementEmbedded }): React.JSX.Element {

    const data = useAPI(() => ajaxGet<HealthCheckResult>({
        url: p.element.checkURL,
        avoidAuthToken: true,
        avoidContextHeaders: true,
        avoidVersionCheck: true,
    }).then(result => ({ result }) as StatusInfo)
        .catch((e: unknown) => {
            // A health endpoint answers 503 WITH the health payload — surface it as the result, not an error.
            if (e instanceof ServiceError && "status" in e.httpError && "description" in e.httpError)
                return ({ result: e.httpError as unknown as HealthCheckResult }) as StatusInfo;

            return ({ error: e }) as StatusInfo;
        }), [p.element.checkURL]);

    const bgc = data === undefined ? "#00000038" :
        "error" in data ? "#ec4205" :
            data.result.status == "Healthy" ? (data.result.description == "Disabled" ? "#eee" : "#6ecb7b") :
                data.result.status == "Degraded" ? "#ffd43f" :
                    data.result.status == "Unhealthy" ? "#ec4205" : "#f700ff";

    const foreColor = getContrastingTextColor(bgc);

    const message = data == null ? JavascriptMessage.loading.niceToString() :
        "error" in data
            ? (data.error instanceof ServiceError ? data.error.httpError.exceptionMessage : String((data.error as Error)?.message ?? data.error))
            : data.result.description;

    return (
        <div className="d-flex position-relative justify-content-center align-items-center mx-2 my-2 rounded"
            title={message ?? undefined}
            style={{
                cursor: p.element.navigateURL ? "pointer" : undefined,
                minWidth: 240,
                minHeight: 80,
                backgroundColor: bgc,
                color: foreColor,
                textAlign: "center",
            }}
            onClick={() => {
                if (p.element.navigateURL)
                    window.open(AppContext.toAbsoluteUrl(p.element.navigateURL));
            }}>
            <span className="position-absolute top-0 end-0 me-1 mt-1">
                <FontAwesomeIcon aria-hidden={true} className="fs-2" color={foreColor} icon={
                    data == null ? "hourglass-start" :
                        "error" in data ? "link-slash" :
                            data.result.status == "Healthy" ? (data.result.description == "Disabled" ? "circle" : "circle-check") :
                                data.result.status == "Degraded" ? "circle-down" :
                                    data.result.status == "Unhealthy" ? "circle-xmark" : "link"} />
            </span>
            <strong>{p.element.title}</strong>
        </div>
    );
}
