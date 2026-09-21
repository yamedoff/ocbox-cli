/** Opens a URL in the platform default browser without a shell. */
export interface BrowserOpenerPort {
  open(url: string): Promise<boolean>
}

/** A browser opener that never opens anything; used when a browser is unavailable. */
export class UnavailableBrowserOpener implements BrowserOpenerPort {
  open(): Promise<boolean> {
    return Promise.resolve(false)
  }
}

/** The standard Fetch shape used for every token/revocation call. */
export type FetchPort = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
