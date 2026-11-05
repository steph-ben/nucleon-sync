import { THIRD_PARTY_NOTICE } from '../names';

/**
 * Proton API code 5003 means "upgrade the app to call the endpoint this way"
 * (vendor coreTypes.ts). The SDK error only carries the server text, e.g.
 * "You need to update this app in order to perform this operation".
 */
export function isOutdatedClient(message: string): boolean {
    return /update this app|upgrade the app|\b5003\b/i.test(message);
}

/** Tells the user this is not a Proton app, then shows the sign-in address. */
export async function signIn(auth: { authViaWeb(show: (url: string) => void): Promise<unknown> }, print: (line: string) => void): Promise<void> {
    print(THIRD_PARTY_NOTICE);
    await auth.authViaWeb((url) => print(`Open this address to log in:\n${url}`));
}
