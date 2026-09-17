CREATE ROLE nalven_native_demo_runtime LOGIN;
GRANT CONNECT ON DATABASE nalven_native_demo TO nalven_native_demo_runtime;
GRANT USAGE ON SCHEMA public TO nalven_native_demo_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nalven_native_demo_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nalven_native_demo_runtime;
REVOKE ALL ON TABLE _prisma_migrations FROM nalven_native_demo_runtime;
INSERT INTO tenant_roles(key,name,permissions,updated_at)
VALUES ('native-stock','Estoque de homologação','["stock.read"]',now());
INSERT INTO tenant_user_profiles(user_id,role_id,display_name,email,status,updated_at)
SELECT 'native-member-user',id,'Usuário sintético','member@example.invalid','disabled',now()
FROM tenant_roles WHERE key='native-stock';
