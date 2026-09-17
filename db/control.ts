import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/control/client";

const url = process.env.CONTROL_DATABASE_URL;
if (!url) throw new Error("CONTROL_DATABASE_URL não foi definida");
const globalDb = globalThis as unknown as { controlDb?: PrismaClient };
export const controlDb = globalDb.controlDb ?? new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
if (process.env.NODE_ENV !== "production") globalDb.controlDb = controlDb;
