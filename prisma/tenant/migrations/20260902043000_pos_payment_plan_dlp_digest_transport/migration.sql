-- Cryptographic digests and UUID locators are opaque identifiers, not payment
-- card data. The previous canonical-text scan fed their decimal subsequences to
-- the Luhn detector and could reject a valid payment-plan quote nondeterministically.
-- Sensitive names, documents, e-mails, phones and addresses remain fail-closed.
CREATE OR REPLACE FUNCTION public."pos_manual_t2_canonical_text_dlp_safe_v1"(p_canonical text)
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SECURITY DEFINER SET search_path=pg_catalog AS $function$
 SELECT NOT (
   public."pos_manual_identifier_contains_pan_321f"(
     pg_catalog.regexp_replace(
       pg_catalog.regexp_replace(
         p_canonical,
         '[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}',
         '[opaque-uuid]',
         'g'
       ),
       '[0-9A-Fa-f]{32,160}',
       '[opaque-digest]',
       'g'
     )
   )
   OR p_canonical ~* '(cvv|cvc|pin|track[12]|vault[_ -]?token|open[_ -]?reference|authorization[_ -]?code|(^|[^a-z])nsu([^a-z]|$)|end[_ -]?to[_ -]?end|e2e)'
   OR p_canonical ~* '(^|[^A-Za-z0-9_])(customer[_ -]?(name|email|phone|address)|name|nome|e-?mail|telefone|phone|street|avenue|address|logradouro|postal[_ -]?code|cep|cpf|cnpj)([^A-Za-z0-9_]|$)'
   OR p_canonical ~* '[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}'
   OR p_canonical ~ '(^|[^0-9])([0-9]{3}[.]?[0-9]{3}[.]?[0-9]{3}-?[0-9]{2}|[0-9]{2}[.]?[0-9]{3}[.]?[0-9]{3}[/]?[0-9]{4}-?[0-9]{2})([^0-9]|$)'
   OR p_canonical ~* '(\+55[[:space:]]?)?[(][0-9]{2}[)][[:space:]]?[0-9]{4,5}-[0-9]{4}'
   OR p_canonical ~ '"[0-9]{5}-[0-9]{3}"'
   OR p_canonical ~* '"(rua|avenida|av[.]|travessa|street|avenue)[[:space:]][^"[:cntrl:]]{2,160}"'
 )
$function$;

REVOKE ALL ON FUNCTION public."pos_manual_t2_canonical_text_dlp_safe_v1"(text) FROM PUBLIC;
