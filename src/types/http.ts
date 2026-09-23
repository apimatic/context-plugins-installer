// The two questions every boundary that speaks HTTP asks about a response, and
// nothing else: which host a message should name, and whether a status is the
// far end failing. Both the registry client and the archive download ask them,
// so they are rules rather than helpers one of those modules happens to own -
// and neither touches the world, which is why they can live down here.

/**
 * The host a failure names. A URL too malformed to parse would otherwise throw
 * a TypeError from inside the handler for the original error, replacing it.
 */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * Anything 500 and up is the far end failing, not this run - so every one of
 * them says the same sentence. The response itself is not repeated: a status
 * line, or the Varnish error page a CDN puts in front of one, tells the user
 * nothing they can act on and reads as though their marketplace, their token or
 * their network were at fault. The code is kept because it is the one part of
 * the response worth putting in a bug report; nothing else of it is shown.
 */
export const isUpstreamOutage = (status: number): boolean => status >= 500;
