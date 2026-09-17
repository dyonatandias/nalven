\set ON_ERROR_STOP on

-- Irrevocable fail-closed quarantine. It precedes the detailed audit so a
-- partial 321f catalog cannot preserve authority merely by making that audit
-- raise and roll back.
BEGIN;
SELECT set_config('nalven.runtime_role', :'runtime_role', false);
SELECT set_config('nalven.migrator_role', :'migrator_role', false);
SELECT set_config('nalven.manual_worker_role', :'manual_worker_role', false);
SELECT set_config('nalven.manual_callback_role', :'manual_callback_role', false);
SELECT set_config('nalven.stepup_issuer_role', :'stepup_issuer_role', false);
SELECT set_config('nalven.manual_homologator_role', :'manual_homologator_role', false);
SELECT set_config('nalven.manual_vault_binder_role', :'manual_vault_binder_role', false);
SELECT set_config('nalven.manual_profile_admin_issuer_role', :'manual_profile_admin_issuer_role', false);
SELECT set_config('nalven.manual_profile_accounting_issuer_role', :'manual_profile_accounting_issuer_role', false);
SELECT set_config('nalven.manual_profile_fiscal_issuer_role', :'manual_profile_fiscal_issuer_role', false);
SELECT set_config('nalven.manual_sweeper_role', :'manual_sweeper_role', false);
SELECT set_config('nalven.database_name', :'database_name', false);
DO $$
DECLARE acl RECORD; principal TEXT; object_name TEXT;
BEGIN
  IF current_user<>current_setting('nalven.migrator_role') OR current_database()<>current_setting('nalven.database_name') THEN
    RAISE EXCEPTION 'quarantine identity mismatch';
  END IF;
  EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM PUBLIC',current_database());
  REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;
  FOR acl IN SELECT DISTINCT x.grantee FROM pg_database d CROSS JOIN LATERAL aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) x
    WHERE d.datname=current_database() AND x.grantee NOT IN (0,d.datdba) LOOP
    principal:=(SELECT rolname FROM pg_roles WHERE oid=acl.grantee); IF principal IS NOT NULL THEN EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I',current_database(),principal); END IF;
  END LOOP;
  FOR acl IN SELECT DISTINCT x.grantee FROM pg_namespace n CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) x
    WHERE n.nspname='public' AND x.grantee NOT IN (0,n.nspowner) LOOP
    principal:=(SELECT rolname FROM pg_roles WHERE oid=acl.grantee); IF principal IS NOT NULL THEN EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I',principal); END IF;
  END LOOP;
  FOR object_name IN
    SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
       AND left(c.relname,length('pos_manual_'))='pos_manual_'
       AND c.relname<>'pos_manual_payment_references'
  LOOP
    FOR acl IN SELECT DISTINCT x.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('r',c.relowner))) x
      WHERE c.oid=to_regclass('public.'||object_name) AND x.grantee<>c.relowner LOOP
      principal:=CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_roles WHERE oid=acl.grantee) END;
      IF principal='PUBLIC' THEN EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM PUBLIC',object_name);
      ELSIF principal IS NOT NULL THEN EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM %I',object_name,principal); END IF;
    END LOOP;
  END LOOP;
  FOR object_name IN
    SELECT DISTINCT sequence_relation.relname
      FROM pg_class protected_table
      JOIN pg_namespace table_namespace ON table_namespace.oid=protected_table.relnamespace
      JOIN pg_depend dependency ON dependency.refobjid=protected_table.oid AND dependency.deptype IN ('a','i')
      JOIN pg_class sequence_relation ON sequence_relation.oid=dependency.objid AND sequence_relation.relkind='S'
      JOIN pg_namespace sequence_namespace ON sequence_namespace.oid=sequence_relation.relnamespace
     WHERE table_namespace.nspname='public' AND sequence_namespace.nspname='public'
       AND left(protected_table.relname,length('pos_manual_'))='pos_manual_'
       AND protected_table.relname<>'pos_manual_payment_references'
  LOOP
    FOR acl IN SELECT DISTINCT x.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl,acldefault('S',c.relowner))) x
      WHERE c.oid=to_regclass('public.'||object_name) AND x.grantee<>c.relowner LOOP
      principal:=CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_roles WHERE oid=acl.grantee) END;
      IF principal='PUBLIC' THEN EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM PUBLIC',object_name);
      ELSIF principal IS NOT NULL THEN EXECUTE format('REVOKE ALL PRIVILEGES ON SEQUENCE public.%I FROM %I',object_name,principal); END IF;
    END LOOP;
  END LOOP;
  FOR acl IN SELECT DISTINCT p.oid,x.grantee FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) x
    WHERE n.nspname='public'
      AND (left(p.proname,length('pos_manual_'))='pos_manual_'
        OR left(p.proname,length('pos_t2_'))='pos_t2_'
        OR left(p.proname,length('guard_pos_manual_'))='guard_pos_manual_')
      AND x.grantee<>p.proowner LOOP
    principal:=CASE WHEN acl.grantee=0 THEN 'PUBLIC' ELSE (SELECT rolname FROM pg_roles WHERE oid=acl.grantee) END;
    IF principal='PUBLIC' THEN EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC',acl.oid::regprocedure);
    ELSIF principal IS NOT NULL THEN EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %I',acl.oid::regprocedure,principal); END IF;
  END LOOP;
END $$;
COMMIT;

BEGIN;

SELECT set_config('nalven.runtime_role', :'runtime_role', false);
SELECT set_config('nalven.migrator_role', :'migrator_role', false);
SELECT set_config('nalven.manual_worker_role', :'manual_worker_role', false);
SELECT set_config('nalven.manual_callback_role', :'manual_callback_role', false);
SELECT set_config('nalven.stepup_issuer_role', :'stepup_issuer_role', false);
SELECT set_config('nalven.manual_homologator_role', :'manual_homologator_role', false);
SELECT set_config('nalven.manual_vault_binder_role', :'manual_vault_binder_role', false);
SELECT set_config('nalven.manual_profile_admin_issuer_role', :'manual_profile_admin_issuer_role', false);
SELECT set_config('nalven.manual_profile_accounting_issuer_role', :'manual_profile_accounting_issuer_role', false);
SELECT set_config('nalven.manual_profile_fiscal_issuer_role', :'manual_profile_fiscal_issuer_role', false);
SELECT set_config('nalven.manual_sweeper_role', :'manual_sweeper_role', false);
SELECT set_config('nalven.database_name', :'database_name', false);

-- The T2-01 migration intentionally creates an empty owner-only registry.
-- Reconcile is the sole writer of the nominal tenant authorities. T2-02 adds
-- manual_sweeper only when its migration ledger and final ABI both exist. A
-- non-empty partial or altered registry is evidence of drift, never repaired
-- silently.
DO $$
DECLARE
  expected_count INTEGER;
  t2_02_ledger BOOLEAN := EXISTS (SELECT 1 FROM public._prisma_migrations
    WHERE migration_name='20260829322200_pos_manual_payment_t2_reservations'
      AND checksum='6acebb13b4b0abfb8d91667940e080017f8402dbce055e19582ecd3c8e8f8465'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count=1);
  t2_02_abi BOOLEAN := to_regprocedure('public.pos_manual_sweep_expired_applications_v1(text,integer,text,text)') IS NOT NULL;
BEGIN
  IF to_regclass('public.pos_manual_t2_authorities') IS NULL THEN RETURN; END IF;
  IF t2_02_ledger IS DISTINCT FROM t2_02_abi THEN
    RAISE EXCEPTION 'partial T2-02 deployment: sweep migration/ABI mismatch';
  END IF;
  SELECT count(*)::integer INTO expected_count FROM public.pos_manual_t2_authorities;
  IF expected_count=0 THEN
    INSERT INTO public.pos_manual_t2_authorities(capability,role_name,authority_hash)
    SELECT expected.capability,expected.role_name,
      encode(sha256(convert_to('t2-authority-v1','UTF8')||decode('00','hex')||
        convert_to(current_database(),'UTF8')||decode('00','hex')||convert_to(expected.role_name::text,'UTF8')),'hex')
    FROM (VALUES
      ('runtime',current_setting('nalven.runtime_role')::NAME),
      ('manual_callback',current_setting('nalven.manual_callback_role')::NAME),
      ('manual_worker',current_setting('nalven.manual_worker_role')::NAME),
      ('manual_vault_binder',current_setting('nalven.manual_vault_binder_role')::NAME),
      ('profile_homologator',current_setting('nalven.manual_homologator_role')::NAME),
      ('profile_admin_issuer',current_setting('nalven.manual_profile_admin_issuer_role')::NAME),
      ('profile_accounting_issuer',current_setting('nalven.manual_profile_accounting_issuer_role')::NAME),
      ('profile_fiscal_issuer',current_setting('nalven.manual_profile_fiscal_issuer_role')::NAME)
    ) expected(capability,role_name);
    IF t2_02_abi THEN
      INSERT INTO public.pos_manual_t2_authorities(capability,role_name,authority_hash)
      VALUES ('manual_sweeper',current_setting('nalven.manual_sweeper_role')::NAME,
        encode(sha256(convert_to('t2-authority-v1','UTF8')||decode('00','hex')||
          convert_to(current_database(),'UTF8')||decode('00','hex')||
          convert_to(current_setting('nalven.manual_sweeper_role'),'UTF8')),'hex'));
    END IF;
  ELSIF expected_count=8 AND t2_02_abi AND NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('runtime',current_setting('nalven.runtime_role')::NAME),
      ('manual_callback',current_setting('nalven.manual_callback_role')::NAME),
      ('manual_worker',current_setting('nalven.manual_worker_role')::NAME),
      ('manual_vault_binder',current_setting('nalven.manual_vault_binder_role')::NAME),
      ('profile_homologator',current_setting('nalven.manual_homologator_role')::NAME),
      ('profile_admin_issuer',current_setting('nalven.manual_profile_admin_issuer_role')::NAME),
      ('profile_accounting_issuer',current_setting('nalven.manual_profile_accounting_issuer_role')::NAME),
      ('profile_fiscal_issuer',current_setting('nalven.manual_profile_fiscal_issuer_role')::NAME)
    ) expected(capability,role_name)
    LEFT JOIN public.pos_manual_t2_authorities actual USING(capability)
    WHERE actual.capability IS NULL OR actual.role_name IS DISTINCT FROM expected.role_name
      OR actual.authority_hash IS DISTINCT FROM encode(sha256(convert_to('t2-authority-v1','UTF8')||decode('00','hex')||
        convert_to(current_database(),'UTF8')||decode('00','hex')||convert_to(expected.role_name::text,'UTF8')),'hex')
  ) THEN
    INSERT INTO public.pos_manual_t2_authorities(capability,role_name,authority_hash)
    VALUES ('manual_sweeper',current_setting('nalven.manual_sweeper_role')::NAME,
      encode(sha256(convert_to('t2-authority-v1','UTF8')||decode('00','hex')||
        convert_to(current_database(),'UTF8')||decode('00','hex')||
        convert_to(current_setting('nalven.manual_sweeper_role'),'UTF8')),'hex'));
  END IF;
  SELECT count(*)::integer INTO expected_count FROM public.pos_manual_t2_authorities;
  IF expected_count<>(8+CASE WHEN t2_02_abi THEN 1 ELSE 0 END) OR EXISTS (
    SELECT 1 FROM (
      SELECT * FROM (VALUES
        ('runtime',current_setting('nalven.runtime_role')::NAME),
        ('manual_callback',current_setting('nalven.manual_callback_role')::NAME),
        ('manual_worker',current_setting('nalven.manual_worker_role')::NAME),
        ('manual_vault_binder',current_setting('nalven.manual_vault_binder_role')::NAME),
        ('profile_homologator',current_setting('nalven.manual_homologator_role')::NAME),
        ('profile_admin_issuer',current_setting('nalven.manual_profile_admin_issuer_role')::NAME),
        ('profile_accounting_issuer',current_setting('nalven.manual_profile_accounting_issuer_role')::NAME),
        ('profile_fiscal_issuer',current_setting('nalven.manual_profile_fiscal_issuer_role')::NAME)
      ) base(capability,role_name)
      UNION ALL SELECT 'manual_sweeper',current_setting('nalven.manual_sweeper_role')::NAME WHERE t2_02_abi
    ) expected
    LEFT JOIN public.pos_manual_t2_authorities actual USING(capability)
    WHERE actual.capability IS NULL OR actual.role_name IS DISTINCT FROM expected.role_name
      OR actual.authority_hash IS DISTINCT FROM encode(sha256(convert_to('t2-authority-v1','UTF8')||decode('00','hex')||
        convert_to(current_database(),'UTF8')||decode('00','hex')||convert_to(expected.role_name::text,'UTF8')),'hex')
  ) THEN
    RAISE EXCEPTION 'T2 authority registry manifest mismatch';
  END IF;
END
$$;

DO $$
DECLARE
  runtime RECORD;
  operational RECORD;
  operational_role NAME;
  operational_roles NAME[] := ARRAY[
    current_setting('nalven.runtime_role')::NAME,
    current_setting('nalven.manual_worker_role')::NAME,
    current_setting('nalven.manual_callback_role')::NAME,
    current_setting('nalven.stepup_issuer_role')::NAME,
    current_setting('nalven.manual_homologator_role')::NAME,
    current_setting('nalven.manual_vault_binder_role')::NAME,
    current_setting('nalven.manual_profile_admin_issuer_role')::NAME,
    current_setting('nalven.manual_profile_accounting_issuer_role')::NAME,
    current_setting('nalven.manual_profile_fiscal_issuer_role')::NAME,
    current_setting('nalven.manual_sweeper_role')::NAME
  ];
  database_owner NAME;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=current_setting('nalven.migrator_role') AND rolcanlogin AND NOT rolinherit
    AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'migrator role attributes are unsafe';
  END IF;
  IF current_user <> current_setting('nalven.migrator_role') THEN
    RAISE EXCEPTION 'grant reconciliation must run as migrator %, not %',
      current_setting('nalven.migrator_role'), current_user;
  END IF;

  IF current_database() <> current_setting('nalven.database_name') THEN
    RAISE EXCEPTION 'grant reconciliation targeted database %, not %',
      current_database(), current_setting('nalven.database_name');
  END IF;

  SELECT pg_get_userbyid(datdba)
    INTO database_owner
    FROM pg_database
   WHERE datname = current_database();
  IF database_owner IS DISTINCT FROM current_user THEN
    RAISE EXCEPTION 'migrator % does not own database %', current_user, current_database();
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_auth_members membership
     WHERE membership.member = (SELECT oid FROM pg_roles WHERE rolname = current_setting('nalven.migrator_role'))
        OR membership.roleid = (SELECT oid FROM pg_roles WHERE rolname = current_setting('nalven.migrator_role'))
  ) THEN
    RAISE EXCEPTION 'migrator role % must not have memberships', current_setting('nalven.migrator_role');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relkind IN ('r','p','v','m','S','f')
       AND pg_get_userbyid(relation.relowner) IS DISTINCT FROM current_setting('nalven.migrator_role')
  ) OR EXISTS (
    SELECT 1
      FROM pg_proc routine
      JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
     WHERE namespace.nspname = 'public'
       AND pg_get_userbyid(routine.proowner) IS DISTINCT FROM current_setting('nalven.migrator_role')
  ) THEN
    RAISE EXCEPTION 'public object owner is not the migrator';
  END IF;

  SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
         rolreplication, rolbypassrls
    INTO runtime
    FROM pg_roles
   WHERE rolname = current_setting('nalven.runtime_role');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'runtime role % does not exist', current_setting('nalven.runtime_role');
  END IF;
  IF runtime.rolsuper OR runtime.rolinherit OR runtime.rolcreaterole OR runtime.rolcreatedb
     OR NOT runtime.rolcanlogin OR runtime.rolreplication OR runtime.rolbypassrls THEN
    RAISE EXCEPTION 'runtime role % has unsafe attributes', runtime.rolname;
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_auth_members membership
     WHERE membership.member = (
       SELECT oid FROM pg_roles WHERE rolname = current_setting('nalven.runtime_role')
     ) OR membership.roleid = (
       SELECT oid FROM pg_roles WHERE rolname = current_setting('nalven.runtime_role')
     )
  ) THEN
    RAISE EXCEPTION 'runtime role % must not inherit membership', current_setting('nalven.runtime_role');
  END IF;

  IF EXISTS (
    SELECT 1
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND pg_get_userbyid(relation.relowner) = current_setting('nalven.runtime_role')
  ) OR EXISTS (
    SELECT 1
      FROM pg_proc routine
      JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
     WHERE namespace.nspname = 'public'
       AND pg_get_userbyid(routine.proowner) = current_setting('nalven.runtime_role')
  ) THEN
    RAISE EXCEPTION 'runtime role % owns objects in public; manual legacy cutover required',
      current_setting('nalven.runtime_role');
  END IF;

  IF cardinality(ARRAY(SELECT DISTINCT role_name FROM unnest(operational_roles) AS role_name))
       <> cardinality(operational_roles)
     OR current_setting('nalven.migrator_role')::NAME = ANY(operational_roles) THEN
    RAISE EXCEPTION 'migrator and operational roles must all be distinct';
  END IF;

  FOREACH operational_role IN ARRAY operational_roles
  LOOP
    SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
           rolreplication, rolbypassrls
      INTO operational
      FROM pg_roles
     WHERE rolname = operational_role;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'operational role % does not exist', operational_role;
    END IF;
    IF operational.rolsuper OR operational.rolinherit OR operational.rolcreaterole
       OR operational.rolcreatedb OR NOT operational.rolcanlogin
       OR operational.rolreplication OR operational.rolbypassrls THEN
      RAISE EXCEPTION 'operational role % has unsafe attributes', operational_role;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_auth_members membership
       WHERE membership.member = (SELECT oid FROM pg_roles WHERE rolname = operational_role)
          OR membership.roleid = (SELECT oid FROM pg_roles WHERE rolname = operational_role)
    ) THEN
      RAISE EXCEPTION 'operational role % must not have memberships', operational_role;
    END IF;
    IF EXISTS (
      SELECT 1
        FROM pg_class relation
        JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = 'public'
         AND pg_get_userbyid(relation.relowner) = operational_role
    ) OR EXISTS (
      SELECT 1
        FROM pg_proc routine
        JOIN pg_namespace namespace ON namespace.oid = routine.pronamespace
       WHERE namespace.nspname = 'public'
         AND pg_get_userbyid(routine.proowner) = operational_role
    ) THEN
      RAISE EXCEPTION 'operational role % owns objects in public', operational_role;
    END IF;
  END LOOP;
  IF NOT EXISTS (
    SELECT 1 FROM pg_db_role_setting setting
     WHERE setting.setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database())
       AND setting.setrole=(SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.manual_sweeper_role'))
       AND setting.setconfig=ARRAY['default_transaction_isolation=serializable']::TEXT[]
  ) OR EXISTS (
    SELECT 1 FROM pg_db_role_setting setting
     WHERE setting.setrole=(SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.manual_sweeper_role'))
       AND setting.setdatabase<>(SELECT oid FROM pg_database WHERE datname=current_database())
  ) THEN
    RAISE EXCEPTION 'manual sweeper role must have only the database-scoped SERIALIZABLE default';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_db_role_setting setting
     WHERE setting.setrole=(SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.runtime_role'))
       AND EXISTS (SELECT 1 FROM unnest(setting.setconfig) item WHERE item LIKE 'default_transaction_isolation=%')
  ) THEN
    RAISE EXCEPTION 'runtime role must not override default_transaction_isolation';
  END IF;
END
$$;

ALTER SCHEMA public OWNER TO :"migrator_role";

REVOKE ALL PRIVILEGES ON DATABASE :"database_name" FROM PUBLIC;
REVOKE ALL PRIVILEGES ON DATABASE :"database_name" FROM :"runtime_role";
REVOKE ALL PRIVILEGES ON DATABASE :"database_name" FROM :"manual_worker_role";
REVOKE ALL PRIVILEGES ON DATABASE :"database_name" FROM :"manual_callback_role";
REVOKE ALL PRIVILEGES ON DATABASE :"database_name" FROM :"stepup_issuer_role";
REVOKE ALL PRIVILEGES ON DATABASE :"database_name" FROM :"manual_homologator_role";
REVOKE ALL PRIVILEGES ON DATABASE :"database_name" FROM :"manual_vault_binder_role";
REVOKE ALL PRIVILEGES ON DATABASE :"database_name" FROM :"manual_profile_admin_issuer_role";
REVOKE ALL PRIVILEGES ON DATABASE :"database_name" FROM :"manual_profile_accounting_issuer_role";
REVOKE ALL PRIVILEGES ON DATABASE :"database_name" FROM :"manual_profile_fiscal_issuer_role";
REVOKE ALL PRIVILEGES ON DATABASE :"database_name" FROM :"manual_sweeper_role";
GRANT CONNECT ON DATABASE :"database_name" TO :"runtime_role";
GRANT CONNECT ON DATABASE :"database_name" TO :"manual_worker_role";
GRANT CONNECT ON DATABASE :"database_name" TO :"manual_callback_role";
GRANT CONNECT ON DATABASE :"database_name" TO :"stepup_issuer_role";
GRANT CONNECT ON DATABASE :"database_name" TO :"manual_homologator_role";
GRANT CONNECT ON DATABASE :"database_name" TO :"manual_vault_binder_role";
GRANT CONNECT ON DATABASE :"database_name" TO :"manual_profile_admin_issuer_role";
GRANT CONNECT ON DATABASE :"database_name" TO :"manual_profile_accounting_issuer_role";
GRANT CONNECT ON DATABASE :"database_name" TO :"manual_profile_fiscal_issuer_role";
GRANT CONNECT ON DATABASE :"database_name" TO :"manual_sweeper_role";

REVOKE ALL PRIVILEGES ON SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON SCHEMA public FROM :"runtime_role";
REVOKE ALL PRIVILEGES ON SCHEMA public FROM :"manual_worker_role";
REVOKE ALL PRIVILEGES ON SCHEMA public FROM :"manual_callback_role";
REVOKE ALL PRIVILEGES ON SCHEMA public FROM :"stepup_issuer_role";
REVOKE ALL PRIVILEGES ON SCHEMA public FROM :"manual_homologator_role";
REVOKE ALL PRIVILEGES ON SCHEMA public FROM :"manual_vault_binder_role";
REVOKE ALL PRIVILEGES ON SCHEMA public FROM :"manual_profile_admin_issuer_role";
REVOKE ALL PRIVILEGES ON SCHEMA public FROM :"manual_profile_accounting_issuer_role";
REVOKE ALL PRIVILEGES ON SCHEMA public FROM :"manual_profile_fiscal_issuer_role";
REVOKE ALL PRIVILEGES ON SCHEMA public FROM :"manual_sweeper_role";
GRANT USAGE ON SCHEMA public TO :"runtime_role";
GRANT USAGE ON SCHEMA public TO :"manual_worker_role";
GRANT USAGE ON SCHEMA public TO :"manual_callback_role";
GRANT USAGE ON SCHEMA public TO :"stepup_issuer_role";
GRANT USAGE ON SCHEMA public TO :"manual_homologator_role";
GRANT USAGE ON SCHEMA public TO :"manual_vault_binder_role";
GRANT USAGE ON SCHEMA public TO :"manual_profile_admin_issuer_role";
GRANT USAGE ON SCHEMA public TO :"manual_profile_accounting_issuer_role";
GRANT USAGE ON SCHEMA public TO :"manual_profile_fiscal_issuer_role";
GRANT USAGE ON SCHEMA public TO :"manual_sweeper_role";

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM :"runtime_role";
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM :"manual_worker_role";
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM :"manual_callback_role";
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM :"stepup_issuer_role";
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM :"manual_homologator_role";
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM :"manual_vault_binder_role";
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM :"manual_profile_admin_issuer_role";
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM :"manual_profile_accounting_issuer_role";
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM :"manual_profile_fiscal_issuer_role";
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM :"manual_sweeper_role";
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO :"runtime_role";

DO $$
DECLARE
  immutable_table TEXT;
BEGIN
  FOREACH immutable_table IN ARRAY ARRAY[
    'audit_events',
    'integration_audit_log',
    'privacy_incident_events',
    'privacy_request_events',
    'pos_accounting_journals',
    'pos_accounting_postings',
    'pos_cash_custody_bags',
    'pos_cash_custody_events',
    'pos_cash_custody_incident_resolutions',
    'pos_cash_custody_incidents',
    'pos_cash_ledger_entries',
    'pos_fiscal_artifacts',
    'pos_fiscal_callbacks',
    'pos_fiscal_delivery_results',
    'pos_fiscal_state_events',
    'pos_held_sale_transfers',
    'pos_kit_component_return_movements',
    'pos_lgpd_evidence',
    'pos_lgpd_request_state_ledger',
    'pos_order_claim_operations',
    'pos_payment_plan_operations',
    'pos_payment_plan_quote_lines',
    'pos_payment_plan_slots',
    'pos_payment_callbacks',
    'pos_payment_delivery_results',
    'pos_payment_state_events',
    'pos_reconciliation_issues',
    'pos_reconciliation_lines',
    'pos_reconciliation_runs',
    'pos_value_ledger_entries'
  ]
  LOOP
    IF to_regclass(format('public.%I', immutable_table)) IS NOT NULL THEN
      EXECUTE format(
        'REVOKE UPDATE, DELETE ON TABLE public.%I FROM %I',
        immutable_table,
        current_setting('nalven.runtime_role')
      );
    END IF;
  END LOOP;

  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON TABLE public._prisma_migrations FROM %I',
      current_setting('nalven.runtime_role')
    );
  END IF;
END
$$;

-- A wave 320000 nasce completamente inacessível. O legado singular
-- pos_manual_payment_references continua sob a matriz histórica apenas para
-- consulta/revogação; nenhum objeto plural novo é herdado por convenção.
DO $$
DECLARE
  protected_relation RECORD;
  operational_role NAME;
  operational_roles NAME[] := ARRAY[
    current_setting('nalven.runtime_role')::NAME,
    current_setting('nalven.manual_worker_role')::NAME,
    current_setting('nalven.manual_callback_role')::NAME,
    current_setting('nalven.stepup_issuer_role')::NAME,
    current_setting('nalven.manual_homologator_role')::NAME,
    current_setting('nalven.manual_vault_binder_role')::NAME,
    current_setting('nalven.manual_profile_admin_issuer_role')::NAME,
    current_setting('nalven.manual_profile_accounting_issuer_role')::NAME,
    current_setting('nalven.manual_profile_fiscal_issuer_role')::NAME,
    current_setting('nalven.manual_sweeper_role')::NAME
  ];
BEGIN
  FOR protected_relation IN
    SELECT namespace.nspname, relation.relname
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND left(relation.relname,length('pos_manual_'))='pos_manual_'
       AND relation.relname <> 'pos_manual_payment_references'
  LOOP
    FOREACH operational_role IN ARRAY operational_roles
    LOOP
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM %I',
        protected_relation.nspname,
        protected_relation.relname,
        operational_role
      );
    END LOOP;
  END LOOP;
END
$$;

REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM :"runtime_role";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM :"manual_worker_role";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM :"manual_callback_role";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM :"stepup_issuer_role";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM :"manual_homologator_role";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM :"manual_vault_binder_role";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM :"manual_profile_admin_issuer_role";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM :"manual_profile_accounting_issuer_role";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM :"manual_profile_fiscal_issuer_role";
REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM :"manual_sweeper_role";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO :"runtime_role";

DO $$
DECLARE
  protected_sequence RECORD;
  operational_role NAME;
  operational_roles NAME[] := ARRAY[
    current_setting('nalven.runtime_role')::NAME,
    current_setting('nalven.manual_worker_role')::NAME,
    current_setting('nalven.manual_callback_role')::NAME,
    current_setting('nalven.stepup_issuer_role')::NAME,
    current_setting('nalven.manual_homologator_role')::NAME,
    current_setting('nalven.manual_vault_binder_role')::NAME,
    current_setting('nalven.manual_profile_admin_issuer_role')::NAME,
    current_setting('nalven.manual_profile_accounting_issuer_role')::NAME,
    current_setting('nalven.manual_profile_fiscal_issuer_role')::NAME,
    current_setting('nalven.manual_sweeper_role')::NAME
  ];
BEGIN
  FOR protected_sequence IN
    SELECT DISTINCT sequence_namespace.nspname, sequence_relation.relname
      FROM pg_class protected_table
      JOIN pg_namespace table_namespace ON table_namespace.oid = protected_table.relnamespace
      JOIN pg_depend dependency
        ON dependency.refobjid = protected_table.oid
       AND dependency.deptype IN ('a', 'i')
      JOIN pg_class sequence_relation
        ON sequence_relation.oid = dependency.objid
       AND sequence_relation.relkind = 'S'
      JOIN pg_namespace sequence_namespace ON sequence_namespace.oid = sequence_relation.relnamespace
     WHERE table_namespace.nspname = 'public'
       AND left(protected_table.relname,length('pos_manual_'))='pos_manual_'
       AND protected_table.relname <> 'pos_manual_payment_references'
  LOOP
    FOREACH operational_role IN ARRAY operational_roles
    LOOP
      EXECUTE format(
        'REVOKE ALL PRIVILEGES ON SEQUENCE %I.%I FROM %I',
        protected_sequence.nspname,
        protected_sequence.relname,
        operational_role
      );
    END LOOP;
  END LOOP;
END
$$;

REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM :"runtime_role";
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM :"manual_worker_role";
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM :"manual_callback_role";
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM :"stepup_issuer_role";
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM :"manual_homologator_role";
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM :"manual_vault_binder_role";
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM :"manual_profile_admin_issuer_role";
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM :"manual_profile_accounting_issuer_role";
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM :"manual_profile_fiscal_issuer_role";
REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM :"manual_sweeper_role";

DO $$
BEGIN
  IF to_regprocedure('public.nalven_audit_fingerprint(text,text,text,text,text,text,jsonb,jsonb,text,text,text,integer,timestamp with time zone)') IS NOT NULL THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.nalven_audit_fingerprint(text,text,text,text,text,text,jsonb,jsonb,text,text,text,integer,timestamp with time zone) TO %I',
      current_setting('nalven.runtime_role')
    );
  END IF;
END
$$;

-- Quarantine is committed independently: if the strict 321f graph check below
-- rejects partial drift, stale operational/PUBLIC authority stays revoked.
COMMIT;
BEGIN;
SELECT set_config('nalven.runtime_role', :'runtime_role', false);
SELECT set_config('nalven.migrator_role', :'migrator_role', false);
SELECT set_config('nalven.manual_worker_role', :'manual_worker_role', false);
SELECT set_config('nalven.manual_callback_role', :'manual_callback_role', false);
SELECT set_config('nalven.stepup_issuer_role', :'stepup_issuer_role', false);
SELECT set_config('nalven.manual_homologator_role', :'manual_homologator_role', false);
SELECT set_config('nalven.manual_vault_binder_role', :'manual_vault_binder_role', false);
SELECT set_config('nalven.manual_profile_admin_issuer_role', :'manual_profile_admin_issuer_role', false);
SELECT set_config('nalven.manual_profile_accounting_issuer_role', :'manual_profile_accounting_issuer_role', false);
SELECT set_config('nalven.manual_profile_fiscal_issuer_role', :'manual_profile_fiscal_issuer_role', false);
SELECT set_config('nalven.manual_sweeper_role', :'manual_sweeper_role', false);
SELECT set_config('nalven.database_name', :'database_name', false);

-- Before 321f, complete absence is valid. Once any table/function marker is
-- visible, partial deployment is rejected before capabilities are granted.
DO $$
DECLARE
  signatures TEXT[] := ARRAY[
    'public.pos_manual_prepare_open_v1(text,integer,integer,text,timestamptz,text,text,text)',
    'public.pos_manual_open_status_v1(uuid,integer,text,text)',
    'public.pos_manual_claim_open_for_vault_v1(uuid,text,text,text,integer)',
    'public.pos_manual_open_case_v1(uuid,text,bigint,text,text,text,text,text,text,text,text,text,text,timestamptz,timestamptz,text)',
    'public.pos_manual_abandon_open_v1(uuid,text,bigint,text,text)',
    'public.pos_manual_probe_open_v1(uuid,text)'
  ];
  signature TEXT;
  helper_signatures TEXT[] := ARRAY[
    'public.guard_pos_manual_vault_binding_321f()', 'public.guard_pos_manual_open_request_321f()',
    'public.validate_pos_manual_open_graph_321f()', 'public.validate_pos_manual_open_graph_vertex_321f()',
    'public.pos_manual_lock_open_graph_321f(uuid)', 'public.pos_manual_open_boundary_failure_321f(uuid,timestamptz)',
    'public.pos_manual_identifier_contains_pan_321f(text)'];
  required_open_columns TEXT[] := ARRAY['id','prepare_request_hash','ticket_hash','ticket_expires_at','vault_idempotency_key','state',
    'lease_token_hash','lease_expires_at','fencing_token','case_id','vault_proof_id','lifecycle_txid','prepared_at','updated_at'];
  expected TEXT;
  shape RECORD;
  marker_present BOOLEAN := to_regclass('public.pos_manual_open_requests') IS NOT NULL
    OR to_regclass('public.pos_manual_vault_proofs') IS NOT NULL
    OR to_regclass('public.pos_manual_payment_vault_verifiers') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.pos_manual_payment_vault_bindings')
      AND attname IN ('vault_proof_id','binding_kind') AND attnum>0 AND NOT attisdropped)
    OR EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND p.proname IN ('guard_pos_manual_vault_binding_321f','guard_pos_manual_open_request_321f',
    'validate_pos_manual_open_graph_321f','validate_pos_manual_open_graph_vertex_321f',
        'pos_manual_lock_open_graph_321f','pos_manual_open_boundary_failure_321f','pos_manual_identifier_contains_pan_321f'))
    OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname IN ('pos_manual_open_requests_state_lease_idx',
        'pos_manual_open_requests_session_state_idx','pos_manual_open_requests_plan_slot_idx'))
    OR EXISTS (SELECT 1 FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('pos_manual_vault_binding_321f_guard',
      'pos_manual_vault_proofs_append_only','pos_manual_open_requests_delete_guard','pos_manual_open_requests_guard',
      'pos_manual_open_graph_guard','pos_manual_open_graph_from_proof','pos_manual_open_graph_from_case',
      'pos_manual_open_graph_from_binding','pos_manual_open_graph_from_operation','pos_manual_open_graph_from_event'));
BEGIN
  FOREACH signature IN ARRAY signatures LOOP marker_present := marker_present OR to_regprocedure(signature) IS NOT NULL; END LOOP;
  IF NOT marker_present THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public._prisma_migrations WHERE migration_name='20260829321200_pos_manual_open_vault_capabilities'
    AND checksum='ec7b4f84b9321a93a204d6b15b0c727169e3752d0e5a580f1b4dcb730adfc281'
    AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count=1) THEN
    RAISE EXCEPTION 'partial 321f deployment: migration ledger missing or checksum mismatch';
  END IF;
  IF to_regclass('public.pos_manual_open_requests') IS NULL OR to_regclass('public.pos_manual_vault_proofs') IS NULL
    OR to_regclass('public.pos_manual_payment_vault_verifiers') IS NULL
    OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.pos_manual_payment_vault_bindings')
      AND attname='vault_proof_id' AND attnum>0 AND NOT attisdropped)
    OR NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.pos_manual_payment_vault_bindings')
      AND attname='binding_kind' AND attnum>0 AND NOT attisdropped) THEN
    RAISE EXCEPTION 'partial 321f deployment: tables or binding proof column missing';
  END IF;
  FOREACH signature IN ARRAY signatures LOOP
    IF to_regprocedure(signature) IS NULL THEN RAISE EXCEPTION 'partial 321f deployment: function missing: %',signature; END IF;
  END LOOP;
  FOREACH signature IN ARRAY helper_signatures LOOP
    IF to_regprocedure(signature) IS NULL THEN RAISE EXCEPTION 'partial 321f deployment: helper missing: %',signature; END IF;
  END LOOP;
  FOR shape IN SELECT * FROM (VALUES
    ('pos_manual_vault_binding_321f_guard','pos_manual_payment_vault_bindings','public.guard_pos_manual_vault_binding_321f()'::text,false,false,23,'5d25901c1c3ab05973b0bae277a13a531b90c2bfe2faee48334d1e7b6193a1e5'),
    ('pos_manual_vault_proofs_append_only','pos_manual_vault_proofs','public.protect_pos_manual_append_only()',false,false,27,'2f7d641cf8f8bf97882c73e3ee3908e2b04df27c68c21d5bf15e145d7a0151b1'),
    ('pos_manual_open_requests_delete_guard','pos_manual_open_requests','public.protect_pos_manual_append_only()',false,false,11,'bf9f64a949b1bd4e9ffef01b26949e1978bfac55b210ba53c148cd8cb657c4d7'),
    ('pos_manual_open_requests_guard','pos_manual_open_requests','public.guard_pos_manual_open_request_321f()',false,false,19,'633bc1b3533d7053437169a25c192d76acef43a4cd43f914a31391e8fb0baac4'),
    ('pos_manual_open_graph_guard','pos_manual_open_requests','public.validate_pos_manual_open_graph_321f()',true,true,21,'1c34a0d7d2e564866d85adbc0573f83edfe1d3f90907a837f9681dfed4ef0a36'),
    ('pos_manual_open_graph_from_proof','pos_manual_vault_proofs','public.validate_pos_manual_open_graph_vertex_321f()',true,true,29,'8fe146b20cff5547a9eb5734076554d8b8712e0883d12c992c002bd535a8dd51'),
    ('pos_manual_open_graph_from_case','pos_manual_payment_cases','public.validate_pos_manual_open_graph_vertex_321f()',true,true,29,'c936222c8218126d687686630bb205e11a7398b7651eb2b5484059d90fa392a1'),
    ('pos_manual_open_graph_from_binding','pos_manual_payment_vault_bindings','public.validate_pos_manual_open_graph_vertex_321f()',true,true,29,'d54b0c23a41946885a27c736889ef569a9fce6c4ce2aba944fce1f2f2cd71ba3'),
    ('pos_manual_open_graph_from_operation','pos_manual_payment_operations','public.validate_pos_manual_open_graph_vertex_321f()',true,true,29,'ae4c7421f219d448738a6562ae2873cad3ca73bc7f99030a17988f3b3cc6afd7'),
    ('pos_manual_open_graph_from_event','pos_manual_payment_state_events','public.validate_pos_manual_open_graph_vertex_321f()',true,true,29,'2d607ec6d50a53520ab72a453af3a8c6382dd045efea84e7bf45323aae2615d5')
  ) AS v(trigger_name,table_name,function_signature,is_deferrable,is_initially_deferred,expected_tgtype,definition_sha256) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND t.tgname=shape.trigger_name AND c.relname=shape.table_name
        AND t.tgfoid=to_regprocedure(shape.function_signature) AND NOT t.tgisinternal AND t.tgenabled='O'
        AND t.tgdeferrable=shape.is_deferrable AND t.tginitdeferred=shape.is_initially_deferred AND t.tgtype=shape.expected_tgtype
        AND encode(sha256(convert_to(regexp_replace(pg_get_triggerdef(t.oid,true),'[[:space:]]+',' ','g'),'UTF8')),'hex')=shape.definition_sha256) THEN
      RAISE EXCEPTION 'partial 321f deployment: trigger shape mismatch: %',shape.trigger_name;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname IN ('pos_manual_vault_binding_321f_guard','pos_manual_vault_proofs_append_only','pos_manual_open_requests_delete_guard','pos_manual_open_requests_guard','pos_manual_open_graph_guard','pos_manual_open_graph_from_proof','pos_manual_open_graph_from_case','pos_manual_open_graph_from_binding','pos_manual_open_graph_from_operation','pos_manual_open_graph_from_event'))<>10 THEN
    RAISE EXCEPTION 'partial 321f deployment: trigger allowlist mismatch';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal
    AND c.relname IN ('pos_manual_open_requests','pos_manual_vault_proofs','pos_manual_payment_cases','pos_manual_payment_vault_bindings','pos_manual_payment_operations','pos_manual_payment_state_events')
    AND t.tgfoid IN (to_regprocedure('public.guard_pos_manual_vault_binding_321f()'),to_regprocedure('public.guard_pos_manual_open_request_321f()'),to_regprocedure('public.validate_pos_manual_open_graph_321f()'),to_regprocedure('public.validate_pos_manual_open_graph_vertex_321f()')))<>8 THEN
    RAISE EXCEPTION 'partial 321f deployment: extra or missing helper trigger';
  END IF;
  IF (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal
      AND c.relname IN ('pos_manual_open_requests','pos_manual_vault_proofs','pos_manual_payment_cases','pos_manual_payment_vault_bindings','pos_manual_payment_operations','pos_manual_payment_state_events'))<>20
    OR EXISTS (SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal
      AND c.relname IN ('pos_manual_open_requests','pos_manual_vault_proofs','pos_manual_payment_cases','pos_manual_payment_vault_bindings','pos_manual_payment_operations','pos_manual_payment_state_events')
      AND t.tgname<>ALL(ARRAY['pos_manual_open_graph_guard','pos_manual_open_requests_delete_guard','pos_manual_open_requests_guard','pos_manual_case_guard','pos_manual_case_open_commit_guard','pos_manual_open_graph_from_case','pos_manual_open_graph_from_operation','pos_manual_operation_graph_guard','pos_manual_operation_insert_guard','pos_manual_operations_append_only','pos_manual_open_graph_from_event','pos_manual_state_event_graph_guard','pos_manual_state_event_insert_guard','pos_manual_state_event_stamp','pos_manual_state_events_append_only','pos_manual_open_graph_from_binding','pos_manual_vault_binding_321f_guard','pos_manual_vault_bindings_append_only','pos_manual_open_graph_from_proof','pos_manual_vault_proofs_append_only'])) THEN
    RAISE EXCEPTION 'partial 321f deployment: graph trigger catalog mismatch';
  END IF;
  IF (SELECT encode(sha256(convert_to(string_agg(pg_get_triggerdef(t.oid,true),E'\n' ORDER BY pg_get_triggerdef(t.oid,true)),'UTF8')),'hex')
      FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE NOT t.tgisinternal
        AND c.relname IN ('pos_manual_open_requests','pos_manual_vault_proofs','pos_manual_payment_cases','pos_manual_payment_vault_bindings','pos_manual_payment_operations','pos_manual_payment_state_events'))
      <>'71a6c22b15058270086445e41193ebed2cd34134addd27cd50becc7c5739bd58' THEN
    RAISE EXCEPTION 'partial 321f deployment: full trigger definition manifest mismatch';
  END IF;
  FOR shape IN SELECT * FROM (VALUES
    ('pos_manual_open_requests_state_lease_idx',ARRAY['state','lease_expires_at']::text[]),
    ('pos_manual_open_requests_session_state_idx',ARRAY['session_id','state']::text[]),
    ('pos_manual_open_requests_plan_slot_idx',ARRAY['payment_plan_id','payment_index']::text[])
  ) AS v(index_name,key_names) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_index i WHERE i.indexrelid=to_regclass('public.'||shape.index_name)
      AND i.indrelid=to_regclass('public.pos_manual_open_requests') AND i.indisvalid AND i.indisready
      AND NOT i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
      AND (SELECT array_agg(a.attname::text ORDER BY k.ordinality) FROM unnest(i.indkey) WITH ORDINALITY k(attnum,ordinality)
        JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=k.attnum)=shape.key_names) THEN
      RAISE EXCEPTION 'partial 321f deployment: index shape mismatch: %',shape.index_name;
    END IF;
  END LOOP;
  FOREACH expected IN ARRAY required_open_columns LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.pos_manual_open_requests') AND attname=expected AND attnum>0 AND NOT attisdropped) THEN
      RAISE EXCEPTION 'partial 321f deployment: essential column missing: %',expected;
    END IF;
  END LOOP;
  IF (SELECT relowner FROM pg_class WHERE oid=to_regclass('public.pos_manual_open_requests'))<>(SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.migrator_role'))
    OR (SELECT relowner FROM pg_class WHERE oid=to_regclass('public.pos_manual_vault_proofs'))<>(SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.migrator_role'))
    OR (SELECT relowner FROM pg_class WHERE oid=to_regclass('public.pos_manual_payment_vault_verifiers'))<>(SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.migrator_role')) THEN
    RAISE EXCEPTION 'partial 321f deployment: table owner mismatch';
  END IF;
  FOREACH signature IN ARRAY signatures||helper_signatures LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(signature)
      AND proowner=(SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.migrator_role'))
      AND proconfig=ARRAY['search_path=pg_catalog']
      AND prosecdef=(signature=ANY(signatures))) THEN
      RAISE EXCEPTION 'partial 321f deployment: function security shape mismatch: %',signature;
    END IF;
  END LOOP;
  FOREACH signature IN ARRAY ARRAY[
    'public.protect_pos_manual_append_only()',
    'public.guard_pos_manual_operation()',
    'public.guard_pos_manual_state_event()',
    'public.protect_pos_manual_case()',
    'public.stamp_pos_manual_ledger()',
    'public.validate_pos_manual_case_open_commit()',
    'public.validate_pos_manual_transition_commit()'
  ]::TEXT[] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc WHERE oid=to_regprocedure(signature)
      AND proowner=(SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.migrator_role'))
      AND proconfig=CASE
        WHEN to_regclass('public.pos_manual_t2_authorities') IS NOT NULL
          AND signature=ANY(ARRAY['public.guard_pos_manual_operation()','public.guard_pos_manual_state_event()','public.protect_pos_manual_case()']::TEXT[])
          THEN ARRAY['search_path=pg_catalog']::TEXT[]
        ELSE ARRAY['search_path=pg_catalog, public']::TEXT[] END
      AND prosecdef=(to_regclass('public.pos_manual_t2_authorities') IS NOT NULL
        AND signature=ANY(ARRAY['public.guard_pos_manual_operation()','public.guard_pos_manual_state_event()','public.protect_pos_manual_case()']::TEXT[]))) THEN
      RAISE EXCEPTION 'partial 321f deployment: legacy function security shape mismatch: %',signature;
    END IF;
  END LOOP;
  FOR shape IN SELECT * FROM (VALUES
    ('public.guard_pos_manual_open_request_321f()','9c8ba16d2f251353f8cb9ed2ff0b522e75278aef0fd48c10b8523e05c2ff064a','v',false),
    ('public.guard_pos_manual_vault_binding_321f()','ebd04070993354553dc50d1fe9589e69191cef6dd5edc8c40f54d7be90c4b23e','v',false),
    ('public.pos_manual_abandon_open_v1(uuid,text,bigint,text,text)','c0c735ae306813ed8f65070c0965328f85a9c4e7eacd2c1c315600feb47d316d','v',false),
    ('public.pos_manual_claim_open_for_vault_v1(uuid,text,text,text,integer)','189a0471d08e8b3ee50d9b9f393f221dcbf460e94116aefdd6fe211a07f89a81','v',false),
    ('public.pos_manual_identifier_contains_pan_321f(text)','aca35db7533290441c3951e5bd8b633664a91a33952054cdc78eb3e3f391f683','i',true),
    ('public.pos_manual_lock_open_graph_321f(uuid)','d05dfb15131bce9fd1301c0d690c53ad058471eee9227f99adf53773bbc86837','v',false),
    ('public.pos_manual_open_boundary_failure_321f(uuid,timestamptz)','4dbd75369b3f7adc4960b0368a09d53e444fb35f9f7e8e966cbe68ede3048a16','v',false),
    ('public.pos_manual_open_case_v1(uuid,text,bigint,text,text,text,text,text,text,text,text,text,text,timestamptz,timestamptz,text)',
      CASE WHEN to_regclass('public.pos_manual_t2_authorities') IS NULL
        THEN '41ffa5276c081dfd3ff4bdad0e6cab95886655c692de2862d11a891e3b22cd5d'
        ELSE 'fd4a32ad2420a2abc7298bbb06cd4c430a921730fe6d6f726e1146780e97855a' END,'v',false),
    ('public.pos_manual_open_status_v1(uuid,integer,text,text)','bc80ea8158c5cc80ff7f6eca36e67e9bc428ee8a21cd5ab3e89c197e1236a87a','v',false),
    ('public.pos_manual_prepare_open_v1(text,integer,integer,text,timestamptz,text,text,text)','41a7463a3245b35be73c3e544c5d7279d1b8873b1b631ba806b044b196bb8b75','v',false),
    ('public.pos_manual_probe_open_v1(uuid,text)','322d348d1218d79b0698b5563cce2eefaec1f3080dc1ace03e2696fc65d6fec2','v',false),
    ('public.validate_pos_manual_open_graph_321f()','3fa75b1dbe63349a97e5584b1ae6bca61896881e827a98dcad66190c0434ff14','v',false),
    ('public.validate_pos_manual_open_graph_vertex_321f()','4b4012a4324953f251af1dd23f3291f6099cffe4554d1877238f12b8593d8941','v',false)
    ,('public.guard_pos_manual_operation()',CASE WHEN to_regclass('public.pos_manual_t2_authorities') IS NULL
        THEN '22a757974deaead264c4aff55b7df8a6b039b5feedf5ac66a0f11a709c9bdc82'
        ELSE 'f83080cae79e538f70e52447645053326816ebecf84421337cc812c5b4df7d16' END,'v',false)
    ,('public.guard_pos_manual_state_event()',CASE WHEN to_regclass('public.pos_manual_t2_authorities') IS NULL
        THEN '1bcc47f759ba388249f097b662abd1061ac6484da89e633590d13bdba2d80dae'
        ELSE '854e22d222dd9071a86cda5f30ed8e2f7c2ca1945ec7d078bc62d559174fa2dc' END,'v',false)
    ,('public.protect_pos_manual_append_only()','f59f8dc5c4b8630fb9f0d36b8d0f4dc295735faa6b35878968930e488205b99b','v',false)
    ,('public.protect_pos_manual_case()',CASE WHEN to_regclass('public.pos_manual_t2_authorities') IS NULL
        THEN '4faef4cb389a3891a208455581b790f95a50aadc524a1b65cac41a9623675de4'
        ELSE '8d19049e6cf7f2af28acfc5c2996fe7e099c7779fd366af8090b61d058c4db18' END,'v',false)
    ,('public.stamp_pos_manual_ledger()','cc14d6adee3197359656f74e2a3c92de584e4537c70c1236f872000b7be83b03','v',false)
    ,('public.validate_pos_manual_case_open_commit()','377dfdb5e83da44b01ef481593b1deaf28c73c1ef31928891d50adb65b6a3875','v',false)
    ,('public.validate_pos_manual_transition_commit()','bf5ec13faa174669d7142fb3c7b152c2c283fbed4f5175dd6e859391a629f7fc','v',false)
  ) AS v(signature,source_sha256,volatility,is_strict) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang WHERE p.oid=to_regprocedure(shape.signature)
      AND l.lanname='plpgsql' AND p.provolatile=shape.volatility::"char" AND p.proisstrict=shape.is_strict
      AND NOT p.proleakproof AND p.proparallel='u' AND p.prokind='f'
      AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')=shape.source_sha256) THEN
      RAISE EXCEPTION 'partial 321f deployment: function code manifest mismatch: %',shape.signature;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.pos_manual_payment_vault_bindings') AND contype='c' AND pg_get_constraintdef(oid) LIKE '%binding_kind%legacy_history%proof_v1%')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.pos_manual_payment_vault_bindings') AND contype='f' AND conkey @> ARRAY[(SELECT attnum::smallint FROM pg_attribute WHERE attrelid=to_regclass('public.pos_manual_payment_vault_bindings') AND attname='vault_proof_id')])
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.pos_manual_open_requests') AND contype='c' AND pg_get_constraintdef(oid) LIKE '%state%prepared%binding%finalized%rejected%expired%') THEN
    RAISE EXCEPTION 'partial 321f deployment: essential constraint missing';
  END IF;
  FOR shape IN SELECT * FROM (VALUES
    ('pos_manual_open_requests',ARRAY['branch_id','maker_user_id','idempotency_key']::text[]),
    ('pos_manual_open_requests',ARRAY['ticket_hash']::text[]),('pos_manual_open_requests',ARRAY['vault_idempotency_key']::text[]),
    ('pos_manual_open_requests',ARRAY['lease_token_hash']::text[]),('pos_manual_open_requests',ARRAY['case_id']::text[]),
    ('pos_manual_open_requests',ARRAY['vault_proof_id']::text[]),
    ('pos_manual_vault_proofs',ARRAY['open_request_id']::text[]),('pos_manual_vault_proofs',ARRAY['case_id']::text[]),
    ('pos_manual_vault_proofs',ARRAY['external_proof_id']::text[]),('pos_manual_vault_proofs',ARRAY['stable_reference_index']::text[]),
    ('pos_manual_vault_proofs',ARRAY['binding_hash']::text[]),
    ('pos_manual_payment_vault_bindings',ARRAY['case_id']::text[]),
    ('pos_manual_payment_vault_bindings',ARRAY['stable_reference_index']::text[]),
    ('pos_manual_payment_vault_bindings',ARRAY['vault_provider','vault_reference']::text[]),
    ('pos_manual_payment_vault_bindings',ARRAY['vault_proof_id']::text[])
  ) AS v(table_name,key_names) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('public.'||shape.table_name) AND c.contype='u' AND NOT c.condeferrable AND NOT c.condeferred AND c.convalidated
      AND (SELECT array_agg(a.attname::text ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinality)
        JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)=shape.key_names) THEN
      RAISE EXCEPTION 'partial 321f deployment: unique constraint missing: %.%',shape.table_name,shape.key_names;
    END IF;
  END LOOP;
  FOR shape IN SELECT * FROM (VALUES
    ('pos_manual_open_requests',ARRAY['branch_id']::text[],'branches',ARRAY['id']::text[],false,false),
    ('pos_manual_open_requests',ARRAY['register_id','branch_id']::text[],'pos_registers',ARRAY['id','branch_id']::text[],false,false),
    ('pos_manual_open_requests',ARRAY['operator_profile_id']::text[],'tenant_user_profiles',ARRAY['id']::text[],false,false),
    ('pos_manual_open_requests',ARRAY['maker_profile_id']::text[],'tenant_user_profiles',ARRAY['id']::text[],false,false),
    ('pos_manual_open_requests',ARRAY['sale_draft_id']::text[],'pos_held_sales',ARRAY['id']::text[],false,false),
    ('pos_manual_open_requests',ARRAY['order_claim_id']::text[],'pos_order_claims',ARRAY['id']::text[],false,false),
    ('pos_manual_open_requests',ARRAY['payment_plan_id','payment_index']::text[],'pos_payment_plan_slots',ARRAY['plan_id','payment_index']::text[],false,false),
    ('pos_manual_open_requests',ARRAY['session_id','register_id']::text[],'cash_register_sessions',ARRAY['id','register_id']::text[],false,false),
    ('pos_manual_open_requests',ARRAY['terminal_id','register_id']::text[],'pos_terminals',ARRAY['id','register_id']::text[],false,false),
    ('pos_manual_open_requests',ARRAY['connector_id','branch_id','provider']::text[],'pos_connectors',ARRAY['id','branch_id','provider']::text[],false,false),
    ('pos_manual_open_requests',ARRAY['credential_ref']::text[],'integration_credentials',ARRAY['id']::text[],false,false),
    ('pos_manual_open_requests',ARRAY['case_id']::text[],'pos_manual_payment_cases',ARRAY['id']::text[],true,true),
    ('pos_manual_open_requests',ARRAY['vault_proof_id']::text[],'pos_manual_vault_proofs',ARRAY['id']::text[],true,true),
    ('pos_manual_vault_proofs',ARRAY['open_request_id']::text[],'pos_manual_open_requests',ARRAY['id']::text[],true,true),
    ('pos_manual_vault_proofs',ARRAY['case_id']::text[],'pos_manual_payment_cases',ARRAY['id']::text[],true,true),
    ('pos_manual_vault_proofs',ARRAY['verifier_version']::text[],'pos_manual_payment_vault_verifiers',ARRAY['verifier_version']::text[],false,false),
    ('pos_manual_payment_vault_bindings',ARRAY['case_id']::text[],'pos_manual_payment_cases',ARRAY['id']::text[],false,false),
    ('pos_manual_payment_vault_bindings',ARRAY['vault_proof_id']::text[],'pos_manual_vault_proofs',ARRAY['id']::text[],false,false)
  ) AS v(table_name,key_names,ref_table_name,ref_key_names,is_deferrable,is_initially_deferred) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass('public.'||shape.table_name)
      AND c.confrelid=to_regclass('public.'||shape.ref_table_name) AND c.contype='f' AND c.confdeltype='r'
      AND c.confupdtype='a' AND c.confmatchtype='s' AND c.convalidated
      AND c.condeferrable=shape.is_deferrable AND c.condeferred=shape.is_initially_deferred
      AND (SELECT array_agg(a.attname::text ORDER BY k.ordinality) FROM unnest(c.conkey) WITH ORDINALITY k(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=k.attnum)=shape.key_names
      AND (SELECT array_agg(a.attname::text ORDER BY k.ordinality) FROM unnest(c.confkey) WITH ORDINALITY k(attnum,ordinality) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=k.attnum)=shape.ref_key_names) THEN
      RAISE EXCEPTION 'partial 321f deployment: foreign key missing: %.%',shape.table_name,shape.key_names;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.pos_manual_open_requests') AND contype='c' AND pg_get_constraintdef(oid) LIKE '%case_id%vault_proof_id%')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.pos_manual_vault_proofs') AND contype='c' AND pg_get_constraintdef(oid) LIKE '%external_proof_id%' AND pg_get_constraintdef(oid) LIKE '%reference_key_id%' AND pg_get_constraintdef(oid) LIKE '%vault_key_id%') THEN
    RAISE EXCEPTION 'partial 321f deployment: graph check constraint missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE contype='c' AND conrelid=ANY(ARRAY[to_regclass('public.pos_manual_open_requests'),to_regclass('public.pos_manual_vault_proofs'),to_regclass('public.pos_manual_payment_vault_verifiers'),to_regclass('public.pos_manual_payment_vault_bindings')]) AND NOT convalidated)
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('public.pos_manual_open_requests') AND contype='c'
      AND pg_get_constraintdef(oid) LIKE '%ticket_consumed_at%' AND pg_get_constraintdef(oid) LIKE '%claim_idempotency_hash%'
      AND pg_get_constraintdef(oid) LIKE '%finalize_request_hash%' AND pg_get_constraintdef(oid) LIKE '%abandon_request_hash%'
      AND pg_get_constraintdef(oid) LIKE '%lifecycle_txid%')
    OR NOT EXISTS (SELECT 1 FROM pg_constraint WHERE contype='c' AND conrelid=ANY(ARRAY[to_regclass('public.pos_manual_open_requests'),to_regclass('public.pos_manual_vault_proofs'),to_regclass('public.pos_manual_payment_vault_verifiers')])
      AND pg_get_constraintdef(oid) LIKE '%pos_manual_identifier_contains_pan_321f%') THEN
    RAISE EXCEPTION 'partial 321f deployment: lifecycle or DLP check missing/unvalidated';
  END IF;
  FOR shape IN SELECT * FROM (VALUES
    ('pos_manual_open_requests',26,'7c9c38676eb0b2617c96f12a04c1b4e09fc7c105f25972788d7e804eb708f5b6'),
    ('pos_manual_payment_vault_bindings',4,'c18777d9cd366e205c3e326de1edb5a26ea910c9ac6c71b010c9a3c5263c2fbd'),
    ('pos_manual_payment_vault_verifiers',2,'5e59e8be1432913c6765c93e12b4dbeee5dd4ffe53be1886fea9c2747db9adac'),
    ('pos_manual_vault_proofs',7,'aaf7efd2e133fd371d8d048815a2596cd85d226f228ef30493dc2ff525c1cc14')
  ) AS v(table_name,expected_count,expected_sha256) LOOP
    IF NOT EXISTS (SELECT 1 FROM (SELECT count(*)::integer constraint_count,
      encode(sha256(convert_to(string_agg(regexp_replace(pg_get_constraintdef(c.oid,true),'[[:space:]]+','','g'),E'\n' ORDER BY regexp_replace(pg_get_constraintdef(c.oid,true),'[[:space:]]+','','g')),'UTF8')),'hex') manifest_sha256
      FROM pg_constraint c WHERE c.contype='c' AND c.conrelid=to_regclass('public.'||shape.table_name)) actual
      WHERE actual.constraint_count=shape.expected_count AND actual.manifest_sha256=shape.expected_sha256) THEN
      RAISE EXCEPTION 'partial 321f deployment: canonical CHECK manifest mismatch: %',shape.table_name;
    END IF;
  END LOOP;
END
$$;

-- T2-00 is an inert, checksum-bound foundation. Any partial marker activates
-- the complete catalog audit; there is no permissive half-installed state.
DO $$
DECLARE
  marker_present BOOLEAN := to_regclass('public.pos_manual_finalization_profiles') IS NOT NULL
    OR to_regclass('public.pos_manual_application_snapshots') IS NOT NULL
    OR to_regclass('public.pos_manual_application_manifest_entries') IS NOT NULL
    OR to_regclass('public.pos_manual_application_effects') IS NOT NULL
    OR to_regprocedure('public.pos_manual_canonical_json_v1(jsonb)') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.sales')
      AND attname='manual_payment_application_id' AND attnum>0 AND NOT attisdropped)
    OR EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.pos_sale_payments')
      AND attname='manual_payment_case_id' AND attnum>0 AND NOT attisdropped)
    OR EXISTS (SELECT 1 FROM public._prisma_migrations
      WHERE migration_name='20260829322000_pos_manual_payment_t2_foundation');
  shape RECORD;
  signature TEXT;
  operational_role NAME;
  operational_roles NAME[] := ARRAY[
    current_setting('nalven.runtime_role')::NAME,current_setting('nalven.manual_worker_role')::NAME,
    current_setting('nalven.manual_callback_role')::NAME,current_setting('nalven.stepup_issuer_role')::NAME,
    current_setting('nalven.manual_homologator_role')::NAME,current_setting('nalven.manual_vault_binder_role')::NAME,
    current_setting('nalven.manual_profile_admin_issuer_role')::NAME,current_setting('nalven.manual_profile_accounting_issuer_role')::NAME,
    current_setting('nalven.manual_profile_fiscal_issuer_role')::NAME,current_setting('nalven.manual_sweeper_role')::NAME
  ];
BEGIN
  IF NOT marker_present THEN RETURN; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public._prisma_migrations
     WHERE migration_name='20260829322000_pos_manual_payment_t2_foundation'
       AND checksum='db6dd828c243bbfdd884cbaf25d2986901be59c76cd6dfbaf6323a30e8fc2e69'
       AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count=1
  ) THEN
    RAISE EXCEPTION 'partial T2-00 deployment: migration ledger missing or checksum mismatch';
  END IF;

  FOR shape IN SELECT * FROM (VALUES
    ('pos_manual_finalization_profiles',
      CASE WHEN to_regclass('public.pos_manual_t2_authorities') IS NULL THEN 28 ELSE 30 END,
      CASE WHEN to_regclass('public.pos_manual_t2_authorities') IS NULL
        THEN '86de94e7b644c8508c74e62a5118f4afe5f51bc659e1a68c88036ea36593a334'
        ELSE '4fdb81c6eb4f5d8dad340e08c8d821699fff6e59325c846e9a6b06ae94037197' END,
      CASE WHEN to_regclass('public.pos_manual_t2_authorities') IS NULL THEN 26 ELSE 32 END,
      CASE WHEN to_regclass('public.pos_manual_t2_authorities') IS NULL
        THEN '666397d9f443240e66e00e430716ecf171880a1eadb8eb0dfcd6619d29029921'
        ELSE '424031a152f3908b70c97047a7fa0ec43e906d26b3529025c0f1af6c338383b3' END),
    ('pos_manual_application_snapshots',25,'e4646a8b8b60bf870c3f23d87b8def34e466d9172e80fe3ef750c7821a1c1ca8',30,'e760a56a53e98a49124ef1287861e5c72013eaf28e890ff041e6aff49aa8d471'),
    ('pos_manual_application_manifest_entries',9,'b3f8ffcf71a56f0cd494d448973cb4575de18d6deed1a46b3d01f49e6f4ef3ba',14,'8e198d82de7f0850eed390f31b2a0f141d82f8764e93705bfde12e6d2c65fe4f'),
    ('pos_manual_application_effects',10,'57d0302f1e334b59fdd2b04b48e2754198affabc6c014e25ad1554d927d90f07',16,'eda2ebb87ba1d35487c399eb99a73d284cd117e92a326771d33e8ab3d4864cff')
  ) AS expected(table_name,column_count,column_sha256,constraint_count,constraint_sha256)
  LOOP
    IF to_regclass('public.'||shape.table_name) IS NULL OR
       (SELECT relowner FROM pg_class WHERE oid=to_regclass('public.'||shape.table_name))
         IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.migrator_role')) OR
       NOT EXISTS (
         SELECT 1 FROM (
           SELECT count(*)::integer column_count,
             encode(sha256(convert_to(string_agg(attribute.attname||':'||format_type(attribute.atttypid,attribute.atttypmod)||':'||attribute.attnotnull::text||':'||coalesce(pg_get_expr(default_value.adbin,default_value.adrelid),'') ,E'\n' ORDER BY attribute.attnum),'UTF8')),'hex') column_sha256
             FROM pg_attribute attribute
             LEFT JOIN pg_attrdef default_value ON default_value.adrelid=attribute.attrelid AND default_value.adnum=attribute.attnum
            WHERE attribute.attrelid=to_regclass('public.'||shape.table_name) AND attribute.attnum>0 AND NOT attribute.attisdropped
         ) actual WHERE actual.column_count=shape.column_count AND actual.column_sha256=shape.column_sha256
       ) OR NOT EXISTS (
         SELECT 1 FROM (
           SELECT count(*)::integer constraint_count,
             encode(sha256(convert_to(string_agg(constraint_row.conname||':'||constraint_row.contype::text||':'||constraint_row.convalidated::text||':'||constraint_row.condeferrable::text||':'||constraint_row.condeferred::text||':'||constraint_row.confdeltype::text||':'||constraint_row.confupdtype::text||':'||constraint_row.confmatchtype::text||':'||constraint_row.connoinherit::text||':'||regexp_replace(pg_get_constraintdef(constraint_row.oid,true),'[[:space:]]+','','g'),E'\n' ORDER BY constraint_row.conname),'UTF8')),'hex') constraint_sha256
             FROM pg_constraint constraint_row WHERE constraint_row.conrelid=to_regclass('public.'||shape.table_name)
         ) actual WHERE actual.constraint_count=shape.constraint_count AND actual.constraint_sha256=shape.constraint_sha256
       ) THEN
      RAISE EXCEPTION 'partial T2-00 deployment: relation catalog manifest mismatch: %',shape.table_name;
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('public.pos_manual_payment_applications') AND attname='write_txid' AND attnum>0 AND NOT attisdropped) THEN
    RAISE EXCEPTION 'partial T2-00 deployment: legacy relation column manifest mismatch';
  END IF;
  FOR shape IN SELECT * FROM (VALUES
    ('pos_manual_payment_reconciliation_gates',ARRAY['finalization_profile_id','finalization_profile_version','finalization_profile_hash']::text[],3,'c238ad72740feaa45c14c939b212b02e1b44edbda41d9c1e19aac4076eca1882'),
    ('pos_manual_payment_applications',ARRAY['reserve_txid','version','case_version_before_reserve','case_version_after_reserve','confirmed_observation_id','confirmation_evidence_hash','reserved_by_user_id','reservation_expires_at','snapshot_hash','manifest_hash','finalization_profile_id','finalization_profile_version','finalization_profile_hash','claim_token_hash','claim_expires_at','fencing_token','claimed_by_hash','claimed_at','apply_idempotency_key','apply_request_hash','apply_txid','planned_sale_id','planned_sale_number','planned_sale_occurred_at','failure_class','failure_at']::text[],26,'9b3677f7a46de2fbb5ce6efd4b683986be828c02ef93fb24f855437f40153adc'),
    ('sales',ARRAY['manual_payment_application_id']::text[],1,'42170f2b57fc6611657b83fbfd7cb64d9454728a4301486d595ead123e59d97d'),
    ('pos_sale_payments',ARRAY['manual_payment_case_id']::text[],1,'79d60ce43b17c7f19ffa3056e83ac5a11d9434d69ff30b93a5ed63b9ac5ac442')
  ) AS expected(table_name,column_names,column_count,column_sha256)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM (
      SELECT count(*)::integer column_count,
        encode(sha256(convert_to(string_agg(attribute.attname||':'||format_type(attribute.atttypid,attribute.atttypmod)||':'||attribute.attnotnull::text||':'||coalesce(pg_get_expr(default_value.adbin,default_value.adrelid),'')||':'||attribute.attidentity::text||':'||attribute.attgenerated::text,E'\n' ORDER BY attribute.attname),'UTF8')),'hex') column_sha256
      FROM pg_attribute attribute
      LEFT JOIN pg_attrdef default_value ON default_value.adrelid=attribute.attrelid AND default_value.adnum=attribute.attnum
      WHERE attribute.attrelid=to_regclass('public.'||shape.table_name) AND attribute.attname=ANY(shape.column_names)
        AND attribute.attnum>0 AND NOT attribute.attisdropped
    ) actual WHERE actual.column_count=shape.column_count AND actual.column_sha256=shape.column_sha256) THEN
      RAISE EXCEPTION 'partial T2-00 deployment: legacy relation column manifest mismatch: %',shape.table_name;
    END IF;
  END LOOP;

  FOR shape IN SELECT * FROM (VALUES
    ('pos_manual_payment_reconciliation_gates','pos_manual_gate_fin_profile_fkey','f',false,false,'r','a','s','478e8e6b62477deeba470a1f26c828536b8b5ba9da346cf70b2ca1de06c6b414'),
    ('pos_manual_payment_reconciliation_gates','pos_manual_gate_fin_profile_shape_check','c',false,false,NULL,NULL,NULL,'7abcfe99e769f2d6b72a2a49a98385a716de836f67276e91cc92c67672fc1dcf'),
    ('pos_manual_payment_applications','pos_manual_apps_state_check','c',false,false,NULL,NULL,NULL,'fed2a16c306ae6e6fd7a6cecc6343baa3023334f243896a97654e90fcdbddec0'),
    ('pos_manual_payment_applications','pos_manual_apps_versions_check','c',false,false,NULL,NULL,NULL,'8742d0489246760973240867d039a054a32660d14d94b630507e456a8f452c6c'),
    ('pos_manual_payment_applications','pos_manual_apps_hashes_check','c',false,false,NULL,NULL,NULL,'c504ed54359d96eb4fa9168e3be567d5f658d4f32ab7e2ff79c5a62b50647032'),
    ('pos_manual_payment_applications','pos_manual_apps_identity_shape_check','c',false,false,NULL,NULL,NULL,'38730a0556cf4c3fe14dc61a7032c2e0f2b37550fd8ea7c1c534c08c013a354d'),
    ('pos_manual_payment_applications','pos_manual_apps_claim_shape_check','c',false,false,NULL,NULL,NULL,'1c9eee0eee6a7bd7e5a2e0a7cf8d00e9ab2fffa775d01f2173a9729b5c5d1810'),
    ('pos_manual_payment_applications','pos_manual_apps_apply_shape_check','c',false,false,NULL,NULL,NULL,'e5ecdce227bd7d54a6d26b5029871de13b3349a047fc5b9a7bace210a64f5a04'),
    ('pos_manual_payment_applications','pos_manual_apps_block_shape_check','c',false,false,NULL,NULL,NULL,'50a95c6a278d1110f7d602e9923d73f061b327239eb6bcb98f52b694e2d391a6'),
    ('pos_manual_payment_applications','pos_manual_apps_observation_fkey','f',false,false,'r','a','s','c315a326ff0067327bdcc4df32b30f9e911eeb72ba271dd1926909cc251d51f7'),
    ('pos_manual_payment_applications','pos_manual_apps_fin_profile_fkey','f',false,false,'r','a','s','478e8e6b62477deeba470a1f26c828536b8b5ba9da346cf70b2ca1de06c6b414'),
    ('pos_manual_payment_applications','pos_manual_apps_snapshot_fkey','f',true,true,'r','a','s','ed2e474fad114332338e6d1029989d51724e351a03cdd0010719c615c78ce0e6'),
    ('pos_manual_payment_applications','pos_manual_apps_sale_fkey','f',true,true,'r','a','s','063647a927488db51938cbff8341563effe444556f6f2e4f8ff733a1de865ce4'),
    ('pos_manual_payment_applications','pos_manual_apps_sale_payment_fkey','f',true,true,'r','a','s','f0dfc9ea1b28f91dfa21ee93c00be78b0c70dcaa8cdbe2d5e62ba8aeb416f2f6'),
    ('sales','sales_manual_payment_application_fkey','f',true,true,'r','a','s','cd723b4d6fbbbf709c7e16f8fdc92d730b1e2e96bd71d5b702b7d475552906b0'),
    ('sales','sales_manual_payment_source_check','c',false,false,NULL,NULL,NULL,'83ca1c4679801769c2c7d1b1a1be62fa4e06ac96d7d57d786dc8208f435c11e9'),
    ('pos_sale_payments','pos_sale_payments_manual_case_fkey','f',true,true,'r','a','s','cc8806139d51e24e6b35c2e2454d942e7fc85be8e71f9be11ea6f9f626119c64'),
    ('pos_sale_payments','pos_sale_payments_manual_branch_check','c',false,false,NULL,NULL,NULL,'5cdd1a744b4710071c36b7bd0deb14b8f11fab8b086c05dfde2045a3fbcd59af')
  ) AS expected(table_name,constraint_name,constraint_type,is_deferrable,is_initially_deferred,delete_action,update_action,match_type,definition_sha256)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint constraint_row
      WHERE constraint_row.conrelid=to_regclass('public.'||shape.table_name) AND constraint_row.conname=shape.constraint_name
        AND constraint_row.contype=shape.constraint_type::"char" AND constraint_row.convalidated
        AND constraint_row.condeferrable=shape.is_deferrable AND constraint_row.condeferred=shape.is_initially_deferred
        AND (constraint_row.contype<>'f' OR (constraint_row.confdeltype=shape.delete_action::"char"
          AND constraint_row.confupdtype=shape.update_action::"char" AND constraint_row.confmatchtype=shape.match_type::"char"))
        AND (constraint_row.contype<>'c' OR NOT constraint_row.connoinherit)
        AND encode(sha256(convert_to(regexp_replace(pg_get_constraintdef(constraint_row.oid,true),'[[:space:]]+','','g'),'UTF8')),'hex')=shape.definition_sha256) THEN
      RAISE EXCEPTION 'partial T2-00 deployment: constraint manifest mismatch: %.%',shape.table_name,shape.constraint_name;
    END IF;
  END LOOP;

  FOR shape IN SELECT * FROM (VALUES
    ('pos_accounting_policies_id_branch_version_key','pos_accounting_policies',false,'525dc56e6623f99d135827f281b3fd9f6e56a2c5f46267e221522d230cedfe28'),
    ('pos_accounting_policies_t2_identity_key','pos_accounting_policies',false,'a4e62995aef07aeb413f0f8b6982fc15ecb5bf03169bd2988d89f7a7b0515d57'),
    ('pos_fiscal_profiles_id_version_branch_key','pos_fiscal_profiles',false,'9540f959727be38f068d103a75a7a08206fa040a3a7b08d006a11b02121a3756'),
    ('pos_fiscal_profiles_t2_identity_key','pos_fiscal_profiles',false,'fe8138a07cef120a0326fb4ede4c693991574b2b9a77a437ad27aa8545b396e8'),
    ('pos_manual_fin_profiles_pkey','pos_manual_finalization_profiles',true,'b1fde4ec1f48a51646c20fbbd01d0dc954c0b8268cf581931aef35ac111edbda'),
    ('pos_manual_fin_profiles_branch_version_key','pos_manual_finalization_profiles',false,'e8b28b13b560def0ac26b8894fef1b4f2524aa2528a6caed6f0a69ce69584eb7'),
    ('pos_manual_fin_profiles_id_version_hash_key','pos_manual_finalization_profiles',false,'3e531bccf6f7d7fdede6643fd6cb15504e6474cbe6c9ab76cf9aaa8f2bbe11f7'),
    ('pos_manual_fin_profiles_one_active_idx','pos_manual_finalization_profiles',false,'881dabc62da52ba2d87a1f67ef86d73378da3f024ea16840e94395c52a97bfed'),
    ('pos_manual_observations_case_id_id_key','pos_manual_payment_observations',false,'d239f6e4338d04cb3fbb801889a2d4041afcf00cf01a159f259ffc93647cb332'),
    ('pos_manual_apps_planned_sale_key','pos_manual_payment_applications',false,'8e6a62496d35b21c616a637cd8b27342be1e6ca1d9ed5bb03ae189af63cfd200'),
    ('pos_manual_apps_planned_number_key','pos_manual_payment_applications',false,'b7f6f0d0716fec9aebbc2befa52fd577d8677294072a91ee034972003bf19695'),
    ('pos_manual_apps_sale_id_key','pos_manual_payment_applications',false,'e7b1716b1a8689fba9ebb25268e00706f5dc6a313bb88ce53e7b01bd231acb38'),
    ('pos_manual_apps_sale_idempotency_key','pos_manual_payment_applications',false,'e56259126f567ae6077e668c2c9f62f72918d13ed2b51cc0339931f1007cd54a'),
    ('pos_manual_apps_confirmed_observation_key','pos_manual_payment_applications',false,'a8a53766edd77cde300aa395184984422c73a1a7480adb998990d75f6a5ee4d4'),
    ('pos_manual_apps_apply_idem_key','pos_manual_payment_applications',false,'5e67e7fdfe4f81af9d8ad78ad2afd98e4a726ebba6e8c57959f14b723dd64959'),
    ('pos_manual_app_snapshots_pkey','pos_manual_application_snapshots',true,'657d29d12164ed35601507319be51a01f052c40b6f71214f31f9b95568b47f27'),
    ('pos_manual_app_snapshots_identity_key','pos_manual_application_snapshots',false,'d8e31a08ba25bf1940afdc4dd37c0d7f8c22a3984c59711d6762ff9417970110'),
    ('pos_manual_app_manifest_pkey','pos_manual_application_manifest_entries',true,'ec7a7f6aabc60836245eaa9018fe8b05f5a2b5ff0bdde2b865912a19472f5e0c'),
    ('pos_manual_app_manifest_identity_key','pos_manual_application_manifest_entries',false,'a4a16c27b4d6d91115459ec8dce925d3606c149d35710335d4d52f7ff72660e4'),
    ('pos_manual_app_manifest_id_application_key','pos_manual_application_manifest_entries',false,'48ef9df5bf5d245f5335cb6d8defcc80c631ebf7e629671212a69020e133de8f'),
    ('pos_manual_app_effects_pkey','pos_manual_application_effects',true,'58feb2be748f0e9b5e7f2d53a437c597d47bc8c28ecac52fb4b8d3f7cef74206'),
    ('pos_manual_app_effects_manifest_entry_key','pos_manual_application_effects',false,'eb331366b164441a8b53b334feaed09737642d1c41b594f96434a5e33faff26b'),
    ('pos_manual_app_effects_identity_key','pos_manual_application_effects',false,'6e76e37f4a469da933745b9ed4b4fa281803b6390d71230baaa2b78c60a3385f'),
    ('sales_manual_payment_application_key','sales',false,'5fe79e32c23b09946a2d4e2235e22ae8f3b809382438b2000d13d25c4edae478'),
    ('pos_sale_payments_manual_case_key','pos_sale_payments',false,'4aa974e46a4c560b4f826a0a87943156170c256f3b9f186df82d5664b5994e07')
  ) AS expected(index_name,table_name,is_primary,definition_sha256)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_index index_row
      WHERE index_row.indexrelid=to_regclass('public.'||shape.index_name)
        AND index_row.indrelid=to_regclass('public.'||shape.table_name) AND index_row.indisvalid
        AND index_row.indisready AND index_row.indislive AND index_row.indisunique AND index_row.indisprimary=shape.is_primary
        AND encode(sha256(convert_to(regexp_replace(pg_get_indexdef(index_row.indexrelid),'[[:space:]]+',' ','g'),'UTF8')),'hex')=shape.definition_sha256) THEN
      RAISE EXCEPTION 'partial T2-00 deployment: unique index manifest mismatch: %',shape.index_name;
    END IF;
  END LOOP;

  FOR shape IN SELECT * FROM (VALUES
    ('public.pos_manual_canonical_json_impl_v1(jsonb,integer)','11259b2d04a080bdf7bf0f86e2f31459dc6b2cfb26775a04b2bda31496e28e9c','i',true),
    ('public.pos_manual_canonical_json_v1(jsonb)',
      CASE WHEN to_regprocedure('public.pos_manual_sweep_expired_applications_v1(text,integer,text,text)') IS NULL
        THEN '8153a5930afa6c6799c926ef4e30620f84e2b95d0d98f675e4f18fe39435487a'
        ELSE 'fc3b39841a5fe0bc13b81d88d6ab74cdfbc36c308fb203297f2b2370447746f9' END,'i',true),
    ('public.pos_manual_hash_canonical_json_v1(text,jsonb)',
      CASE WHEN to_regprocedure('public.pos_manual_sweep_expired_applications_v1(text,integer,text,text)') IS NULL
        THEN 'c26860efa252965dc66e6b209966eb943492d412646cc3b1845db72ec4740cda'
        ELSE '1c2ea0546c83834e1b0b07db5e8cf0d705e64b1fdf6cc3d2dce31989a12d7d09' END,'i',true),
    ('public.pos_manual_utc_micros_v1(timestamptz)','efaca8bfd4dcde5d931d3d98031294cd289f063e6233900dcad05a5fe8696c36','i',true),
    ('public.pos_manual_t2_dlp_walk_impl_v1(text,jsonb,integer)','0ec3248a9313aa43f8635a4ec40c8991e7e75fbcaa3b8779201498a83be04860','i',true),
    ('public.pos_manual_t2_json_dlp_safe_v1(text,jsonb)',
      CASE WHEN to_regclass('public.pos_manual_t2_authorities') IS NULL
        THEN '67d032100828e315f92307672c7627b7c2d687be6c728e657e63fa14deb7b4aa'
        ELSE CASE WHEN to_regprocedure('public.pos_manual_sweep_expired_applications_v1(text,integer,text,text)') IS NULL
          THEN 'bc844df11c8567e7b7245ac1a674707abf5d4c3f33c2e7af3a0656306de7f7f2'
          ELSE '33c6a45a49d19fd6a39a5530c03d493dfff4024baf9690786771fa25f48d63fd' END END,'i',true),
    ('public.guard_pos_manual_t2_profile_inert()',
      CASE WHEN to_regclass('public.pos_manual_t2_authorities') IS NULL
        THEN '0d3b24c719ba91447c373491ce85bdfffb3c6774526c59a50c238540e16f3fd6'
        ELSE 'c220b4297b581e07f72e8c8f6fcff8f07ac76f9a637ff0af49e8a141a8ee12d3' END,'v',false),
    ('public.guard_pos_manual_t2_application_inert()','e5bb9deb99a480dcd94151ac1140ce217803dc471331a5a4fc8f79c94a0e24b4','v',false),
    ('public.guard_pos_manual_t2_sale_link_inert()','0a78ebbf5b0b9c5b384bbe3814d454054985d40809cd1a651ca0ba272842e156','v',false),
    ('public.guard_pos_manual_t2_payment_link_inert()','7054f8266dc38b8fd3ab8660ea58151957a30d5aaf95734a3c45908b69b028eb','v',false)
  ) AS expected(signature,source_sha256,volatility,is_strict)
  LOOP
    signature:=shape.signature;
    IF NOT EXISTS (SELECT 1 FROM pg_proc routine JOIN pg_language language ON language.oid=routine.prolang
      WHERE routine.oid=to_regprocedure(signature) AND language.lanname IN ('sql','plpgsql')
        AND routine.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.migrator_role'))
        AND routine.proconfig=ARRAY['search_path=pg_catalog'] AND routine.prosecdef
        AND routine.provolatile=shape.volatility::"char" AND routine.proisstrict=shape.is_strict
        AND NOT routine.proleakproof AND routine.proparallel='u' AND routine.prokind='f'
        AND encode(sha256(convert_to(routine.prosrc,'UTF8')),'hex')=shape.source_sha256) THEN
      RAISE EXCEPTION 'partial T2-00 deployment: function code manifest mismatch: %',signature;
    END IF;
    FOREACH operational_role IN ARRAY operational_roles LOOP
      IF has_function_privilege(operational_role,signature,'EXECUTE') THEN
        RAISE EXCEPTION 'T2-00 helper unexpectedly executable by operational role: % / %',signature,operational_role;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_proc routine CROSS JOIN LATERAL aclexplode(coalesce(routine.proacl,acldefault('f',routine.proowner))) privilege
      WHERE routine.oid=to_regprocedure(signature) AND privilege.grantee=0 AND privilege.privilege_type='EXECUTE') THEN
      RAISE EXCEPTION 'PUBLIC executes T2-00 helper: %',signature;
    END IF;
  END LOOP;

  FOR shape IN SELECT * FROM (VALUES
    ('pos_manual_app_effects_append_only','pos_manual_application_effects','public.protect_pos_manual_append_only()',27,'9517112b5b8b998960769d94e68beb157607ba3766d96b3f33f795f74d4aa766'),
    ('pos_manual_app_manifest_append_only','pos_manual_application_manifest_entries','public.protect_pos_manual_append_only()',27,'a84db79451403e3853acdb868a7a60c2a9b7e38c786de819555afa7632f108bb'),
    ('pos_manual_app_snapshots_append_only','pos_manual_application_snapshots','public.protect_pos_manual_append_only()',27,'d4cb41a14b10ebac1d0bd2699420d699555f59d708f4d112805e33b296eb5160'),
    ('pos_manual_fin_profiles_inert_guard','pos_manual_finalization_profiles','public.guard_pos_manual_t2_profile_inert()',31,'cd53e10ca91e470a1bec0a993d4fd90489d17c2f47cf0a7d233d80c3ed20f556'),
    ('pos_manual_t2_application_inert_guard','pos_manual_payment_applications','public.guard_pos_manual_t2_application_inert()',31,'b07e86453db2d9c023db28c891ba926424cfb661aa2c566ecc76157dec22ce38'),
    ('pos_sale_payments_manual_inert_guard','pos_sale_payments','public.guard_pos_manual_t2_payment_link_inert()',23,'2f209f14366d4faa1b014d921cea439a4614bc7621062d60dba0aa20f89be2b8'),
    ('sales_manual_payment_inert_guard','sales','public.guard_pos_manual_t2_sale_link_inert()',23,'7cdd7c4258c1dca7ddfce20996f34c417efdbc478abd051df3c912603f0e7559')
  ) AS expected(trigger_name,table_name,function_signature,expected_tgtype,definition_sha256)
  WHERE expected.trigger_name<>'pos_manual_t2_application_inert_guard'
     OR to_regprocedure('public.pos_manual_sweep_expired_applications_v1(text,integer,text,text)') IS NULL
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_trigger trigger_row JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      WHERE namespace.nspname='public' AND relation.relname=shape.table_name AND trigger_row.tgname=shape.trigger_name
        AND trigger_row.tgfoid=to_regprocedure(shape.function_signature) AND NOT trigger_row.tgisinternal
        AND trigger_row.tgenabled='O' AND NOT trigger_row.tgdeferrable AND NOT trigger_row.tginitdeferred
        AND trigger_row.tgtype=shape.expected_tgtype
        AND encode(sha256(convert_to(regexp_replace(pg_get_triggerdef(trigger_row.oid,true),'[[:space:]]+',' ','g'),'UTF8')),'hex')=shape.definition_sha256) THEN
      RAISE EXCEPTION 'partial T2-00 deployment: trigger manifest mismatch: %',shape.trigger_name;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgfoid=ANY(ARRAY[
    to_regprocedure('public.guard_pos_manual_t2_profile_inert()'),to_regprocedure('public.guard_pos_manual_t2_application_inert()'),
    to_regprocedure('public.guard_pos_manual_t2_sale_link_inert()'),to_regprocedure('public.guard_pos_manual_t2_payment_link_inert()')
  ]))<>(CASE WHEN to_regprocedure('public.pos_manual_sweep_expired_applications_v1(text,integer,text,text)') IS NULL THEN 4 ELSE 3 END) THEN
    RAISE EXCEPTION 'partial T2-00 deployment: inert trigger allowlist mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pos_manual_payment_applications)
    OR (to_regclass('public.pos_manual_t2_authorities') IS NULL
      AND EXISTS (SELECT 1 FROM public.pos_manual_finalization_profiles))
    OR EXISTS (SELECT 1 FROM public.pos_manual_application_snapshots)
    OR EXISTS (SELECT 1 FROM public.pos_manual_application_manifest_entries)
    OR EXISTS (SELECT 1 FROM public.pos_manual_application_effects)
    OR EXISTS (SELECT 1 FROM public.pos_manual_payment_reconciliation_gates WHERE enabled)
    OR (to_regclass('public.pos_manual_t2_authorities') IS NULL AND EXISTS (
      SELECT 1 FROM public.pos_manual_payment_reconciliation_gates
       WHERE finalization_profile_id IS NOT NULL OR finalization_profile_version IS NOT NULL OR finalization_profile_hash IS NOT NULL))
    OR (to_regclass('public.pos_manual_t2_authorities') IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.pos_manual_payment_reconciliation_gates gate
       WHERE ((gate.finalization_profile_id IS NULL)::integer
            +(gate.finalization_profile_version IS NULL)::integer
            +(gate.finalization_profile_hash IS NULL)::integer) NOT IN (0,3)
          OR (gate.finalization_profile_id IS NOT NULL AND NOT EXISTS (
            SELECT 1
              FROM public.pos_manual_finalization_profiles profile
              JOIN public.pos_manual_profile_gate_bindings binding
                ON binding.profile_id=profile.id AND binding.connector_id=gate.connector_id
               AND binding.new_profile_version=profile.version AND binding.new_profile_hash=profile.config_hash
              JOIN public.pos_manual_profile_operations operation
                ON operation.id=binding.operation_id AND operation.profile_id=profile.id
               AND operation.action='activate' AND operation.to_state='active'
               AND operation.profile_version=profile.version AND operation.resulting_config_hash=profile.config_hash
               AND operation.write_txid=binding.write_txid
             WHERE profile.id=gate.finalization_profile_id
               AND profile.version=gate.finalization_profile_version
               AND profile.config_hash=gate.finalization_profile_hash
               AND profile.state IN ('active','retired')
          ))))
  THEN
    RAISE EXCEPTION 'T2-00 hard-off invariant diverges';
  END IF;
END
$$;

-- T2-01 is a closed catalog graph. Once any marker appears, every new
-- relation (including exact columns/defaults and constraints), every changed
-- routine body/security shape and every retrofit trigger must match.
DO $$
DECLARE
  marker_present BOOLEAN := to_regclass('public.pos_manual_t2_authorities') IS NOT NULL
    OR to_regclass('public.pos_manual_t2_lock_contexts') IS NOT NULL
    OR to_regprocedure('public.pos_manual_prepare_session_transition_v1(text,integer,integer,integer,text,text,text)') IS NOT NULL
    OR EXISTS (SELECT 1 FROM public._prisma_migrations
      WHERE migration_name='20260829322100_pos_manual_payment_t2_profile_lifecycle');
  shape RECORD;
  function_count INTEGER;
  function_sha256 TEXT;
  trigger_count INTEGER;
  trigger_sha256 TEXT;
BEGIN
  IF NOT marker_present THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public._prisma_migrations
    WHERE migration_name='20260829322100_pos_manual_payment_t2_profile_lifecycle'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count=1) THEN
    RAISE EXCEPTION 'partial T2-01 deployment: migration ledger missing';
  END IF;

  FOR shape IN SELECT * FROM (VALUES
    ('pos_manual_t2_authorities',4,'dbf86ec4a0233b1b45839b9e51284a274e29034dc2475e971e36f66a419dadc7',7,
      CASE WHEN to_regprocedure('public.pos_manual_sweep_expired_applications_v1(text,integer,text,text)') IS NULL
        THEN '3e35a0eaa6dc13ed3d03e1a7a360698643b6c35130f4f44f41a0475647e0e040'
        ELSE '9568b42512956bb4913edc09583590585898dc16ee655d769116ef03f2b60cd6' END),
    ('pos_manual_t2_lock_contexts',13,'0376f7334e37bf49aef2a3c251d3f2868c1ca57da7ef6fee974610bdb469b82f',12,'d33c9fae701c403e4c2a2eff1099852fc79b5207b964e56b56504d36db7a46f8'),
    ('pos_manual_profile_operations',19,'feb8187553641756c268e424bd14ec400288319c26b14d672b1441d896d301f9',30,'bcde2458a38bd540b01d247b6e68c5446ad4c86ae85cecbb4ff63e1260c392f0'),
    ('pos_manual_profile_state_events',13,'afc257d8153bf90f244905d460724b80d330d82bde68008bc0d9bb2b24557285',19,'d224d642404f2708fccf990f518dad4de81b3e5275d090873e821c62add30607'),
    ('pos_manual_profile_gate_bindings',11,'a96600835927c1dfc8774a32933b8ee7d3ccf41cf68d449754e054472afa18e2',13,'a9aacccb25be7443ddb99fd5338bf484d66dcb5fd699e6c41385c6ea936a944e'),
    ('pos_manual_profile_admin_assertions',17,'626888af6019c16070f3feee748f2b217eb302d008d43def32e4ddbc6c064380',24,'aa26e924870cab5dfe91950a15d7c04070c81fec1e632431685c210c15b7ee6d'),
    ('pos_manual_profile_accounting_assertions',16,'93f6b8b766d06503ccc4f9059fa7775edd9c70556289de2f6587855115cb159a',22,'7f678069804abfff5852a683debabbd5c9c5f526c04dd91240490ce588a7844f'),
    ('pos_manual_profile_fiscal_assertions',17,'78516ebcc767c80ad3fbfab7820c8d738fcfbcc0efdc63bad1de0f8887f3b8f3',23,'f7d989bb9d43eebd2918df7240b90c7829cd029aa6aac07f9d79691cf5104413')
  ) expected(table_name,column_count,column_sha256,constraint_count,constraint_sha256)
  LOOP
    IF to_regclass('public.'||shape.table_name) IS NULL
      OR (SELECT relowner FROM pg_class WHERE oid=to_regclass('public.'||shape.table_name))
        IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.migrator_role'))
      OR NOT EXISTS (SELECT 1 FROM (
        SELECT count(*)::integer column_count,
          encode(sha256(convert_to(string_agg(attribute.attname||':'||format_type(attribute.atttypid,attribute.atttypmod)||':'||attribute.attnotnull::text||':'||coalesce(pg_get_expr(default_value.adbin,default_value.adrelid),''),E'\n' ORDER BY attribute.attnum),'UTF8')),'hex') column_sha256
        FROM pg_attribute attribute LEFT JOIN pg_attrdef default_value
          ON default_value.adrelid=attribute.attrelid AND default_value.adnum=attribute.attnum
        WHERE attribute.attrelid=to_regclass('public.'||shape.table_name) AND attribute.attnum>0 AND NOT attribute.attisdropped
      ) actual WHERE actual.column_count=shape.column_count AND actual.column_sha256=shape.column_sha256)
      OR NOT EXISTS (SELECT 1 FROM (
        SELECT count(*)::integer constraint_count,
          encode(sha256(convert_to(string_agg(constraint_row.conname||':'||constraint_row.contype::text||':'||constraint_row.convalidated::text||':'||constraint_row.condeferrable::text||':'||constraint_row.condeferred::text||':'||constraint_row.confdeltype::text||':'||constraint_row.confupdtype::text||':'||constraint_row.confmatchtype::text||':'||constraint_row.connoinherit::text||':'||regexp_replace(pg_get_constraintdef(constraint_row.oid,true),'[[:space:]]+','','g'),E'\n' ORDER BY constraint_row.conname),'UTF8')),'hex') constraint_sha256
        FROM pg_constraint constraint_row WHERE constraint_row.conrelid=to_regclass('public.'||shape.table_name)
      ) actual WHERE actual.constraint_count=shape.constraint_count AND actual.constraint_sha256=shape.constraint_sha256) THEN
      RAISE EXCEPTION 'partial T2-01 deployment: relation catalog manifest mismatch: %',shape.table_name;
    END IF;
  END LOOP;

  SELECT count(*)::integer,
    encode(sha256(convert_to(string_agg(routine.oid::regprocedure::text||':'||encode(sha256(convert_to(routine.prosrc,'UTF8')),'hex')||':'||routine.provolatile::text||':'||routine.proisstrict::text||':'||routine.prosecdef::text||':'||coalesce(array_to_string(routine.proconfig,';'),''),E'\n' ORDER BY routine.oid::regprocedure::text),'UTF8')),'hex')
    INTO function_count,function_sha256
    FROM pg_proc routine JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
   WHERE namespace.nspname='public' AND (
     routine.proname LIKE 'pos_manual_t2_%' OR routine.proname LIKE 'pos_manual_prepare_%transition_v1'
     OR routine.proname='pos_manual_prepare_plan_release_v1' OR routine.proname LIKE 'pos_manual_issue_profile_%'
     OR routine.proname LIKE 'pos_manual_%finalization_profile_v1' OR routine.proname='guard_pos_manual_profile_assertion_v1'
     OR routine.proname IN ('block_pos_session_with_manual_case','block_handoff_with_manual_case','block_plan_release_with_manual_case','guard_pos_manual_t2_profile_inert','protect_pos_manual_reconciliation_gate')
     OR routine.proname LIKE '%_t2_01_impl'
     OR routine.proname IN ('pos_manual_prepare_held_sale_items_write_v1','pos_manual_prepare_payment_plan_graph_write_v1','pos_manual_prepare_payment_plan_graph_write_core_v1','pos_manual_prepare_order_claim_write_v1','pos_manual_prepare_payment_intent_write_v1','pos_manual_prepare_manual_payment_reference_write_v1','pos_manual_prepare_sale_payment_write_v1')
     OR routine.proname IN ('pos_manual_review_case_v1','pos_manual_record_callback_v1','pos_manual_attest_query_response_v1','pos_manual_complete_delivery_v1','pos_manual_report_transport_v1','pos_manual_claim_queries_v1','pos_manual_open_case_v1'));
  IF function_count<>(CASE WHEN to_regprocedure('public.pos_manual_sweep_expired_applications_v1(text,integer,text,text)') IS NULL THEN 93 ELSE 128 END)
    OR function_sha256<>ALL(CASE WHEN to_regprocedure('public.pos_manual_sweep_expired_applications_v1(text,integer,text,text)') IS NULL
      THEN ARRAY['391763bcef88b09f799c4a88c627f2dbb21c7656834247933309f83847548fb3']::text[]
      ELSE ARRAY[
        'be1165013974be1204b4cee71967734749740348b2c7df6e8f8fad72cd9bbfcd',
        '98e1418cc869605f86e3f52c227cedd1c7620f4e308fe8fbcb4004e96dafe9fd',
        'dd24ea5e0e87f6e63615473959521dbe4259edfba09c4ade72fd974418d91038',
        'a2a4c097aee74a86839870ef53197ff132d42d2d26113d4b675411dea5aff5fb',
        'fbe5c3a022ee34f3f857bcd576b7d018aa5d538decb731f9bd5b5fc95d954eef'
      ]::text[] END) THEN
    RAISE EXCEPTION 'partial T2-01 deployment: function body/security manifest mismatch';
  END IF;

  SELECT count(*)::integer,
    encode(sha256(convert_to(string_agg(relation.relname||':'||trigger_row.tgname||':'||trigger_row.tgenabled::text||':'||regexp_replace(pg_get_triggerdef(trigger_row.oid,true),'[[:space:]]+',' ','g'),E'\n' ORDER BY relation.relname,trigger_row.tgname),'UTF8')),'hex')
    INTO trigger_count,trigger_sha256
    FROM pg_trigger trigger_row JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
   WHERE namespace.nspname='public' AND NOT trigger_row.tgisinternal AND (
     relation.relname LIKE 'pos_manual_profile_%'
     OR trigger_row.tgfoid IN (to_regprocedure('public.block_pos_session_with_manual_case()'),to_regprocedure('public.block_handoff_with_manual_case()'),to_regprocedure('public.block_plan_release_with_manual_case()'),to_regprocedure('public.guard_pos_manual_t2_profile_inert()'),to_regprocedure('public.protect_pos_manual_reconciliation_gate()')));
  IF trigger_count<>11 OR trigger_sha256<>'c42c98ddb9ab7c3c8c0e0a5d01136f746db5fb0d8cf5f7e84fee56118146bbf3' THEN
    RAISE EXCEPTION 'partial T2-01 deployment: trigger manifest mismatch';
  END IF;
END
$$;

-- The seven rewritten legacy bodies are implementation-only. They retain
-- the historical unqualified relation references behind a fixed
-- pg_catalog,public path, while their externally callable wrappers use the
-- stricter pg_catalog-only path. No operational principal executes an impl.
DO $$
DECLARE
  signature TEXT;
  operational_role NAME;
  operational_roles NAME[] := ARRAY[
    current_setting('nalven.runtime_role')::NAME,current_setting('nalven.manual_worker_role')::NAME,
    current_setting('nalven.manual_callback_role')::NAME,current_setting('nalven.stepup_issuer_role')::NAME,
    current_setting('nalven.manual_homologator_role')::NAME,current_setting('nalven.manual_vault_binder_role')::NAME,
    current_setting('nalven.manual_profile_admin_issuer_role')::NAME,current_setting('nalven.manual_profile_accounting_issuer_role')::NAME,
    current_setting('nalven.manual_profile_fiscal_issuer_role')::NAME,current_setting('nalven.manual_sweeper_role')::NAME
  ];
BEGIN
  IF to_regclass('public.pos_manual_t2_authorities') IS NULL THEN RETURN; END IF;
  FOREACH signature IN ARRAY ARRAY[
    'public.pos_manual_review_case_v1_t2_01_impl(uuid,integer,integer,text,text,text,text,text,text)',
    'public.pos_manual_record_callback_v1_t2_01_impl(text,text,text,text,text,text,text,text,timestamptz,text,text,text,integer,text,bigint,timestamptz,integer,text)',
    'public.pos_manual_attest_query_response_v1_t2_01_impl(uuid,integer,text,text,text,text,text,text,text,text,text,timestamptz,text,text,text,integer,text,bigint,timestamptz,integer,text)',
    'public.pos_manual_complete_delivery_v1_t2_01_impl(uuid,text,uuid,text)',
    'public.pos_manual_report_transport_v1_t2_01_impl(uuid,text,text,text)',
    'public.pos_manual_claim_queries_v1_t2_01_impl(text,integer,integer,text)',
    'public.pos_manual_open_case_v1_t2_01_impl(uuid,text,bigint,text,text,text,text,text,text,text,text,text,text,timestamptz,timestamptz,text)'
  ]::TEXT[] LOOP
    IF to_regprocedure(signature) IS NULL OR NOT EXISTS (
      SELECT 1 FROM pg_proc routine
       WHERE routine.oid=to_regprocedure(signature)
         AND routine.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.migrator_role'))
         AND routine.prosecdef
         AND routine.proconfig=ARRAY['search_path=pg_catalog, public']::TEXT[]
    ) THEN
      RAISE EXCEPTION 'T2-01 internal legacy implementation security shape mismatch: %',signature;
    END IF;
    FOREACH operational_role IN ARRAY operational_roles LOOP
      IF has_function_privilege(operational_role,signature,'EXECUTE') THEN
        RAISE EXCEPTION 'T2-01 internal legacy implementation is operationally executable: % / %',signature,operational_role;
      END IF;
    END LOOP;
    IF EXISTS (
      SELECT 1 FROM pg_proc routine
      CROSS JOIN LATERAL aclexplode(COALESCE(routine.proacl,acldefault('f',routine.proowner))) privilege
      WHERE routine.oid=to_regprocedure(signature) AND privilege.grantee<>routine.proowner
        AND privilege.privilege_type='EXECUTE'
    ) THEN
      RAISE EXCEPTION 'T2-01 internal legacy implementation has a non-owner EXECUTE ACL: %',signature;
    END IF;
  END LOOP;
END
$$;

-- SECURITY DEFINER entrypoints are allowlisted by exact identity. No
-- operational role receives table DML or a wildcard function grant.
DO $$
BEGIN
  IF to_regprocedure('public.pos_manual_issue_step_up_v1(uuid,integer,integer,text,text,text,text,text,text,text)') IS NOT NULL THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.pos_manual_issue_step_up_v1(uuid,integer,integer,text,text,text,text,text,text,text) TO %I',
      current_setting('nalven.stepup_issuer_role')
    );
  END IF;
  IF to_regprocedure('public.pos_manual_review_case_v1(uuid,integer,integer,text,text,text,text,text,text)') IS NOT NULL THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.pos_manual_review_case_v1(uuid,integer,integer,text,text,text,text,text,text) TO %I',
      current_setting('nalven.runtime_role')
    );
  END IF;
  IF to_regprocedure('public.pos_manual_record_callback_v1(text,text,text,text,text,text,text,text,timestamptz,text,text,text,integer,text,bigint,timestamptz,integer,text)') IS NOT NULL THEN
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.pos_manual_record_callback_v1(text,text,text,text,text,text,text,text,timestamptz,text,text,text,integer,text,bigint,timestamptz,integer,text) TO %I',
      current_setting('nalven.manual_callback_role')
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.pos_manual_attest_query_response_v1(uuid,integer,text,text,text,text,text,text,text,text,text,timestamptz,text,text,text,integer,text,bigint,timestamptz,integer,text) TO %I',
      current_setting('nalven.manual_callback_role')
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.pos_manual_complete_delivery_v1(uuid,text,uuid,text) TO %I',
      current_setting('nalven.manual_worker_role')
    );
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION public.pos_manual_report_transport_v1(uuid,text,text,text) TO %I',
      current_setting('nalven.manual_worker_role')
    );
    IF to_regprocedure('public.pos_manual_claim_queries_v1(text,integer,integer,text)') IS NOT NULL THEN
      EXECUTE format(
        'GRANT EXECUTE ON FUNCTION public.pos_manual_claim_queries_v1(text,integer,integer,text) TO %I',
        current_setting('nalven.manual_worker_role')
      );
    END IF;
  END IF;
  IF to_regprocedure('public.pos_manual_prepare_open_v1(text,integer,integer,text,timestamptz,text,text,text)') IS NOT NULL THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_prepare_open_v1(text,integer,integer,text,timestamptz,text,text,text) TO %I',current_setting('nalven.runtime_role'));
  END IF;
  IF to_regprocedure('public.pos_manual_open_status_v1(uuid,integer,text,text)') IS NOT NULL THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_open_status_v1(uuid,integer,text,text) TO %I',current_setting('nalven.runtime_role'));
  END IF;
  IF to_regprocedure('public.pos_manual_claim_open_for_vault_v1(uuid,text,text,text,integer)') IS NOT NULL THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_claim_open_for_vault_v1(uuid,text,text,text,integer) TO %I',current_setting('nalven.manual_vault_binder_role'));
  END IF;
  IF to_regprocedure('public.pos_manual_open_case_v1(uuid,text,bigint,text,text,text,text,text,text,text,text,text,text,timestamptz,timestamptz,text)') IS NOT NULL THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_open_case_v1(uuid,text,bigint,text,text,text,text,text,text,text,text,text,text,timestamptz,timestamptz,text) TO %I',current_setting('nalven.manual_vault_binder_role'));
  END IF;
  IF to_regprocedure('public.pos_manual_abandon_open_v1(uuid,text,bigint,text,text)') IS NOT NULL THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_abandon_open_v1(uuid,text,bigint,text,text) TO %I',current_setting('nalven.manual_vault_binder_role'));
  END IF;
  IF to_regprocedure('public.pos_manual_probe_open_v1(uuid,text)') IS NOT NULL THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_probe_open_v1(uuid,text) TO %I',current_setting('nalven.manual_vault_binder_role'));
  END IF;

  -- T2-01 keeps every table and sequence owner-only. Writers receive only the
  -- exact public entrypoint/preview signatures used by their producers. The
  -- old plan_release prelock is deliberately not granted: supersede/expire now
  -- go through the payment-plan graph capability and its canonical preview.
  IF to_regclass('public.pos_manual_t2_authorities') IS NOT NULL THEN
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_prepare_session_transition_v1(text,integer,integer,integer,text,text,text) TO %I',current_setting('nalven.runtime_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_prepare_handoff_transition_v1(text,text,integer,integer,integer,integer,integer,text,text,text,text,timestamptz,jsonb) TO %I',current_setting('nalven.runtime_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_t2_write_observation_multiset_digest_v1(text[]) TO %I',current_setting('nalven.runtime_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_t2_float8_hex_v1(double precision) TO %I',current_setting('nalven.runtime_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_t2_held_sale_items_request_hash_v1(text,text,integer,text,text,integer,integer,integer,integer,text,text,text) TO %I',current_setting('nalven.runtime_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_prepare_held_sale_items_write_v1(text,text,integer,text,text,text,jsonb,jsonb) TO %I',current_setting('nalven.runtime_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_t2_payment_plan_graph_request_hash_v1(text,text,integer,text,text,jsonb,jsonb,jsonb) TO %I',current_setting('nalven.runtime_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_t2_payment_plan_draft_snapshot_hash_v1(text) TO %I',current_setting('nalven.runtime_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_prepare_payment_plan_graph_write_v1(text,text,integer,text,text,text,jsonb,jsonb,jsonb) TO %I',current_setting('nalven.runtime_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_prepare_order_claim_write_v1(text,text,integer,integer,integer,text,text,text,jsonb) TO %I',current_setting('nalven.runtime_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_t2_payment_intent_request_hash_v1(text,text,integer,text,text,jsonb) TO %I',current_setting('nalven.runtime_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_prepare_payment_intent_write_v1(text,text,integer,text,text,text,jsonb) TO %I',current_setting('nalven.runtime_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_t2_manual_reference_request_hash_v1(text,text,integer,text,text,jsonb) TO %I',current_setting('nalven.runtime_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_prepare_manual_payment_reference_write_v1(text,text,integer,text,text,text,jsonb) TO %I',current_setting('nalven.runtime_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_t2_sale_payment_request_hash_v1(text,text,integer,text,text,jsonb) TO %I',current_setting('nalven.runtime_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_prepare_sale_payment_write_v1(text,text,integer,text,text,text,jsonb) TO %I',current_setting('nalven.runtime_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_put_finalization_profile_v1(integer,integer,jsonb,integer,text,text,text,text) TO %I',current_setting('nalven.runtime_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_issue_profile_admin_assertion_v1(text,integer,uuid,integer,text,text,text,text,text) TO %I',current_setting('nalven.manual_profile_admin_issuer_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_issue_profile_accounting_assertion_v1(uuid,integer,text,text,text,text,text,text) TO %I',current_setting('nalven.manual_profile_accounting_issuer_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_issue_profile_fiscal_assertion_v1(uuid,integer,text,text,text,text,text,text) TO %I',current_setting('nalven.manual_profile_fiscal_issuer_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_activate_finalization_profile_v1(uuid,integer,text,text,text,text,text,text) TO %I',current_setting('nalven.manual_homologator_role'));
    EXECUTE format('GRANT EXECUTE ON FUNCTION public.pos_manual_retire_finalization_profile_v1(uuid,integer,text,text,text,text,text) TO %I',current_setting('nalven.manual_homologator_role'));
  END IF;
END
$$;

-- T2-02 structural manifest. The migration preflight proves the exact T2-01
-- predecessor; this postflight freezes every T2 helper/boundary body plus the
-- complete catalog of relations and triggers changed by T2-02.
DO $$
DECLARE
  relation_names TEXT[] := ARRAY[
    'products','product_variations','pos_value_programs','pos_accounting_periods',
    'pos_accounting_policy_mappings','integration_webhook_endpoints','pos_manual_t2_authorities',
    'pos_manual_application_release_assertions','pos_manual_payment_operations',
    'pos_manual_payment_state_events','pos_manual_payment_incidents',
    'pos_manual_application_promotion_reservation_events','pos_manual_application_promotion_reservations',
    'pos_manual_application_reserve_assertions','pos_manual_application_stock_reservation_events',
    'pos_manual_application_stock_reservations','pos_manual_application_sweep_batches',
    'pos_manual_application_sweep_receipts','pos_manual_t2_boundary_operations',
    'pos_manual_t2_reservation_write_roots'
  ];
  function_count INTEGER; function_sha256 TEXT;
  relation_count INTEGER; relation_sha256 TEXT;
  trigger_count INTEGER; trigger_sha256 TEXT;
BEGIN
  IF to_regprocedure('public.pos_manual_sweep_expired_applications_v1(text,integer,text,text)') IS NULL THEN RETURN; END IF;
  IF NOT EXISTS (SELECT 1 FROM public._prisma_migrations
    WHERE migration_name='20260829322200_pos_manual_payment_t2_reservations'
      AND checksum='6acebb13b4b0abfb8d91667940e080017f8402dbce055e19582ecd3c8e8f8465'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count=1) THEN
    RAISE EXCEPTION 'partial T2-02 deployment: migration ledger missing or checksum mismatch';
  END IF;

  SELECT count(*)::integer,
    encode(sha256(convert_to(string_agg(routine.oid::regprocedure::text||':'||
      encode(sha256(convert_to(routine.prosrc,'UTF8')),'hex')||':'||language.lanname||':'||
      routine.provolatile::text||':'||routine.proisstrict::text||':'||routine.prosecdef::text||':'||
      routine.proleakproof::text||':'||routine.proparallel::text||':'||routine.prokind::text||':'||
      coalesce(array_to_string(routine.proconfig,';'),''),E'\n' ORDER BY routine.oid::regprocedure::text),'UTF8')),'hex')
    INTO function_count,function_sha256
    FROM pg_proc routine JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
    JOIN pg_language language ON language.oid=routine.prolang
   WHERE namespace.nspname='public' AND (routine.proname LIKE 'pos_manual_t2_%'
      OR routine.proname LIKE 'pos_t2_%' OR routine.proname=ANY(ARRAY[
        'guard_pos_manual_application','pos_manual_application_status_by_reservation_v1',
        'pos_manual_application_status_v1','pos_manual_canonical_json_v1',
        'pos_manual_hash_canonical_json_v1','pos_manual_prepare_handoff_transition_v1',
        'pos_manual_prepare_plan_release_v1','pos_manual_prepare_session_transition_v1',
        'pos_manual_reserve_application_v1','pos_manual_reserve_application_v1_impl',
        'pos_manual_sweep_expired_applications_v1','pos_manual_sweep_expired_applications_v1_impl',
        'pos_manual_uuid16_v1']));
  IF function_count<>115 OR function_sha256<>ALL(ARRAY[
      '97a4d5b92c5174d69ab48e99c83716419ae906c3ec5ff46632d505e472bedbf3',
      '172792123d811b6e6ea55aaf3ad31602a659514261088a14fd8dc7bbe32a9493',
      '31e7f4243f645ccdb713da0ee7795a2857e87722371e57e07d8c8e29d99757e9',
      '90a243e8aedd97b2135f29c856f93bd29300a7b61bb2b9cb4cea89db2018fa88',
      '554132ae75f831ec77d317c25fde583831965cc48a33106eec51488b0c7c5ac7'
    ]::text[])
    OR EXISTS (SELECT 1 FROM pg_proc routine JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
      WHERE namespace.nspname='public' AND (routine.proname LIKE 'pos_manual_t2_%'
        OR routine.proname LIKE 'pos_t2_%' OR routine.proname=ANY(ARRAY[
          'guard_pos_manual_application','pos_manual_application_status_by_reservation_v1',
          'pos_manual_application_status_v1','pos_manual_canonical_json_v1','pos_manual_hash_canonical_json_v1',
          'pos_manual_prepare_handoff_transition_v1','pos_manual_prepare_plan_release_v1',
          'pos_manual_prepare_session_transition_v1','pos_manual_reserve_application_v1',
          'pos_manual_reserve_application_v1_impl','pos_manual_sweep_expired_applications_v1',
          'pos_manual_sweep_expired_applications_v1_impl','pos_manual_uuid16_v1']))
        AND routine.proowner<>(SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.migrator_role'))) THEN
    RAISE EXCEPTION 'partial T2-02 deployment: function catalog manifest mismatch';
  END IF;

  IF EXISTS (SELECT 1 FROM unnest(relation_names) relation_name
    WHERE to_regclass('public.'||relation_name) IS NULL
      OR (SELECT relowner FROM pg_class WHERE oid=to_regclass('public.'||relation_name))
        IS DISTINCT FROM (SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.migrator_role'))) THEN
    RAISE EXCEPTION 'partial T2-02 deployment: relation missing or owner mismatch';
  END IF;
  WITH selected(name) AS (SELECT unnest(relation_names)), catalog AS (
    SELECT selected.name,
      (SELECT string_agg(attribute.attname||':'||format_type(attribute.atttypid,attribute.atttypmod)||':'||attribute.attnotnull::text||':'||coalesce(pg_get_expr(default_value.adbin,default_value.adrelid),'')||':'||attribute.attidentity::text||':'||attribute.attgenerated::text,E'\n' ORDER BY attribute.attnum)
         FROM pg_attribute attribute LEFT JOIN pg_attrdef default_value ON default_value.adrelid=attribute.attrelid AND default_value.adnum=attribute.attnum
        WHERE attribute.attrelid=to_regclass('public.'||selected.name) AND attribute.attnum>0 AND NOT attribute.attisdropped) columns,
      (SELECT string_agg(constraint_row.conname||':'||constraint_row.contype::text||':'||constraint_row.convalidated::text||':'||constraint_row.condeferrable::text||':'||constraint_row.condeferred::text||':'||constraint_row.confdeltype::text||':'||constraint_row.confupdtype::text||':'||constraint_row.confmatchtype::text||':'||constraint_row.connoinherit::text||':'||regexp_replace(pg_get_constraintdef(constraint_row.oid,true),'[[:space:]]+','','g'),E'\n' ORDER BY constraint_row.conname)
         FROM pg_constraint constraint_row WHERE constraint_row.conrelid=to_regclass('public.'||selected.name)) constraints,
      (SELECT string_agg(pg_get_indexdef(index_row.indexrelid),E'\n' ORDER BY index_row.indexrelid::regclass::text)
         FROM pg_index index_row WHERE index_row.indrelid=to_regclass('public.'||selected.name)) indexes
      FROM selected)
  SELECT count(*)::integer,encode(sha256(convert_to(string_agg(name||E'\nC\n'||coalesce(columns,'')||E'\nK\n'||coalesce(constraints,'')||E'\nI\n'||coalesce(indexes,''),E'\nR\n' ORDER BY name),'UTF8')),'hex')
    INTO relation_count,relation_sha256 FROM catalog;
  IF relation_count<>20 OR relation_sha256<>'ef002d9cfa7deeb5ef90b37bee866bbf3ebf8168987990187a195991f338bb10' THEN
    RAISE EXCEPTION 'partial T2-02 deployment: relation catalog manifest mismatch';
  END IF;

  SELECT count(*)::integer,encode(sha256(convert_to(string_agg(relation.relname||':'||trigger_row.tgname||':'||trigger_row.tgenabled::text||':'||trigger_row.tgtype::text||':'||trigger_row.tgdeferrable::text||':'||trigger_row.tginitdeferred::text||':'||regexp_replace(pg_get_triggerdef(trigger_row.oid,true),'[[:space:]]+',' ','g'),E'\n' ORDER BY relation.relname,trigger_row.tgname),'UTF8')),'hex')
    INTO trigger_count,trigger_sha256
    FROM pg_trigger trigger_row JOIN pg_class relation ON relation.oid=trigger_row.tgrelid
    JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
   WHERE namespace.nspname='public' AND NOT trigger_row.tgisinternal AND trigger_row.tgname LIKE 'pos_manual_t2_%';
  IF trigger_count<>46 OR trigger_sha256<>'31fd1ac21f4dffe3dbfd49d0eb947b8cdcfbfa931bdb4697eba34331bcbef442' THEN
    RAISE EXCEPTION 'partial T2-02 deployment: trigger catalog manifest mismatch';
  END IF;
END
$$;

-- T2-02 is version-aware: a pre-T2-02 database remains reconcilable with the
-- sweeper quarantined. Once either the ledger or an ABI appears, the nine
-- public entrypoints must be complete, owner-defined and exact-role only.
DO $$
DECLARE
  capability RECORD;
  operational_role NAME;
  operational_roles NAME[] := ARRAY[
    current_setting('nalven.runtime_role')::NAME,current_setting('nalven.manual_worker_role')::NAME,
    current_setting('nalven.manual_callback_role')::NAME,current_setting('nalven.stepup_issuer_role')::NAME,
    current_setting('nalven.manual_homologator_role')::NAME,current_setting('nalven.manual_vault_binder_role')::NAME,
    current_setting('nalven.manual_profile_admin_issuer_role')::NAME,current_setting('nalven.manual_profile_accounting_issuer_role')::NAME,
    current_setting('nalven.manual_profile_fiscal_issuer_role')::NAME,current_setting('nalven.manual_sweeper_role')::NAME
  ];
  migration_ready BOOLEAN := EXISTS (SELECT 1 FROM public._prisma_migrations
    WHERE migration_name='20260829322200_pos_manual_payment_t2_reservations'
      AND checksum='6acebb13b4b0abfb8d91667940e080017f8402dbce055e19582ecd3c8e8f8465'
      AND finished_at IS NOT NULL AND rolled_back_at IS NULL AND applied_steps_count=1);
  marker_present BOOLEAN;
BEGIN
  SELECT migration_ready OR EXISTS (
    SELECT 1 FROM unnest(ARRAY[
      'public.pos_manual_reserve_application_v1(uuid,integer,integer,text,text,text)',
      'public.pos_manual_application_status_v1(uuid,text)',
      'public.pos_manual_application_status_by_reservation_v1(uuid,text,text,integer,text)',
      'public.pos_manual_sweep_expired_applications_v1(text,integer,text,text)',
      'public.pos_t2_catalog_boundary_v1(text,integer,integer,text,jsonb,jsonb,text,text,text)',
      'public.pos_t2_value_program_boundary_v1(text,text,integer,text,integer,text,text,text,integer,integer,integer,integer,text,text,text)',
      'public.pos_t2_accounting_period_put_v1(integer,integer,integer,date,date,text,text,text,text)',
      'public.pos_t2_accounting_period_close_v1(text,integer,text,text,text,text,text)',
      'public.pos_t2_webhook_boundary_v1(text,text,integer,text,text,text,text,text,text,text,text,text,text,text)'
    ]) signature WHERE to_regprocedure(signature) IS NOT NULL
  ) INTO marker_present;
  IF NOT marker_present THEN RETURN; END IF;
  IF NOT migration_ready THEN
    RAISE EXCEPTION 'partial T2-02 deployment: capability exists without migration ledger';
  END IF;
  FOR capability IN SELECT * FROM (VALUES
    ('public.pos_manual_reserve_application_v1(uuid,integer,integer,text,text,text)',current_setting('nalven.runtime_role')::NAME,'search_path=pg_catalog'),
    ('public.pos_manual_application_status_v1(uuid,text)',current_setting('nalven.runtime_role')::NAME,'search_path=pg_catalog'),
    ('public.pos_manual_application_status_by_reservation_v1(uuid,text,text,integer,text)',current_setting('nalven.runtime_role')::NAME,'search_path=pg_catalog'),
    ('public.pos_manual_sweep_expired_applications_v1(text,integer,text,text)',current_setting('nalven.manual_sweeper_role')::NAME,'search_path=pg_catalog'),
    ('public.pos_t2_catalog_boundary_v1(text,integer,integer,text,jsonb,jsonb,text,text,text)',current_setting('nalven.runtime_role')::NAME,'search_path=pg_catalog'),
    ('public.pos_t2_value_program_boundary_v1(text,text,integer,text,integer,text,text,text,integer,integer,integer,integer,text,text,text)',current_setting('nalven.runtime_role')::NAME,'search_path=pg_catalog'),
    ('public.pos_t2_accounting_period_put_v1(integer,integer,integer,date,date,text,text,text,text)',current_setting('nalven.runtime_role')::NAME,'search_path=pg_catalog'),
    ('public.pos_t2_accounting_period_close_v1(text,integer,text,text,text,text,text)',current_setting('nalven.runtime_role')::NAME,'search_path=pg_catalog'),
    ('public.pos_t2_webhook_boundary_v1(text,text,integer,text,text,text,text,text,text,text,text,text,text,text)',current_setting('nalven.runtime_role')::NAME,'search_path=pg_catalog')
  ) expected(signature,allowed_role,expected_path)
  LOOP
    IF to_regprocedure(capability.signature) IS NULL THEN
      RAISE EXCEPTION 'partial T2-02 deployment: capability missing: %',capability.signature;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc routine WHERE routine.oid=to_regprocedure(capability.signature)
      AND (routine.proowner<>(SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.migrator_role'))
        OR NOT routine.prosecdef OR routine.proconfig IS DISTINCT FROM ARRAY[capability.expected_path]::TEXT[])) THEN
      RAISE EXCEPTION 'partial T2-02 deployment: capability security shape mismatch: %',capability.signature;
    END IF;
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',capability.signature,capability.allowed_role);
  END LOOP;

  FOR capability IN SELECT * FROM (VALUES
    ('public.pos_manual_reserve_application_v1(uuid,integer,integer,text,text,text)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_application_status_v1(uuid,text)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_application_status_by_reservation_v1(uuid,text,text,integer,text)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_sweep_expired_applications_v1(text,integer,text,text)',current_setting('nalven.manual_sweeper_role')::NAME),
    ('public.pos_t2_catalog_boundary_v1(text,integer,integer,text,jsonb,jsonb,text,text,text)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_t2_value_program_boundary_v1(text,text,integer,text,integer,text,text,text,integer,integer,integer,integer,text,text,text)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_t2_accounting_period_put_v1(integer,integer,integer,date,date,text,text,text,text)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_t2_accounting_period_close_v1(text,integer,text,text,text,text,text)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_t2_webhook_boundary_v1(text,text,integer,text,text,text,text,text,text,text,text,text,text,text)',current_setting('nalven.runtime_role')::NAME)
  ) expected(signature,allowed_role)
  LOOP
    FOREACH operational_role IN ARRAY operational_roles LOOP
      IF has_function_privilege(operational_role,capability.signature,'EXECUTE')
        IS DISTINCT FROM (operational_role=capability.allowed_role) THEN
        RAISE EXCEPTION 'T2-02 capability EXECUTE allowlist diverges: % / %',capability.signature,operational_role;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_proc routine
      CROSS JOIN LATERAL aclexplode(COALESCE(routine.proacl,acldefault('f',routine.proowner))) privilege
      WHERE routine.oid=to_regprocedure(capability.signature)
        AND privilege.grantee=0 AND privilege.privilege_type='EXECUTE') THEN
      RAISE EXCEPTION 'PUBLIC executes T2-02 capability: %',capability.signature;
    END IF;
  END LOOP;
END
$$;

-- Every T2-01 capability has exactly one nominal authority.  This audit is
-- deliberately independent from the registry contents: a forged registry row
-- cannot broaden an ACL, and a stray grant to any operational role is fatal.
DO $$
DECLARE
  capability RECORD;
  operational_role NAME;
  operational_roles NAME[] := ARRAY[
    current_setting('nalven.runtime_role')::NAME,current_setting('nalven.manual_worker_role')::NAME,
    current_setting('nalven.manual_callback_role')::NAME,current_setting('nalven.stepup_issuer_role')::NAME,
    current_setting('nalven.manual_homologator_role')::NAME,current_setting('nalven.manual_vault_binder_role')::NAME,
    current_setting('nalven.manual_profile_admin_issuer_role')::NAME,current_setting('nalven.manual_profile_accounting_issuer_role')::NAME,
    current_setting('nalven.manual_profile_fiscal_issuer_role')::NAME,current_setting('nalven.manual_sweeper_role')::NAME
  ];
BEGIN
  IF to_regclass('public.pos_manual_t2_authorities') IS NULL THEN RETURN; END IF;
  FOR capability IN SELECT * FROM (VALUES
    ('public.pos_manual_prepare_session_transition_v1(text,integer,integer,integer,text,text,text)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_prepare_handoff_transition_v1(text,text,integer,integer,integer,integer,integer,text,text,text,text,timestamp with time zone,jsonb)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_t2_write_observation_multiset_digest_v1(text[])',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_t2_float8_hex_v1(double precision)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_t2_held_sale_items_request_hash_v1(text,text,integer,text,text,integer,integer,integer,integer,text,text,text)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_prepare_held_sale_items_write_v1(text,text,integer,text,text,text,jsonb,jsonb)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_t2_payment_plan_graph_request_hash_v1(text,text,integer,text,text,jsonb,jsonb,jsonb)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_t2_payment_plan_draft_snapshot_hash_v1(text)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_prepare_payment_plan_graph_write_v1(text,text,integer,text,text,text,jsonb,jsonb,jsonb)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_prepare_order_claim_write_v1(text,text,integer,integer,integer,text,text,text,jsonb)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_t2_payment_intent_request_hash_v1(text,text,integer,text,text,jsonb)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_prepare_payment_intent_write_v1(text,text,integer,text,text,text,jsonb)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_t2_manual_reference_request_hash_v1(text,text,integer,text,text,jsonb)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_prepare_manual_payment_reference_write_v1(text,text,integer,text,text,text,jsonb)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_t2_sale_payment_request_hash_v1(text,text,integer,text,text,jsonb)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_prepare_sale_payment_write_v1(text,text,integer,text,text,text,jsonb)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_put_finalization_profile_v1(integer,integer,jsonb,integer,text,text,text,text)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_issue_profile_admin_assertion_v1(text,integer,uuid,integer,text,text,text,text,text)',current_setting('nalven.manual_profile_admin_issuer_role')::NAME),
    ('public.pos_manual_issue_profile_accounting_assertion_v1(uuid,integer,text,text,text,text,text,text)',current_setting('nalven.manual_profile_accounting_issuer_role')::NAME),
    ('public.pos_manual_issue_profile_fiscal_assertion_v1(uuid,integer,text,text,text,text,text,text)',current_setting('nalven.manual_profile_fiscal_issuer_role')::NAME),
    ('public.pos_manual_activate_finalization_profile_v1(uuid,integer,text,text,text,text,text,text)',current_setting('nalven.manual_homologator_role')::NAME),
    ('public.pos_manual_retire_finalization_profile_v1(uuid,integer,text,text,text,text,text)',current_setting('nalven.manual_homologator_role')::NAME)
  ) expected(signature,allowed_role)
  LOOP
    IF to_regprocedure(capability.signature) IS NULL THEN
      RAISE EXCEPTION 'partial T2-01 deployment: capability missing: %',capability.signature;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc routine WHERE routine.oid=to_regprocedure(capability.signature)
      AND (routine.proowner<>(SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.migrator_role'))
        OR NOT routine.prosecdef OR routine.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::TEXT[])) THEN
      RAISE EXCEPTION 'partial T2-01 deployment: capability security shape mismatch: %',capability.signature;
    END IF;
    FOREACH operational_role IN ARRAY operational_roles LOOP
      IF has_function_privilege(operational_role,capability.signature,'EXECUTE')
        IS DISTINCT FROM (operational_role=capability.allowed_role) THEN
        RAISE EXCEPTION 'T2-01 capability EXECUTE allowlist diverges: % / %',capability.signature,operational_role;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_proc routine CROSS JOIN LATERAL aclexplode(COALESCE(routine.proacl,acldefault('f',routine.proowner))) privilege
      WHERE routine.oid=to_regprocedure(capability.signature) AND privilege.grantee=0 AND privilege.privilege_type='EXECUTE') THEN
      RAISE EXCEPTION 'PUBLIC executes T2-01 capability: %',capability.signature;
    END IF;
  END LOOP;

  IF has_function_privilege(current_setting('nalven.runtime_role'),
       'public.pos_manual_prepare_plan_release_v1(text,text,integer,text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'obsolete T2-01 plan release prelock is executable by runtime';
  END IF;
END
$$;

-- 321f is fail-closed before its migration exists. Once a signature appears,
-- its owner, definer search_path and exact single-role EXECUTE ACL are enforced.
DO $$
DECLARE
  capability RECORD;
  signature TEXT;
  allowed_role NAME;
  operational_role NAME;
  operational_roles NAME[] := ARRAY[
    current_setting('nalven.runtime_role')::NAME,current_setting('nalven.manual_worker_role')::NAME,
    current_setting('nalven.manual_callback_role')::NAME,current_setting('nalven.stepup_issuer_role')::NAME,
    current_setting('nalven.manual_homologator_role')::NAME,current_setting('nalven.manual_vault_binder_role')::NAME,
    current_setting('nalven.manual_profile_admin_issuer_role')::NAME,current_setting('nalven.manual_profile_accounting_issuer_role')::NAME,
    current_setting('nalven.manual_profile_fiscal_issuer_role')::NAME,current_setting('nalven.manual_sweeper_role')::NAME
  ];
BEGIN
  FOR capability IN SELECT * FROM (VALUES
    ('public.pos_manual_prepare_open_v1(text,integer,integer,text,timestamptz,text,text,text)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_open_status_v1(uuid,integer,text,text)',current_setting('nalven.runtime_role')::NAME),
    ('public.pos_manual_claim_open_for_vault_v1(uuid,text,text,text,integer)',current_setting('nalven.manual_vault_binder_role')::NAME),
    ('public.pos_manual_open_case_v1(uuid,text,bigint,text,text,text,text,text,text,text,text,text,text,timestamptz,timestamptz,text)',current_setting('nalven.manual_vault_binder_role')::NAME),
    ('public.pos_manual_abandon_open_v1(uuid,text,bigint,text,text)',current_setting('nalven.manual_vault_binder_role')::NAME),
    ('public.pos_manual_probe_open_v1(uuid,text)',current_setting('nalven.manual_vault_binder_role')::NAME)
  ) AS expected(signature,allowed_role)
  LOOP
    signature:=capability.signature; allowed_role:=capability.allowed_role;
    IF to_regprocedure(signature) IS NULL THEN CONTINUE; END IF;
    IF (SELECT proowner<>(SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.migrator_role'))
          OR prosecdef IS DISTINCT FROM true OR proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog']::TEXT[]
          FROM pg_proc WHERE oid=to_regprocedure(signature)) THEN
      RAISE EXCEPTION '321f function owner/security/search_path diverges: %',signature;
    END IF;
    FOREACH operational_role IN ARRAY operational_roles LOOP
      IF has_function_privilege(operational_role,signature,'EXECUTE') IS DISTINCT FROM (operational_role=allowed_role) THEN
        RAISE EXCEPTION '321f function EXECUTE allowlist diverges: % / %',signature,operational_role;
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_proc routine CROSS JOIN LATERAL aclexplode(COALESCE(routine.proacl,acldefault('f',routine.proowner))) privilege
      WHERE routine.oid=to_regprocedure(signature) AND privilege.grantee=0 AND privilege.privilege_type='EXECUTE')
    THEN RAISE EXCEPTION 'PUBLIC executes 321f function: %',signature; END IF;
  END LOOP;
END
$$;

ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM :"manual_worker_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM :"manual_callback_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM :"stepup_issuer_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM :"manual_homologator_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM :"manual_vault_binder_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM :"manual_profile_admin_issuer_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM :"manual_profile_accounting_issuer_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM :"manual_profile_fiscal_issuer_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON TABLES FROM :"manual_sweeper_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM :"manual_worker_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM :"manual_callback_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM :"stepup_issuer_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM :"manual_homologator_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM :"manual_vault_binder_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM :"manual_profile_admin_issuer_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM :"manual_profile_accounting_issuer_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM :"manual_profile_fiscal_issuer_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE ALL PRIVILEGES ON SEQUENCES FROM :"manual_sweeper_role";
-- EXECUTE para PUBLIC nasce no default ACL global do PostgreSQL; uma revogação
-- limitada ao schema não consegue sobrepor esse grant global.
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role"
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM :"runtime_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM :"manual_worker_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM :"manual_callback_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM :"stepup_issuer_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM :"manual_homologator_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM :"manual_vault_binder_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM :"manual_profile_admin_issuer_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM :"manual_profile_accounting_issuer_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM :"manual_profile_fiscal_issuer_role";
ALTER DEFAULT PRIVILEGES FOR ROLE :"migrator_role" IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM :"manual_sweeper_role";

DO $$
BEGIN
  IF has_database_privilege(
    current_setting('nalven.runtime_role'), current_database(), 'CREATE'
  ) OR has_database_privilege(
    current_setting('nalven.runtime_role'), current_database(), 'TEMPORARY'
  ) OR has_schema_privilege(
    current_setting('nalven.runtime_role'), 'public', 'CREATE'
  ) THEN
    RAISE EXCEPTION 'runtime role % retained DDL or temporary-object privileges',
      current_setting('nalven.runtime_role');
  END IF;

  IF has_table_privilege(
    current_setting('nalven.runtime_role'), 'public._prisma_migrations', 'SELECT'
  ) THEN
    RAISE EXCEPTION 'runtime role % can read Prisma migration history',
      current_setting('nalven.runtime_role');
  END IF;
EXCEPTION
  WHEN undefined_table THEN NULL;
END
$$;

DO $$
DECLARE
  callback_signatures TEXT[] := ARRAY[
    'public.pos_manual_record_callback_v1(text,text,text,text,text,text,text,text,timestamptz,text,text,text,integer,text,bigint,timestamptz,integer,text)',
    'public.pos_manual_attest_query_response_v1(uuid,integer,text,text,text,text,text,text,text,text,text,timestamptz,text,text,text,integer,text,bigint,timestamptz,integer,text)'
  ];
  worker_signatures TEXT[] := ARRAY[
    'public.pos_manual_complete_delivery_v1(uuid,text,uuid,text)',
    'public.pos_manual_report_transport_v1(uuid,text,text,text)',
    'public.pos_manual_claim_queries_v1(text,integer,integer,text)'
  ];
  signature TEXT;
BEGIN
  FOREACH signature IN ARRAY callback_signatures LOOP
    IF to_regprocedure(signature) IS NOT NULL AND (
      NOT has_function_privilege(current_setting('nalven.manual_callback_role'), signature, 'EXECUTE')
      OR has_function_privilege(current_setting('nalven.runtime_role'), signature, 'EXECUTE')
      OR has_function_privilege(current_setting('nalven.manual_worker_role'), signature, 'EXECUTE')
      OR has_function_privilege(current_setting('nalven.stepup_issuer_role'), signature, 'EXECUTE')
      OR has_function_privilege(current_setting('nalven.manual_homologator_role'), signature, 'EXECUTE')
      OR has_function_privilege(current_setting('nalven.manual_vault_binder_role'), signature, 'EXECUTE')
      OR has_function_privilege(current_setting('nalven.manual_sweeper_role'), signature, 'EXECUTE')
    ) THEN RAISE EXCEPTION 'manual callback function EXECUTE allowlist diverges: %', signature; END IF;
  END LOOP;
  FOREACH signature IN ARRAY worker_signatures LOOP
    IF to_regprocedure(signature) IS NOT NULL AND (
      NOT has_function_privilege(current_setting('nalven.manual_worker_role'), signature, 'EXECUTE')
      OR has_function_privilege(current_setting('nalven.runtime_role'), signature, 'EXECUTE')
      OR has_function_privilege(current_setting('nalven.manual_callback_role'), signature, 'EXECUTE')
      OR has_function_privilege(current_setting('nalven.stepup_issuer_role'), signature, 'EXECUTE')
      OR has_function_privilege(current_setting('nalven.manual_homologator_role'), signature, 'EXECUTE')
      OR has_function_privilege(current_setting('nalven.manual_vault_binder_role'), signature, 'EXECUTE')
      OR has_function_privilege(current_setting('nalven.manual_sweeper_role'), signature, 'EXECUTE')
    ) THEN RAISE EXCEPTION 'manual worker function EXECUTE allowlist diverges: %', signature; END IF;
  END LOOP;
  FOREACH signature IN ARRAY callback_signatures||worker_signatures LOOP
    IF to_regprocedure(signature) IS NOT NULL AND EXISTS (
      SELECT 1 FROM pg_proc routine
       WHERE routine.oid=to_regprocedure(signature)
         AND (routine.proowner<>(SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.migrator_role'))
           OR routine.prosecdef IS DISTINCT FROM true
           OR routine.proconfig IS DISTINCT FROM CASE
             WHEN to_regclass('public.pos_manual_t2_authorities') IS NOT NULL
               OR signature='public.pos_manual_claim_queries_v1(text,integer,integer,text)'
               THEN ARRAY['search_path=pg_catalog']::TEXT[]
             ELSE ARRAY['search_path=pg_catalog, public']::TEXT[] END)
    ) THEN RAISE EXCEPTION 'manual proof capability owner/SECURITY DEFINER/search_path diverges: %', signature; END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  issue_signature TEXT := 'public.pos_manual_issue_step_up_v1(uuid,integer,integer,text,text,text,text,text,text,text)';
  review_signature TEXT := 'public.pos_manual_review_case_v1(uuid,integer,integer,text,text,text,text,text,text)';
BEGIN
  IF to_regprocedure(issue_signature) IS NOT NULL AND (
    NOT has_function_privilege(current_setting('nalven.stepup_issuer_role'), issue_signature, 'EXECUTE')
    OR has_function_privilege(current_setting('nalven.runtime_role'), issue_signature, 'EXECUTE')
    OR has_function_privilege(current_setting('nalven.manual_worker_role'), issue_signature, 'EXECUTE')
    OR has_function_privilege(current_setting('nalven.manual_callback_role'), issue_signature, 'EXECUTE')
    OR has_function_privilege(current_setting('nalven.manual_homologator_role'), issue_signature, 'EXECUTE')
    OR has_function_privilege(current_setting('nalven.manual_vault_binder_role'), issue_signature, 'EXECUTE')
    OR has_function_privilege(current_setting('nalven.manual_sweeper_role'), issue_signature, 'EXECUTE')
    OR EXISTS (
      SELECT 1
        FROM pg_proc routine
        CROSS JOIN LATERAL aclexplode(COALESCE(routine.proacl, acldefault('f', routine.proowner))) privilege
       WHERE routine.oid=to_regprocedure(issue_signature)
         AND privilege.grantee=0 AND privilege.privilege_type='EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'step-up issuer function EXECUTE allowlist diverges from the dedicated issuer role';
  END IF;
  IF to_regprocedure(review_signature) IS NOT NULL AND (
    NOT has_function_privilege(current_setting('nalven.runtime_role'), review_signature, 'EXECUTE')
    OR has_function_privilege(current_setting('nalven.stepup_issuer_role'), review_signature, 'EXECUTE')
    OR has_function_privilege(current_setting('nalven.manual_worker_role'), review_signature, 'EXECUTE')
    OR has_function_privilege(current_setting('nalven.manual_callback_role'), review_signature, 'EXECUTE')
    OR has_function_privilege(current_setting('nalven.manual_homologator_role'), review_signature, 'EXECUTE')
    OR has_function_privilege(current_setting('nalven.manual_vault_binder_role'), review_signature, 'EXECUTE')
    OR has_function_privilege(current_setting('nalven.manual_sweeper_role'), review_signature, 'EXECUTE')
    OR EXISTS (
      SELECT 1
        FROM pg_proc routine
        CROSS JOIN LATERAL aclexplode(COALESCE(routine.proacl, acldefault('f', routine.proowner))) privilege
       WHERE routine.oid=to_regprocedure(review_signature)
         AND privilege.grantee=0 AND privilege.privilege_type='EXECUTE'
    )
  ) THEN
    RAISE EXCEPTION 'manual review function EXECUTE allowlist diverges from the runtime role';
  END IF;
END
$$;

DO $$
DECLARE
  protected_relation RECORD;
  operational_role NAME;
  operational_roles NAME[] := ARRAY[
    current_setting('nalven.runtime_role')::NAME,
    current_setting('nalven.manual_worker_role')::NAME,
    current_setting('nalven.manual_callback_role')::NAME,
    current_setting('nalven.stepup_issuer_role')::NAME,
    current_setting('nalven.manual_homologator_role')::NAME,
    current_setting('nalven.manual_vault_binder_role')::NAME,
    current_setting('nalven.manual_profile_admin_issuer_role')::NAME,
    current_setting('nalven.manual_profile_accounting_issuer_role')::NAME,
    current_setting('nalven.manual_profile_fiscal_issuer_role')::NAME,
    current_setting('nalven.manual_sweeper_role')::NAME
  ];
BEGIN
  FOR protected_relation IN
    SELECT relation.oid::REGCLASS AS identity
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     WHERE namespace.nspname = 'public'
       AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
       AND left(relation.relname,length('pos_manual_'))='pos_manual_'
       AND relation.relname <> 'pos_manual_payment_references'
  LOOP
    FOREACH operational_role IN ARRAY operational_roles
    LOOP
      IF has_any_column_privilege(operational_role, protected_relation.identity, 'SELECT,INSERT,UPDATE,REFERENCES')
         OR has_table_privilege(operational_role, protected_relation.identity, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') THEN
        RAISE EXCEPTION 'operational role % retained direct privilege on %',
          operational_role, protected_relation.identity;
      END IF;
    END LOOP;
  END LOOP;
END
$$;

-- `_ms` remains table/sequence-less in every version and may execute only
-- sweep after the complete T2-02 marker. This also catches grants on unrelated
-- public functions that are outside the POS naming quarantine.
DO $$
DECLARE
  sweeper_role NAME := current_setting('nalven.manual_sweeper_role')::NAME;
  sweep_signature TEXT := 'public.pos_manual_sweep_expired_applications_v1(text,integer,text,text)';
BEGIN
  IF has_database_privilege(sweeper_role,current_database(),'CREATE,TEMPORARY')
    OR has_schema_privilege(sweeper_role,'public','CREATE')
    OR EXISTS (
      SELECT 1 FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
       WHERE namespace.nspname='public' AND relation.relkind IN ('r','p','v','m','S','f')
         AND CASE WHEN relation.relkind='S'
           THEN has_sequence_privilege(sweeper_role,relation.oid,'USAGE,SELECT,UPDATE')
           ELSE has_any_column_privilege(sweeper_role,relation.oid,'SELECT,INSERT,UPDATE,REFERENCES')
             OR has_table_privilege(sweeper_role,relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         END
    ) OR EXISTS (
      SELECT 1 FROM pg_proc routine JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
       WHERE namespace.nspname='public' AND has_function_privilege(sweeper_role,routine.oid,'EXECUTE')
         AND (to_regprocedure(sweep_signature) IS NULL OR routine.oid<>to_regprocedure(sweep_signature))
    ) THEN
    RAISE EXCEPTION 'T2-02 manual sweeper escaped its zero-DML/single-capability allowlist';
  END IF;
  IF to_regprocedure(sweep_signature) IS NULL
    AND EXISTS (SELECT 1 FROM pg_proc routine JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
      WHERE namespace.nspname='public' AND has_function_privilege(sweeper_role,routine.oid,'EXECUTE')) THEN
    RAISE EXCEPTION 'pre-T2-02 manual sweeper retained function EXECUTE';
  END IF;
END
$$;

-- T2-01 issuers remain table/sequence-less and may execute only their single
-- assertion constructor.  All helpers and cross-domain issuers stay denied.
DO $$
DECLARE
  issuer_role NAME;
  allowed_signature TEXT;
BEGIN
  FOR issuer_role,allowed_signature IN SELECT * FROM (VALUES
    (current_setting('nalven.manual_profile_admin_issuer_role')::NAME,'public.pos_manual_issue_profile_admin_assertion_v1(text,integer,uuid,integer,text,text,text,text,text)'),
    (current_setting('nalven.manual_profile_accounting_issuer_role')::NAME,'public.pos_manual_issue_profile_accounting_assertion_v1(uuid,integer,text,text,text,text,text,text)'),
    (current_setting('nalven.manual_profile_fiscal_issuer_role')::NAME,'public.pos_manual_issue_profile_fiscal_assertion_v1(uuid,integer,text,text,text,text,text,text)')
  ) expected(role_name,signature) LOOP
    IF has_database_privilege(issuer_role,current_database(),'CREATE,TEMPORARY')
      OR has_schema_privilege(issuer_role,'public','CREATE')
      OR EXISTS (
        SELECT 1 FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
         WHERE namespace.nspname='public' AND relation.relkind IN ('r','p','v','m','S','f')
           AND CASE WHEN relation.relkind='S'
             THEN has_sequence_privilege(issuer_role,relation.oid,'USAGE,SELECT,UPDATE')
             ELSE has_any_column_privilege(issuer_role,relation.oid,'SELECT,INSERT,UPDATE,REFERENCES')
               OR has_table_privilege(issuer_role,relation.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
           END
      ) OR EXISTS (
        SELECT 1 FROM pg_proc routine JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
         WHERE namespace.nspname='public' AND has_function_privilege(issuer_role,routine.oid,'EXECUTE')
           AND (to_regprocedure(allowed_signature) IS NULL OR routine.oid<>to_regprocedure(allowed_signature))
      ) THEN
      RAISE EXCEPTION 'T2-01 profile assertion issuer escaped allowlist: %',issuer_role;
    END IF;
  END LOOP;
END
$$;

DO $$
DECLARE
  migrator_oid OID := (SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.migrator_role'));
  allowed_oids OID[] := ARRAY[
    (SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.migrator_role')),
    (SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.runtime_role')),
    (SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.manual_worker_role')),
    (SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.manual_callback_role')),
    (SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.stepup_issuer_role')),
    (SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.manual_homologator_role')),
    (SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.manual_vault_binder_role')),
    (SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.manual_profile_admin_issuer_role')),
    (SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.manual_profile_accounting_issuer_role')),
    (SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.manual_profile_fiscal_issuer_role')),
    (SELECT oid FROM pg_roles WHERE rolname=current_setting('nalven.manual_sweeper_role'))
  ];
BEGIN
  IF (SELECT nspowner FROM pg_namespace WHERE nspname='public') IS DISTINCT FROM migrator_oid THEN
    RAISE EXCEPTION 'public schema owner is not the migrator';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_database database
      CROSS JOIN LATERAL aclexplode(COALESCE(database.datacl, acldefault('d', database.datdba))) privilege
     WHERE database.datname=current_database()
       AND (
         privilege.grantee=0
         OR NOT (privilege.grantee = ANY(allowed_oids))
         OR (privilege.grantee<>migrator_oid AND privilege.privilege_type<>'CONNECT')
       )
  ) THEN
    RAISE EXCEPTION 'database retains CONNECT/CREATE/TEMPORARY ACL for PUBLIC, a non-allowlisted principal, or an operational role';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_namespace namespace
      CROSS JOIN LATERAL aclexplode(COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))) privilege
     WHERE namespace.nspname='public'
       AND (
         privilege.grantee=0
         OR NOT (privilege.grantee = ANY(allowed_oids))
         OR (privilege.grantee<>migrator_oid AND privilege.privilege_type<>'USAGE')
       )
  ) THEN
    RAISE EXCEPTION 'public schema retains CREATE/USAGE ACL for PUBLIC, a non-allowlisted principal, or an operational role';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class relation JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
     WHERE namespace.nspname='public' AND relation.relkind IN ('r','p','v','m','S','f')
       AND relation.relowner IS DISTINCT FROM migrator_oid
  ) OR EXISTS (
    SELECT 1 FROM pg_proc routine JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
     WHERE namespace.nspname='public' AND routine.proowner IS DISTINCT FROM migrator_oid
  ) THEN
    RAISE EXCEPTION 'public object owner is not the migrator';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_class relation
      JOIN pg_namespace namespace ON namespace.oid=relation.relnamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(relation.relacl, acldefault(CASE WHEN relation.relkind='S' THEN 'S'::"char" ELSE 'r'::"char" END, relation.relowner))) privilege
     WHERE namespace.nspname='public' AND relation.relkind IN ('r','p','v','m','S','f')
       AND NOT (privilege.grantee = ANY(allowed_oids))
  ) OR EXISTS (
    SELECT 1
      FROM pg_proc routine
      JOIN pg_namespace namespace ON namespace.oid=routine.pronamespace
      CROSS JOIN LATERAL aclexplode(COALESCE(routine.proacl, acldefault('f', routine.proowner))) privilege
     WHERE namespace.nspname='public' AND NOT (privilege.grantee = ANY(allowed_oids))
  ) THEN
    RAISE EXCEPTION 'public objects retain ACLs for a non-allowlisted principal';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM pg_default_acl defaults
      CROSS JOIN LATERAL aclexplode(defaults.defaclacl) privilege
     WHERE defaults.defaclrole=migrator_oid
       AND (defaults.defaclnamespace=0 OR defaults.defaclnamespace=(SELECT oid FROM pg_namespace WHERE nspname='public'))
       AND privilege.grantee IS DISTINCT FROM migrator_oid
  ) THEN
    RAISE EXCEPTION 'migrator default ACL grants authority to a non-owner principal';
  END IF;
END
$$;

COMMIT;
