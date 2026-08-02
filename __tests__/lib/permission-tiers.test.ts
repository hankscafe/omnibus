// __tests__/lib/permission-tiers.test.ts
import { describe, it, expect } from 'vitest';
import { PERMISSION_TIERS, TIER_ALL_LIBRARIES, tierFlags, tierFromUser } from '@/lib/permission-tiers';

describe('permission-tiers', () => {
  it('defines the four user tiers low → high', () => {
    expect(PERMISSION_TIERS.map(t => t.name)).toEqual(['Civilian', 'Sidekick', 'Vigilante', 'Hero']);
  });

  it('maps each tier to the expected flag bundle', () => {
    expect(tierFlags('Civilian')).toEqual({ canRequest: false, autoApproveRequests: false, canDownload: false, canCreateGlobalLists: false });
    expect(tierFlags('Sidekick')).toEqual({ canRequest: true, autoApproveRequests: false, canDownload: true, canCreateGlobalLists: false });
    expect(tierFlags('Vigilante')).toEqual({ canRequest: true, autoApproveRequests: false, canDownload: true, canCreateGlobalLists: true });
    expect(tierFlags('Hero')).toEqual({ canRequest: true, autoApproveRequests: true, canDownload: true, canCreateGlobalLists: true });
  });

  it('grants ALL libraries only to Vigilante and Hero', () => {
    expect(TIER_ALL_LIBRARIES).toEqual({ Civilian: false, Sidekick: false, Vigilante: true, Hero: true });
  });

  describe('tierFromUser', () => {
    it('returns Admin for the ADMIN role regardless of flags', () => {
      expect(tierFromUser({ role: 'ADMIN', canRequest: false, canDownload: false })).toBe('Admin');
    });

    // (beta.014: the spread-a-tier's-own-flags-back-in case was deleted — tierFromUser is a find()
    // over the same table, so that assertion was true by construction and could never fail.)

    it('treats missing flags as false → Civilian', () => {
      expect(tierFromUser({ role: 'USER' })).toBe('Civilian');
    });

    it('returns Custom for a flag combo that matches no preset', () => {
      // Can request + global lists but NOT download — not any defined tier.
      expect(tierFromUser({ role: 'USER', canRequest: true, autoApproveRequests: false, canDownload: false, canCreateGlobalLists: true })).toBe('Custom');
    });
  });
});
