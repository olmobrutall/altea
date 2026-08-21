import * as React from "react";
import { classes } from "@altea/altea/data/globals";
import type { Lite } from "@altea/altea/data/lite";
import type { UserEntity } from "../../data/User";
import "./UserCircle.css";

// Port of Signum's UserCircle (Signum.Authorization/Templates/UserCircle.tsx) — the initials-in-a-coloured
// circle stand-in shown when a user has no profile photo. The colour is derived from the user's id, so it
// is stable and needs no stored preference.
//
// altea divergence: `getToString(u)` → `u.toString()` (altea's Lite carries its own toString).

export const Options = {
    colors: ("#750b1c #a4262c #d13438 #ca5010 #986f0b #498205 #0b6a0b #038387 #005b70 #0078d4 #004e8c "
        + "#4f6bed #5c2e91 #8764b8 #881798 #c239b3 #e3008c #8e562e #7a7574 #69797e").split(" "),

    getUserColor(u: Lite<UserEntity>): string {
        const id = Number(u.id);
        return Options.colors[Math.abs(id) % Options.colors.length]!;
    },
};

export function getUserInitials(u: Lite<UserEntity>): string {
    const str = u.toString();
    if (!str)
        return "";

    return str.split(" ").map(m => m[0]).filter((_a, i) => i < 2).join("").toUpperCase();
}

export default function UserCircle(p: { user: Lite<UserEntity>; className?: string }): React.JSX.Element {
    const color = Options.getUserColor(p.user);
    const name = p.user.toString();
    return (
        <span className={classes("user-circle", p.className)}
            style={{
                color: "white",
                textDecoration: "underline",
                textDecorationColor: color,
                backgroundColor: color,
            }}
            role="img"
            aria-label={`${name} icon`}
            title={name}>
            {getUserInitials(p.user)}
        </span>
    );
}
