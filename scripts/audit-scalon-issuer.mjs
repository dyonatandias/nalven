import fs from 'node:fs';
import crypto from 'node:crypto';
import { parseEnv } from 'node:util';
import { createRequire } from 'node:module';
const app = parseEnv(fs.readFileSync('/etc/nalven/app.env','utf8'));
const tenant = parseEnv(fs.readFileSync('/etc/nalven/tenants/scalon-modas.env','utf8'));
const { Client } = await import(createRequire(import.meta.url).resolve('pg', { paths: ['/var/lib/nalven-production-build.h8HCcW'] }));
const key = crypto.createHash('sha256').update(app.NALVEN_SECRETS_MASTER_KEY).digest();
function decrypt(value) { const [,iv,tag,data]=value.split('.'); const d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url'));d.setAuthTag(Buffer.from(tag,'base64url'));return Buffer.concat([d.update(Buffer.from(data,'base64url')),d.final()]).toString('utf8'); }
(async()=>{ const db = new Client({connectionString:tenant.TENANT_DATABASE_URL}); await db.connect();
try {
  await db.query('BEGIN');
  const identity=await db.query("SELECT document FROM branches WHERE id=1");
  if(identity.rows[0]?.document.replace(/\D/g,'')!=='62119228000152') throw Error('Wrong tenant');
  const result = await db.query("SELECT id,document_type,issuer_document,encrypted_xml FROM inbound_fiscal_documents WHERE document_type IN ('nfse','cte') AND environment='production' ORDER BY id FOR UPDATE");
  const text=(xml,tag)=> (xml.match(new RegExp('<(?:\\w+:)?'+tag+'\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?'+tag+'>','i'))?.[1]||'').trim();
  const value=(xml,tag)=>text(xml,tag).replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
  let updated=0,created=0;
  for(const row of result.rows) {
    const xml=decrypt(row.encrypted_xml),emit=text(xml,'emit'),doc=value(emit,'CNPJ'),name=value(emit,'xNome');
    if(!/^\d{14}$/.test(doc)||!name||doc!==row.issuer_document) throw Error('Issuer mismatch');
    await db.query("UPDATE inbound_fiscal_documents SET issuer_name=$1 WHERE id=$2 AND issuer_name IS DISTINCT FROM $1",[name,row.id]); updated++;
    if(doc==='62119228000152') continue;
    const address=text(emit,'enderEmit')||text(emit,'enderNac');
    const inserted=await db.query("INSERT INTO suppliers(name,trade_name,document,email,phone,state_registration,municipal_registration,category,origin) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'invoice') ON CONFLICT(document) DO NOTHING RETURNING id",[name,value(emit,'xFant')||null,doc,value(emit,'email')||null,value(emit,'fone')||null,value(emit,'IE')||null,value(emit,'IM')||null,row.document_type==='cte'?'logistics':'services']);
    if(inserted.rowCount) {
      created++;
      const id=inserted.rows[0].id;
      if(address) await db.query('INSERT INTO supplier_addresses(supplier_id,label,street,number,complement,district,city,state,zip,"primary") VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,true)',[id,'Fiscal (XML)',value(address,'xLgr')||null,value(address,'nro')||null,value(address,'xCpl')||null,value(address,'xBairro')||null,value(address,'xMun')||null,value(address,'UF')||null,value(address,'CEP')||null]);
      await db.query("INSERT INTO audit_events(actor_id,action,entity_type,entity_id,after_data) VALUES('maintenance:fiscal-issuer-audit','supplier.created_from_xml','supplier',$1,$2::jsonb)",[String(id),JSON.stringify({documentId:row.id,document:doc,source:'encrypted_xml',homologationStatus:'pending'})]);
    }
  }
  await db.query("INSERT INTO audit_events(actor_id,action,entity_type,entity_id,after_data) VALUES('maintenance:fiscal-issuer-audit','dfe.issuer.audit','branch','1',$1::jsonb)",[JSON.stringify({checked:updated,suppliersCreated:created})]);
  await db.query('COMMIT');
  console.log({checked:updated,suppliersCreated:created});
} finally {await db.end();} })().catch(e=>{console.error(e.name);process.exitCode=1;});
