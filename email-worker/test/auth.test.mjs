import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAuthResults, buildPayload } from '../src/extract.js';

const CF_ARC = 'i=1; mx.cloudflare.net; dkim=pass header.d=myworkday.com header.s=s1 header.b=AbC; dmarc=pass header.from=myworkday.com policy.dmarc=reject; spf=pass (mx.cloudflare.net: domain of bounce@myworkday.com designates 1.2.3.4 as permitted sender) smtp.mailfrom=bounce@myworkday.com';

test('auth: Cloudflare ARC-Authentication-Results verdicts', () => {
  const a = extractAuthResults([{ key: 'arc-authentication-results', value: CF_ARC }]);
  assert.deepEqual(a, { spf: 'pass', dkim: 'pass', dmarc: 'pass', dkim_domains: ['myworkday.com'], source: 'arc-authentication-results:mx.cloudflare.net' });
});

test('auth: the topmost trusted header wins; a planted one lower down or from another authserv is ignored', () => {
  const headers = [
    { key: 'authentication-results', value: 'attacker.example; dmarc=pass; dkim=pass header.d=acme.com' },
    { key: 'arc-authentication-results', value: 'i=1; mx.cloudflare.net; dkim=fail header.d=evil.test; dmarc=fail header.from=acme.com; spf=softfail' },
    { key: 'authentication-results', value: 'mx.cloudflare.net; dmarc=pass header.from=acme.com' },
  ];
  const a = extractAuthResults(headers);
  assert.equal(a.dmarc, 'fail');
  assert.equal(a.dkim, 'fail');
  assert.deepEqual(a.dkim_domains, []);
});

test('auth: no trusted header -> null; trusted ids are configurable', () => {
  assert.equal(extractAuthResults([{ key: 'authentication-results', value: 'mx.google.com; dmarc=pass' }]), null);
  assert.equal(extractAuthResults([]), null);
  const a = extractAuthResults([{ key: 'authentication-results', value: 'mx.google.com; dmarc=pass' }], { trusted: ['mx.google.com'] });
  assert.equal(a.dmarc, 'pass');
});

test('auth: buildPayload carries the verdicts', () => {
  const p = buildPayload({ headers: [{ key: 'arc-authentication-results', value: CF_ARC }], subject: 'x', text: 'hello', from: { address: 'bounce@myworkday.com' } }, { envelopeTo: 'a.b@apply.vloombox.in' });
  assert.equal(p.auth.dmarc, 'pass');
  assert.equal(buildPayload({ headers: [], subject: 'x', text: '' }).auth, null);
});
