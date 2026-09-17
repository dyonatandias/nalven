INSERT INTO "order_status_definitions" ("key","label","color","icon","description","position","native","updated_at")
VALUES ('approved','Aprovado','#2563eb','check','Orçamento aprovado e pronto para execução',15,true,CURRENT_TIMESTAMP)
ON CONFLICT ("key") DO UPDATE SET "label"=EXCLUDED."label", "color"=EXCLUDED."color", "description"=EXCLUDED."description", "native"=true, "updated_at"=CURRENT_TIMESTAMP;
