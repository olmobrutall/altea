import * as React from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { classes } from "@altea/altea/data/globals";
import { useAPI } from "@altea/altea/client/Hooks";
import { Lite } from "@altea/altea/data/lite";
import { UserEntity } from "../../data/User";
import UserCircle, * as UserCircles from "./UserCircle";
import "./ProfilePhoto.css";

// Port of Signum's ProfilePhoto (Signum.Authorization/Templates/ProfilePhoto.tsx) — the user avatar, and
// more importantly the REGISTRY a directory module plugs into: `urlProviders`. Each provider is asked, in
// registration order, for a URL for this user at this size; the first non-null wins, and if none answers
// the avatar degrades to a UserCircle (small) or a person glyph (large).
//
// It lives here (not in a directory module) because it is the shared host both @altea/altea-auth-azuread
// and @altea/altea-auth-windowsad register into, exactly as in Signum.
//
// altea divergences, documented inline:
//  - Signum reads a user's external id off a `UserLiteModel` when only a Lite is in hand. altea has NO
//    lite-model entity, so a Lite carries just its id and toString: a provider that needs the external id
//    (Azure AD's object id) can only answer for a FULL UserEntity and returns null for a Lite, which the
//    UserCircle fallback then covers. A provider keyed on the user NAME (Windows AD's thumbnailPhoto
//    route) works for both, since a UserEntity's toString IS its userName.
//  - `Dic.clear(urlCache)` → a plain `Map.clear()`.

export type ProfilePhotoUrlProvider =
    (u: UserEntity | Lite<UserEntity>, size: number) => string | Promise<string | null> | null;

export const urlProviders: ProfilePhotoUrlProvider[] = [];

const urlCache = new Map<string, Promise<string | null> | string | null>();

export function clearCache(): void {
    urlCache.clear();
}

export default function ProfilePhoto(p: { user: UserEntity; size: number }): React.JSX.Element {
    const [imageError, setImageError] = React.useState(false);
    let url = useCachedUrl(p.user, p.size);

    React.useEffect(() => { setImageError(false); }, [url]);

    if (imageError)
        url = null;

    const color = p.user.isNew ? "gray" : UserCircles.Options.getUserColor(p.user.toLite());
    const iconSize = p.size >= 250 ? "10x" : `${Math.ceil(p.size / 25)}x`;
    const name = p.user.toString();

    return (
        <div className="user-profile-photo align-items-center d-flex justify-content-center"
            style={{ width: `${p.size}px`, height: `${p.size}px`, borderColor: !url ? color : undefined }}>
            {!url
                ? <FontAwesomeIcon role="img" icon="user" size={iconSize as never} color={color} />
                : <img src={url} style={{ maxWidth: `${p.size - 3}px`, maxHeight: `${p.size - 3}px` }}
                    alt={name} title={name} onError={() => setImageError(true)} />}
        </div>
    );
}

export function SmallProfilePhoto(p: {
    user: Lite<UserEntity>; size?: number; className?: string; fallback?: React.ReactNode;
}): React.JSX.Element {
    const [imageError, setImageError] = React.useState(false);
    const size = p.size ?? 22;
    const url = useCachedUrl(p.user, size);
    const name = p.user.toString();

    React.useEffect(() => { setImageError(false); }, [url]);

    return (
        <div className={classes("small-user-profile-photo", p.className)}>
            {url && !imageError
                ? <img src={url} style={{ maxWidth: `${size}px`, maxHeight: `${size}px` }}
                    alt={name} title={name} onError={() => setImageError(true)} />
                : p.fallback ?? <UserCircle user={p.user} />}
        </div>
    );
}

function useCachedUrl(user: UserEntity | Lite<UserEntity>, size: number): string | null | undefined {
    // A new (unsaved) user has no identity to cache under, so ask the providers directly.
    return useAPI(() => user.id == null ? getFirstUrl(user, size) : getCachedFirstUrl(user, size), [user.id, size]);
}

function getCachedFirstUrl(user: UserEntity | Lite<UserEntity>, size: number): Promise<string | null> | string | null {
    const lite = user instanceof Lite ? user : user.toLite();
    const key = lite.key() + ":" + size;
    if (!urlCache.has(key))
        urlCache.set(key, getFirstUrl(user, size));
    return urlCache.get(key)!;
}

function getFirstUrl(user: UserEntity | Lite<UserEntity>, size: number): Promise<string | null> | string | null {
    for (const f of urlProviders) {
        const result = f(user, size);
        if (result != null)
            return result;
    }
    return null;
}
