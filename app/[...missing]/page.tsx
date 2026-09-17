import { notFound } from "@/lib/site/server-navigation";
export const dynamic = "force-dynamic";
export default async function MissingPage() { return await notFound(); }
