-- Only for the backed-up nalven_t_demo tenant, after configure-fashion-demo.ts.
BEGIN;
DO $$ BEGIN IF current_database()<>'nalven_t_demo' THEN RAISE EXCEPTION 'Demo database required'; END IF; END $$;
UPDATE products SET custom_fields=jsonb_build_array(jsonb_build_object('label','Coleção','value','Primavera 2026'),jsonb_build_object('label','Uso','value','Varejo de moda')),seo_secondary_keywords=ARRAY['moda','vestuário','loja de roupas'],configurator_data=NULL,carousel_config=NULL,weight=0.3,net_weight=0.3,gross_weight=0.35,length=30,width=25,height=4,weight_unit='kg',dimension_unit='cm',warranty_months=NULL,anatel_code=NULL,anvisa_code=NULL,inmetro_code=NULL,mapa_code=NULL;
UPDATE crm_opportunities o SET title='Coleção primavera · '||c.name,company=CASE WHEN c.type='PJ' THEN c.name ELSE NULL END,contact_name=c.name FROM customers c WHERE o.customer_id=c.id;
UPDATE crm_opportunities SET title=CASE id WHEN 1 THEN 'Renovação de coleção de camisetas' WHEN 2 THEN 'Compra de jeans para a primavera' WHEN 3 THEN 'Pedido de uniformes corporativos' WHEN 4 THEN 'Seleção de looks para evento' WHEN 5 THEN 'Reposição de básicos' ELSE 'Coleção primavera · oportunidade '||id END WHERE customer_id IS NULL;
UPDATE financial_titles SET description=replace(description,'via marketplace','via integrador externo') WHERE description LIKE '%via marketplace%';
INSERT INTO audit_events(actor_id,action,entity_type,entity_id,after_data) VALUES ('demo-configuration','demo.fashion_content_finalized','organization','org-demo','{"scope":"clothing retail demo","external_connection":"pending actual integrator endpoint","fiscal_classification":"requires validation before real invoices"}');
COMMIT;
