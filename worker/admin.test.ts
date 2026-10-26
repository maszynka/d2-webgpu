// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { adminEnabled, statsQueries } from './admin';

describe('statsQueries', () => {
  it('clamps the period to 1..90 days', () => {
    expect(statsQueries(0).daily).toContain("INTERVAL '30' DAY");
    expect(statsQueries(1000).daily).toContain("INTERVAL '90' DAY");
    expect(statsQueries(7.9).daily).toContain("INTERVAL '7' DAY");
    expect(statsQueries(NaN).daily).toContain("INTERVAL '30' DAY");
  });

  it('reads the columns countVisit writes, weighted by the sample interval', () => {
    const q = statsQueries(30);
    expect(Object.keys(q)).toEqual(['daily', 'country', 'webgpu', 'browser', 'os', 'gpu', 'features', 'jspi']);
    expect(q['country']).toMatch(/SELECT index1 AS k, SUM\(_sample_interval\)/);
    expect(q['webgpu']).toContain('blob4 AS k');
    expect(q['browser']).toMatch(/SELECT blob1 AS k, blob2 AS k2, .* GROUP BY k, k2 /);
    expect(q['gpu']).toMatch(/SELECT blob5 AS k, blob6 AS k2, .* GROUP BY k, k2 /);
    for (const sql of Object.values(q)) expect(sql).not.toMatch(/concat|format\(/);
    for (const sql of Object.values(q)) expect(sql).toContain('FROM d2_webgpu_visits');
  });
});

describe('adminEnabled', () => {
  it('needs the password, the account and the token', () => {
    expect(adminEnabled({})).toBe(false);
    expect(adminEnabled({ ADMIN_PASSWORD: 'x', CF_ACCOUNT_ID: 'a' })).toBe(false);
    expect(adminEnabled({ ADMIN_PASSWORD: 'x', CF_ACCOUNT_ID: 'a', CF_API_TOKEN: 't' })).toBe(true);
  });
});
