import NextAuth from "next-auth";
import { getAuthOptions } from "./options";

const handler = async (req: Request, context: any) => {
  const options = await getAuthOptions();
  return NextAuth(req, context, options);
};

export { handler as GET, handler as POST };