-- Synthetic settings only. Applied exclusively to the disposable build cluster.
INSERT INTO system_settings(key,value,updated_at)
VALUES ('saas','{"name":"NALVEN homologação","domain":"localhost","trialDays":7}'::jsonb,now()) ON CONFLICT(key) DO NOTHING;
INSERT INTO seo_entries(path,title,description,robots,updated_at)
VALUES ('/','NALVEN — homologação','Ambiente isolado de validação','noindex,nofollow',now()),
       ('/blog','Blog — homologação','Conteúdo sintético de validação','noindex,nofollow',now()),
       ('/glossario','Glossário — homologação','Conteúdo sintético de validação','noindex,nofollow',now()) ON CONFLICT(path) DO NOTHING;
