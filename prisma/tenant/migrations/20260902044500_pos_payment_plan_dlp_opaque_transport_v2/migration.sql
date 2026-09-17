-- Apply every canonical-text detector to the same sanitized transport. Only
-- opaque UUID and cryptographic digest formats are removed; business text,
-- document numbers and payment evidence continue to be inspected fail-closed.
CREATE OR REPLACE FUNCTION public."pos_manual_t2_canonical_text_dlp_safe_v1"(p_canonical text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
 WITH sanitized AS (
   SELECT pg_catalog.regexp_replace(
     pg_catalog.regexp_replace(
       p_canonical,
       '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}',
       '[opaque-uuid]',
       'g'
     ),
     '[0-9A-Fa-f]{32,160}',
     '[opaque-digest]',
     'g'
   ) AS value
 )
 SELECT NOT (
   public."pos_manual_identifier_contains_pan_321f"(value)
   OR value ~* '(cvv|cvc|pin|track[12]|vault[_ -]?token|open[_ -]?reference|authorization[_ -]?code|(^|[^a-z])nsu([^a-z]|$)|end[_ -]?to[_ -]?end|e2e)'
   OR value ~* '(^|[^A-Za-z0-9_])(customer[_ -]?(name|email|phone|address)|name|nome|e-?mail|telefone|phone|street|avenue|address|logradouro|postal[_ -]?code|cep|cpf|cnpj)([^A-Za-z0-9_]|$)'
   OR value ~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}'
   OR value ~ '(^|[^0-9])([0-9]{3}[.]?[0-9]{3}[.]?[0-9]{3}-?[0-9]{2}|[0-9]{2}[.]?[0-9]{3}[.]?[0-9]{3}[/]?[0-9]{4}-?[0-9]{2})([^0-9]|$)'
   OR value ~* '(\+55[[:space:]]?)?[(][0-9]{2}[)][[:space:]]?[0-9]{4,5}-[0-9]{4}'
   OR value ~ '"[0-9]{5}-[0-9]{3}"'
   OR value ~* '"(rua|avenida|av[.]|travessa|street|avenue)[[:space:]][^"[:cntrl:]]{2,160}"'
 ) FROM sanitized
$function$;

REVOKE ALL ON FUNCTION public."pos_manual_t2_canonical_text_dlp_safe_v1"(text) FROM PUBLIC;
