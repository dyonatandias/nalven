INSERT INTO plans(id,name,monthly_price,annual_price,seats,modules)
VALUES ('native-essential','Essencial',10,100,3,'["*"]'),('native-management','Gestão',20,200,8,'["*"]'),('native-scale','Escala',30,300,25,'["*"]');
INSERT INTO users(id,name,email,password_hash,role,updated_at)
VALUES ('native-admin','Administrador de homologação','audit@example.invalid','not-a-valid-password-hash','superadmin',now());
INSERT INTO users(id,name,email,password_hash,role,updated_at)
VALUES ('native-member-user','Usuário sintético','member@example.invalid','not-a-valid-password-hash','user',now());
INSERT INTO organizations(id,slug,name,document,owner_name,email,plan_id,status,modules,updated_at)
VALUES ('org-demo','native-demo','Auto Mais Peças','native-test-only','Responsável sintético','audit-contact@example.invalid','native-scale','active','["*"]',now());
INSERT INTO tenant_databases(id,organization_id,database_name,config_key,status,schema_version,updated_at)
VALUES ('native-db','org-demo','nalven_native_demo','native-demo','active','native-test',now());
INSERT INTO memberships(id,user_id,organization_id,role,status)
VALUES ('native-member-link','native-member-user','org-demo','native-stock','disabled');
