-- 138: Registra apenas evidências não secretas devolvidas pelo NALVEN para a
-- homologação do contrato headless 3.0.1. As credenciais continuam nos cofres.

UPDATE produtos_saas
SET metadata=metadata || jsonb_build_object(
      'nalven_contract_version','3.0.1',
      'nalven_release_id','20260826195946',
      'nalven_release_path','/srv/nalven/releases/20260826195946',
      'nalven_proxy_status','implementado_aguardando_credenciais',
      'nalven_handoff_document','nalven/docs/BILLING-HANDOFF-PENDING.md',
      'nalven_vendor_documentation','nalven/vendor/billing-integration',
      'nalven_full_reconciliation','comando_administrativo'
    ),
    updated_at=NOW()
WHERE codigo='nalven';

UPDATE integration_connections
SET metadata=metadata || jsonb_build_object(
      'remote_contract_version','3.0.1',
      'remote_release_id','20260826195946',
      'remote_release_path','/srv/nalven/releases/20260826195946',
      'remote_private_proxies_ready',true,
      'remote_full_reconciliation','comando_administrativo',
      'activation_state','aguardando_transferencia_direta_entre_cofres'
    ),
    updated_at=NOW()
WHERE produto_id=(SELECT id FROM produtos_saas WHERE codigo='nalven')
  AND provider='nalven'
  AND ambiente='producao'
  AND archived_at IS NULL;
