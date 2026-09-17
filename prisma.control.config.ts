import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/control/schema.prisma",
  migrations: { path: "prisma/control/migrations" },
  datasource: { url: env("CONTROL_DATABASE_URL") }
});
