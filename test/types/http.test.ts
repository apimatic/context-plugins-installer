import test from 'node:test';
import assert from 'node:assert';

import { hostOf, isUpstreamOutage } from '../../src/types/http.js';

// The two questions every boundary asks about a response. Both are asked from
// more than one place - the registry client, the repository fetcher and the
// archive download - which is why they are rules down here rather than helpers
// one of those modules owns.

/**
 * The boundary as a value: every site-level test of a failing request picks one
 * status on each side and none of them pins where the line is. `>= 500` widened
 * to `> 500` sends a plain HTTP 500 - the one GitHub emits most - back down the
 * verbatim path at every call site with the suite green.
 */
test('the outage boundary is 500, and every 4xx is on the other side of it', () => {
  for (const status of [500, 501, 502, 503, 504, 599]) {
    assert.equal(isUpstreamOutage(status), true, `${status} is the far end failing`);
  }
  for (const status of [200, 400, 401, 403, 404, 429, 499]) {
    assert.equal(isUpstreamOutage(status), false, `${status} is not an outage`);
  }
});

/**
 * `hostOf` is called from inside the handler for a failed request, so a string
 * it cannot parse has to come back as itself rather than throwing a TypeError
 * over the original error and replacing it.
 */
test('a host that cannot be parsed out of a url is the url, not a throw', () => {
  assert.equal(hostOf('https://raw.githubusercontent.com/a/b'), 'raw.githubusercontent.com');
  assert.equal(hostOf('not://a real url'), 'not://a real url');
});
