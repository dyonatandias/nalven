-- Orçamentos e pedidos — espelho documental da migration 20260827070000_sales_orders.
-- Não aplicar manualmente; Prisma Migrate é a fonte executável.

CREATE TABLE sales_orders (
  id serial PRIMARY KEY, number text NOT NULL UNIQUE, kind text NOT NULL DEFAULT 'quote',
  status text NOT NULL DEFAULT 'draft', customer_id integer REFERENCES customers(id) ON DELETE SET NULL,
  customer_name text NOT NULL, valid_until date, expected_at date,
  subtotal double precision NOT NULL DEFAULT 0, discount double precision NOT NULL DEFAULT 0,
  total double precision NOT NULL DEFAULT 0, notes text, created_by text NOT NULL,
  approved_at timestamptz, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sales_orders_status_created_at_idx ON sales_orders(status, created_at);
CREATE INDEX sales_orders_customer_id_created_at_idx ON sales_orders(customer_id, created_at);

CREATE TABLE sales_order_items (
  id serial PRIMARY KEY, sales_order_id integer NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  product_id integer NOT NULL REFERENCES products(id), quantity double precision NOT NULL,
  unit_price double precision NOT NULL, total double precision NOT NULL,
  UNIQUE(sales_order_id, product_id)
);
CREATE TABLE sales_order_history (
  id serial PRIMARY KEY, sales_order_id integer NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  from_status text, to_status text NOT NULL, actor text NOT NULL, notes text,
  created_at timestamptz NOT NULL DEFAULT now()
);
