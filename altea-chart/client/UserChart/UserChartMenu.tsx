import * as React from "react";
import { Dropdown } from "react-bootstrap";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { Navigator } from "@altea/altea/client/Navigator";
import { Lite } from "@altea/altea/data/lite";
import { ChartMessage } from "../../data/ChartMessage";
import { UserChartEntity } from "../../data/UserChart";
import { UserChartClient } from "./UserChartClient";
import type { ChartRequestViewHandle } from "../Templates/ChartRequestView";

// Port of Signum's Signum.Chart/UserChart/UserChartMenu.tsx — the dropdown on the chart page toolbar to list /
// apply / create / edit a saved UserChart, working through the ChartRequestViewHandle. The direct analogue of
// altea-user-queries' UserQueryMenu. altea divergences:
//  - The custom-lite carries the display fields directly (UserChartLite), so no model round-trip /
//    fillLiteModels — the menu reads `uc.toString()` / `uc.key()` straight off the lite.
//  - Applying a saved chart rebuilds the ChartRequestModel CLIENT-SIDE (Converter.toChartRequest), then swaps
//    it in via the handle (which re-encodes the chart URL with the `userChart=` param).
//  - "Apply changes" (Signum's StringDistance merge of the live chart onto the saved one) is DEFERRED — the
//    menu offers list / apply / edit / create for now.

export interface UserChartMenuProps {
    chartRequestView: ChartRequestViewHandle;
}

export default function UserChartMenu(p: UserChartMenuProps): React.JSX.Element {
    const [isOpen, setIsOpen] = React.useState(false);
    const [userCharts, setUserCharts] = React.useState<Lite<UserChartEntity>[] | undefined>(undefined);

    const crv = p.chartRequestView;

    React.useEffect(() => {
        if (userCharts == undefined)
            void reloadList();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [crv.chartRequest.queryKey]);

    function reloadList(): Promise<Lite<UserChartEntity>[]> {
        return UserChartClient.API.forQuery(crv.chartRequest.queryKey).then(list => { setUserCharts(list); return list; });
    }

    function handleSelect(uc: Lite<UserChartEntity>): void {
        setIsOpen(false);
        Navigator.API.fetch(uc).then(userChart =>
            UserChartClient.Converter.toChartRequest(userChart, undefined).then(newCr => {
                crv.onChange(newCr, uc);
                crv.hideFiltersAndSettings();
            }));
    }

    function handleCreate(): void {
        setIsOpen(false);
        UserChartClient.createUserChart(crv.chartRequest)
            .then(uc => Navigator.view(uc))
            .then(uc => {
                if (uc?.id != null) {
                    crv.onChange(crv.chartRequest, uc.toLite());
                    crv.hideFiltersAndSettings();
                    void reloadList();
                }
            });
    }

    function handleEdit(): void {
        setIsOpen(false);
        Navigator.API.fetch(crv.userChart!)
            .then(userChart => Navigator.view(userChart))
            .then(() => reloadList())
            .then(() => { if (crv.userChart) handleSelect(crv.userChart); });
    }

    const label = crv.userChart ? crv.userChart.toString() : UserChartEntity.nicePluralName();

    return (
        <Dropdown onToggle={() => setIsOpen(!isOpen)} show={isOpen}>
            <Dropdown.Toggle id="userChartsDropDown" variant="tertiary">
                <span><FontAwesomeIcon icon="chart-bar" />&nbsp;{label}</span>
            </Dropdown.Toggle>
            <Dropdown.Menu>
                <div style={{ maxHeight: "300px", overflowX: "auto" }}>
                    {userCharts?.map((uc, i) =>
                        <Dropdown.Item key={i} active={crv.userChart != null && uc.key() === crv.userChart.key()} onClick={() => handleSelect(uc)}>
                            {uc.toString()}
                        </Dropdown.Item>)}
                </div>
                {Boolean(userCharts?.length) && <Dropdown.Divider />}
                {crv.userChart &&
                    <Dropdown.Item onClick={handleEdit}>
                        <FontAwesomeIcon icon="pen-to-square" className="me-2" />{ChartMessage.Edit.niceToString()}
                    </Dropdown.Item>}
                <Dropdown.Item onClick={handleCreate}>
                    <FontAwesomeIcon icon="plus" className="me-2" />{ChartMessage.CreateNew.niceToString()}
                </Dropdown.Item>
            </Dropdown.Menu>
        </Dropdown>
    );
}
