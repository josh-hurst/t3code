function isThirdPartyFaviconTrackerUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  const path = url.pathname.toLowerCase();
  if ((host === "google.com" || host.endsWith(".google.com")) && path.startsWith("/s2/favicons")) {
    return true;
  }
  if ((host === "gstatic.com" || host.endsWith(".gstatic.com")) && path.startsWith("/favicon")) {
    return true;
  }
  return false;
}

function faviconUrlForPage(rawUrl: string | null | undefined, _size = 32): string | null {
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    const pageUrl = new URL(rawUrl);
    if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") return null;
    return new URL("/favicon.ico", pageUrl.origin).href;
  } catch {
    return null;
  }
}

const THEMED_FAVICON_BY_HOSTNAME: Readonly<
  Record<string, Readonly<{ light: string; dark: string }>>
> = {
  "github.com": {
    light: "https://github.githubassets.com/favicons/favicon.svg",
    dark: "https://github.githubassets.com/favicons/favicon-dark.svg",
  },
};

function themedFaviconUrlForPage(
  rawUrl: string | null | undefined,
  appearance: "light" | "dark",
): string | null {
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    const pageUrl = new URL(rawUrl);
    if (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:") return null;
    return THEMED_FAVICON_BY_HOSTNAME[pageUrl.hostname.toLowerCase()]?.[appearance] ?? null;
  } catch {
    return null;
  }
}

/** Accepts image URLs supplied by a trusted provider event, blocking third-party favicon trackers. */
export function sanitizeExternalIconUrl(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || rawUrl.length > 4096) return null;
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:" && url.protocol !== "data:") {
      return null;
    }
    if (
      (url.protocol === "http:" || url.protocol === "https:") &&
      isThirdPartyFaviconTrackerUrl(url)
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function toolActivityFaviconUrl(
  icon: {
    readonly pageUrl: string;
    readonly faviconUrl?: string | undefined;
    readonly faviconUrlDark?: string | undefined;
  },
  appearance: "light" | "dark",
  size = 32,
): string | null {
  if (appearance === "dark") {
    return (
      sanitizeExternalIconUrl(icon.faviconUrlDark) ??
      themedFaviconUrlForPage(icon.pageUrl, "dark") ??
      sanitizeExternalIconUrl(icon.faviconUrl) ??
      faviconUrlForPage(icon.pageUrl, size)
    );
  }
  return (
    sanitizeExternalIconUrl(icon.faviconUrl) ??
    themedFaviconUrlForPage(icon.pageUrl, "light") ??
    faviconUrlForPage(icon.pageUrl, size)
  );
}

// Third-party Google favicon proxy lookups are disabled in this fork to avoid leaking visited domains.
export function faviconUrlForOrigin(_rawUrl: string | null | undefined, _size = 32): string | null {
  return null;
}
