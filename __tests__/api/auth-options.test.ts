import { describe, it, expect, vi, beforeEach } from 'vitest';

// 1. Hoist our mocks AND set environment variables BEFORE imports evaluate
const mocks = vi.hoisted(() => {
    // Set this here so the top-level safeguard in options.ts doesn't call process.exit(1)
    process.env.NEXTAUTH_SECRET = 'super_secure_test_secret_key_1234567890';
    
    return {
        systemSettingFindMany: vi.fn(),
        queryRaw: vi.fn(),
        userCreate: vi.fn(),
        userUpdate: vi.fn(),
        userFindFirst: vi.fn(),
        log: vi.fn(),
        decrypt2FA: vi.fn()
    };
});

// Import MUST come after vi.hoisted
import { getAuthOptions } from '@/app/api/auth/[...nextauth]/options';

// 2. Mock Dependencies
vi.mock('@/lib/db', () => ({
    prisma: {
        systemSetting: { findMany: mocks.systemSettingFindMany },
        $queryRaw: mocks.queryRaw,
        user: { 
            create: mocks.userCreate, 
            update: mocks.userUpdate, 
            findFirst: mocks.userFindFirst 
        }
    }
}));

vi.mock('@/lib/logger', () => ({ Logger: { log: mocks.log } }));
vi.mock('@/lib/encryption', () => ({ decrypt2FA: mocks.decrypt2FA }));

describe('Security: NextAuth OIDC Single Sign-On', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('should auto-approve new SSO users if oidc_auto_approve is enabled', async () => {
        // Simulate DB settings: OIDC is ON, Auto-Approve is ON
        mocks.systemSettingFindMany.mockResolvedValue([
            { key: 'oidc_enabled', value: 'true' },
            { key: 'oidc_auto_approve', value: 'true' }
        ]);
        
        mocks.queryRaw.mockResolvedValue([]); // No existing user found
        mocks.userCreate.mockResolvedValue({ id: 'user_1', role: 'USER', isApproved: true });
        mocks.userFindFirst.mockResolvedValue(null); // Not the first user in DB

        const options = await getAuthOptions();
        const signInCallback = options.callbacks!.signIn as any;

        const result = await signInCallback({
            user: { email: 'newuser@sso.com', name: 'New User' },
            account: { provider: 'oidc' }
        });

        // Assert they were allowed to sign in
        expect(result).toBe(true);
        
        // Assert the database creation correctly applied isApproved: true
        expect(mocks.userCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                email: 'newuser@sso.com',
                isApproved: true
            })
        }));
    });

    it('should assign ADMIN role and auto-approve if user belongs to the mapped admin group', async () => {
        // Simulate DB settings: Groups are mapped
        mocks.systemSettingFindMany.mockResolvedValue([
            { key: 'oidc_enabled', value: 'true' },
            { key: 'oidc_admin_group', value: 'Omnibus_Admins' },
            { key: 'oidc_user_group', value: 'Omnibus_Users' }
        ]);
        
        mocks.queryRaw.mockResolvedValue([]); 
        mocks.userCreate.mockResolvedValue({ id: 'admin_1', role: 'ADMIN', isApproved: true });
        mocks.userFindFirst.mockResolvedValue(null);

        const options = await getAuthOptions();
        const signInCallback = options.callbacks!.signIn as any;

        const result = await signInCallback({
            user: { 
                email: 'boss@sso.com', 
                name: 'The Boss', 
                groups: ['Other_Group', 'Omnibus_Admins'] // They have the admin group!
            },
            account: { provider: 'oidc' }
        });

        expect(result).toBe(true);
        
        // Assert the database creation recognized the group and granted ADMIN
        expect(mocks.userCreate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                role: 'ADMIN',
                isApproved: true,
                autoApproveRequests: true,
                canDownload: true
            })
        }));
    });

    it('should reject the login if group mapping is enforced and the user lacks required groups', async () => {
        // Simulate DB settings: Strict group mapping enforced
        mocks.systemSettingFindMany.mockResolvedValue([
            { key: 'oidc_enabled', value: 'true' },
            { key: 'oidc_admin_group', value: 'Omnibus_Admins' },
            { key: 'oidc_user_group', value: 'Omnibus_Users' }
        ]);
        
        mocks.queryRaw.mockResolvedValue([]); 

        const options = await getAuthOptions();
        const signInCallback = options.callbacks!.signIn as any;

        const result = await signInCallback({
            user: { 
                email: 'stranger@sso.com', 
                name: 'Stranger', 
                groups: ['Random_Group', 'Not_Authorized'] // They lack the required groups
            },
            account: { provider: 'oidc' }
        });

        // Assert the signIn callback explicitly rejected the attempt
        expect(result).toBe(false);
        
        // Assert no account was created in the database
        expect(mocks.userCreate).not.toHaveBeenCalled();
    });

    it('should update an existing user if their OIDC groups change from USER to ADMIN', async () => {
        mocks.systemSettingFindMany.mockResolvedValue([
            { key: 'oidc_enabled', value: 'true' },
            { key: 'oidc_admin_group', value: 'Omnibus_Admins' },
            { key: 'oidc_user_group', value: 'Omnibus_Users' }
        ]);
        
        // Simulate an existing user who previously only had the 'USER' role
        mocks.queryRaw.mockResolvedValue([{ id: 'existing_1', role: 'USER', isApproved: true }]); 
        mocks.userUpdate.mockResolvedValue({ id: 'existing_1', role: 'ADMIN', isApproved: true });

        const options = await getAuthOptions();
        const signInCallback = options.callbacks!.signIn as any;

        const result = await signInCallback({
            user: { 
                email: 'promoted@sso.com', 
                name: 'Promoted User', 
                groups: ['Omnibus_Admins'] // They were promoted in the Identity Provider
            },
            account: { provider: 'oidc' }
        });

        expect(result).toBe(true);

        // Assert the app detected the group change and issued a DB update
        expect(mocks.userUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'existing_1' },
            data: expect.objectContaining({
                role: 'ADMIN',
                isApproved: true
            })
        }));
    });
});