import NextAuth from "next-auth";
import { getAuthOptions } from "./options";

export const dynamic = "force-dynamic";

export async function GET(req: Request, context: any) {
    const options = await getAuthOptions();
    return NextAuth(options)(req, context);
}

export async function POST(req: Request, context: any) {
    const options = await getAuthOptions();
    return NextAuth(options)(req, context);
}