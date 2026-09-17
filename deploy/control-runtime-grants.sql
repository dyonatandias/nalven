-- Run as the control migrator (or postgres) after every control migration.
REVOKE CREATE ON SCHEMA public FROM PUBLIC, nalven_app;
GRANT USAGE ON SCHEMA public TO nalven_app;
GRANT CONNECT ON DATABASE nalven TO nalven_app;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM nalven_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nalven_app;
REVOKE ALL ON TABLE public._prisma_migrations FROM nalven_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nalven_app;
ALTER DEFAULT PRIVILEGES FOR ROLE nalven_control_migrator IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nalven_app;
ALTER DEFAULT PRIVILEGES FOR ROLE nalven_control_migrator IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO nalven_app;
