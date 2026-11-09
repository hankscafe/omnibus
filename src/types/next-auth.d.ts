import { DefaultSession, DefaultUser } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      role: string;
      canRequest?: boolean;
      autoApproveRequests?: boolean;
      canDownload?: boolean;
      canCreateGlobalLists?: boolean;
      // An admin viewing the app as another user (the jwt callback's impersonation swap).
      isImpersonating?: boolean;
    } & DefaultSession["user"];
    // "SessionExpired" when the jwt callback ended the session (inactivity, revoked sessionVersion).
    error?: string;
  }

  interface User extends DefaultUser {
    id: string;
    role: string;
    canRequest?: boolean;
    autoApproveRequests?: boolean;
    canDownload?: boolean;
    canCreateGlobalLists?: boolean;
    // Copied from the database row at sign-in; a bump revokes every session issued before it.
    sessionVersion?: number;
    // An OIDC provider's group claim, checked against the admin/user group settings.
    groups?: unknown;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    role: string;
    canRequest?: boolean;
    autoApproveRequests?: boolean;
    canDownload?: boolean;
    canCreateGlobalLists?: boolean;
    // When the inactivity window last slid (ms since epoch).
    lastActive?: number;
    isImpersonating?: boolean;
  }
}
