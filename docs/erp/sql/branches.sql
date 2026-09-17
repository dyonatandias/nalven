-- Empresas e filiais — espelho documental da migration 20260827050000_branches.
-- Não aplicar manualmente; Prisma Migrate é a fonte executável.

CREATE TABLE branches (
  id serial PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL,
  legal_name text NOT NULL, document text NOT NULL UNIQUE,
  type text NOT NULL DEFAULT 'branch', status text NOT NULL DEFAULT 'active',
  state_registration text, municipal_registration text, email text, phone text,
  zip text, street text, number text, complement text, district text, city text, state text,
  timezone text NOT NULL DEFAULT 'America/Sao_Paulo', primary boolean NOT NULL DEFAULT false,
  default_warehouse_id integer UNIQUE, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX branches_single_primary_idx ON branches(primary) WHERE primary = true;
CREATE INDEX branches_status_name_idx ON branches(status, name);

ALTER TABLE warehouses ADD COLUMN branch_id integer REFERENCES branches(id) ON DELETE SET NULL;
CREATE INDEX warehouses_branch_id_idx ON warehouses(branch_id);
ALTER TABLE branches ADD CONSTRAINT branches_default_warehouse_id_fkey
  FOREIGN KEY (default_warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL;

CREATE TABLE branch_settings (
  id serial PRIMARY KEY, branch_id integer NOT NULL UNIQUE REFERENCES branches(id) ON DELETE CASCADE,
  tax_regime text NOT NULL DEFAULT 'simples_nacional',
  fiscal_environment text NOT NULL DEFAULT 'homologation',
  nfe_series integer NOT NULL DEFAULT 1, nfce_series integer NOT NULL DEFAULT 1,
  nfse_series integer NOT NULL DEFAULT 1, next_nfe_number integer NOT NULL DEFAULT 1,
  next_nfce_number integer NOT NULL DEFAULT 1, next_nfse_number integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE tenant_user_profiles ADD COLUMN active_branch_id integer REFERENCES branches(id) ON DELETE SET NULL;
CREATE INDEX tenant_user_profiles_active_branch_id_idx ON tenant_user_profiles(active_branch_id);
