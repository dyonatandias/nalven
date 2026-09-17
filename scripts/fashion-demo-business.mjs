import pg from 'pg';
import fs from 'node:fs/promises';
if(process.env.NALVEN_CONFIGURE_FASHION_DEMO !== '1') throw Error('Explicit demo conversion required');
const db=new pg.Client({connectionString:process.env.TENANT_DATABASE_URL});
await db.connect();
const pairs=JSON.parse(await fs.readFile('/root/nalven-fashion-demo/replacements.json','utf8'));
pairs.push(['Cliente Sintético E2E Atualizado','Beatriz Almeida'],['Depósito E2E','Estoque de trocas'],['Peças automotivas','Vestuário'],['peças automotivas','vestuário'],['autopeças','vestuário'],['automotivo','de moda'],['automotiva','de moda'],['Oficina','Boutique'],['oficina','loja'],['Viscosidade','Composição'],['viscosidade','composição'],['Filtros','Camisas'],['Lubrificantes','Camisetas'],['Freios','Calças'],['E2E validado','Demonstração'],['E2E','Demo']);
const map=new Map(pairs.filter(([a,b])=>a!==b));const regex=new RegExp([...map.keys()].sort((a,b)=>b.length-a.length).map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|'),'g');
const replace=s=>s.replace(regex,m=>map.get(m));
const allow=['branches','warehouses','product_brands','product_tags','product_reviews','product_cost_items','supplier_products','customer_contacts','customer_interactions','customer_tags','supplier_contacts','supplier_interactions','supplier_tags','crm_opportunities','crm_activities','crm_stage_history','sales_orders','sales_order_items','sales_order_history','sales','sale_items','purchase_orders','purchase_order_items','purchase_quotations','purchase_quotation_items','purchase_quotation_offers','purchase_quotation_offer_items','purchase_invoices','purchase_invoice_items','goods_receipts','goods_receipt_items','financial_titles','financial_accounts','cost_centers','budgets','budget_lines','business_goals','business_goal_updates','report_global_costs','saved_report_views','shipments','shipment_events','shipment_incidents','shipping_carriers','order_notes','order_item_meta','order_meta','order_documents','order_addresses','product_slug_redirects','category_slug_redirects','category_attribute_templates','tenant_settings'];
// Only presentation text is rewritten; no amounts, identifiers, credentials, fiscal payloads or immutable audit/ledger records.
const columns=(await db.query("SELECT c.table_name,c.column_name FROM information_schema.columns c WHERE table_schema='public' AND data_type IN ('text','character varying') AND table_name=ANY($1) AND column_name ~ '(^name$|^trade_name$|^legal_name$|^title$|^description$|^notes$|^note$|^label$|^product_name$|^customer_name$|^supplier_name$|^category$|^supplier$|^customer$|^subject$|^body$|^short_description$|^receipt_footer$|^quote_footer$)'",[allow])).rows;
await db.query('BEGIN');
let changes=0;const skipped=[];
try{
 for(const {table_name:table,column_name:column} of columns){
  const rows=(await db.query(`SELECT ctid::text AS row_key,"${column}" AS value FROM "${table}" WHERE "${column}" IS NOT NULL`)).rows;
  for(const row of rows){const value=replace(row.value);if(value===row.value)continue;
   await db.query('SAVEPOINT text_change');
   try {await db.query(`UPDATE "${table}" SET "${column}"=$1 WHERE ctid=$2::tid`,[value,row.row_key]);changes++;}
   catch(e){await db.query('ROLLBACK TO SAVEPOINT text_change');if(!skipped.includes(table))skipped.push(table);if(!['42501','23514','P0001','55000'].includes(e.code))throw e;}
   await db.query('RELEASE SAVEPOINT text_change');
  }
 }
 await db.query("UPDATE marketplace_channels SET status='inactive'");
 await db.query("UPDATE integration_credentials SET enabled=false, revoked_at=NOW() WHERE provider_id='marketplace' AND revoked_at IS NULL");
 await db.query('DELETE FROM product_marketplace_profiles');
 await db.query('DELETE FROM category_marketplace_mappings');
 await db.query("UPDATE customers SET origin='store' WHERE origin='marketplace'");
 await db.query("UPDATE products SET supplier=s.name FROM supplier_products sp JOIN suppliers s ON s.id=sp.supplier_id WHERE products.id=sp.product_id");
 await db.query("UPDATE product_brands SET name=CASE WHEN id=1 THEN 'Vitrine Essentials' ELSE 'Vitrine Collection' END,slug=CASE WHEN id=1 THEN 'vitrine-essentials' ELSE 'vitrine-collection' END");
 await db.query("UPDATE media_assets SET deleted_at=NOW() WHERE id NOT LIKE 'fashion-demo-%' AND deleted_at IS NULL AND kind='image'");
 await db.query('UPDATE product_brands SET logo_media_id=NULL');
 await db.query("DELETE FROM category_attribute_templates");
 await db.query("INSERT INTO category_attribute_templates(category_id,name,type,options,sort_order,updated_at) SELECT id,'Tamanho','select',ARRAY['P','M','G','GG'],0,NOW() FROM categories");
 await db.query("INSERT INTO category_attribute_templates(category_id,name,type,options,sort_order,updated_at) SELECT id,'Cor','select',ARRAY['Preto','Off-white','Azul','Terracota','Verde','Rosa'],1,NOW() FROM categories");
 await db.query('UPDATE branches SET notes=$1', ['Unidade demonstrativa da Vitrine Moda.']);
 await db.query("INSERT INTO audit_events (actor_id,action,entity_type,entity_id,after_data) VALUES ('demo-configuration','demo.fashion_configured','organization','org-demo',$1)",[JSON.stringify({textChanges:changes,immutableTablesPreserved:skipped,backup:'/root/nalven-fashion-demo',reason:'User-authorized clothing retail demonstration'})]);
 await db.query('COMMIT');console.log(JSON.stringify({textChanges:changes,immutableTablesPreserved:skipped}));
}catch(e){await db.query('ROLLBACK');throw e;}finally{await db.end();}
