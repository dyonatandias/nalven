\set ON_ERROR_STOP on
DO $$
DECLARE role_name text;
BEGIN
  IF current_database() <> 'fiscal_import_test' THEN RAISE EXCEPTION 'isolated test database required'; END IF;
  FOREACH role_name IN ARRAY ARRAY['fiscal_test_migrator','fiscal_test_runtime','fiscal_test_mw','fiscal_test_mc','fiscal_test_si','fiscal_test_mh','fiscal_test_mb','fiscal_test_mpi','fiscal_test_mpa','fiscal_test_mpf','fiscal_test_ms'] LOOP
    EXECUTE format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION',role_name);
  END LOOP;
END $$;
ALTER DATABASE fiscal_import_test OWNER TO fiscal_test_migrator;
ALTER SCHEMA public OWNER TO fiscal_test_migrator;
ALTER ROLE fiscal_test_ms IN DATABASE fiscal_import_test SET default_transaction_isolation='serializable';
