-- Preserve unidentified historical imports instead of guessing an environment.
ALTER TABLE inbound_fiscal_documents ADD COLUMN environment TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE inbound_fiscal_documents ADD CONSTRAINT inbound_fiscal_environment_check CHECK (environment IN ('production','homologation','legacy'));
UPDATE inbound_fiscal_documents d SET environment = c.environment
FROM (SELECT branch_id,source,min(environment) AS environment FROM dfe_sync_cursors GROUP BY branch_id,source HAVING count(DISTINCT environment)=1) c
WHERE d.branch_id=c.branch_id AND d.source=c.source;
DROP INDEX inbound_fiscal_documents_source_branch_id_nsu_key;
DROP INDEX inbound_fiscal_documents_source_access_key_key;
CREATE UNIQUE INDEX inbound_fiscal_documents_source_branch_id_nsu_environment_key ON inbound_fiscal_documents(source,branch_id,nsu,environment);
CREATE UNIQUE INDEX inbound_fiscal_documents_source_access_key_environment_key ON inbound_fiscal_documents(source,access_key,environment);
ALTER TABLE dfe_sync_cursors DROP CONSTRAINT dfe_sync_cursor_source_check;
ALTER TABLE dfe_sync_cursors ADD CONSTRAINT dfe_sync_cursor_source_check CHECK (source IN ('sefaz_nfe','nfse_adn','sefaz_cte'));
ALTER TABLE dfe_sync_cursors ADD CONSTRAINT dfe_sync_cursor_cte_review_check CHECK (source <> 'sefaz_cte' OR processing_mode='review');
ALTER TABLE inbound_fiscal_documents DROP CONSTRAINT inbound_fiscal_source_check;
ALTER TABLE inbound_fiscal_documents ADD CONSTRAINT inbound_fiscal_source_check CHECK (source IN ('sefaz_nfe','nfse_adn','sefaz_cte','manual_xml','provider'));
