import test from "node:test";
import assert from "node:assert/strict";
import { assertNoRedirectCycle, localPath, loginAlias, reservedPath, safeObservedPath } from "../lib/site/paths";
test("alternativas de login convergem e APIs permanecem APIs",()=>{for(const path of ["/entrar","/ADMIN/Login/","/auth/login","/signin-with-chatgpt"])assert.equal(loginAlias(path),true);assert.equal(loginAlias('/api/auth/login'),false)});
test("redirecionamentos rejeitam destinos ambíguos e externos",()=>{for(const path of ['https://evil.test','//evil.test','/\\evil.test','/%2f%2fevil.test','/a/../login','/a?token=abc','/a#b'])assert.throws(()=>localPath(path));assert.equal(localPath('/artigo-antigo/'),'/artigo-antigo')});
test("rotas privadas e arquivos são reservados",()=>{for(const path of ['/api/auth/login','/admin','/erp/vendas','/redefinir-senha/token','/robots.txt'])assert.equal(reservedPath(path),true);assert.equal(reservedPath('/blog/artigo'),false)});
test("ciclos diretos, indiretos e concorrentes são detectáveis",()=>{assert.throws(()=>assertNoRedirectCycle('/a','/a',[]));assert.throws(()=>assertNoRedirectCycle('/a','/b',[{source:'/b',destination:'/a'}]));assert.doesNotThrow(()=>assertNoRedirectCycle('/a','/c',[{source:'/b',destination:'/a'}]))});
test("monitoramento não persiste parâmetros e tokens",()=>{assert.equal(safeObservedPath('/convite/segredo?email=user@example.com'),'/convite/[token]');assert.equal(safeObservedPath('/blog/um-artigo?utm_source=x'),'/blog/um-artigo');assert.equal(safeObservedPath('/redefinir-senha/abc'),'/redefinir-senha/[token]')});

test("/login continua sendo o destino canônico, sem loop",()=>assert.equal(loginAlias('/login'),false));
