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
    } & DefaultSession["user"];
  }

  interface User extends DefaultUser {
    id: string;
    role: string;
    canRequest?: boolean;
    autoApproveRequests?: boolean;
    canDownload?: boolean;
    canCreateGlobalLists?: boolean;
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
  }
}
