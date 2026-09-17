import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { controlDb } from "@/db/control";
import { unexpectedErrorResponse } from "@/lib/http-security";
export async function GET(request:Request,{params}:{params:Promise<{id:string}>}){
 try{
  const {id}=await params;
  if(!/^[A-Za-z0-9_-]{10,100}$/.test(id))return missing();
  const url=`/api/public/media/${id}`;
  const [asset,seo,posts]=await Promise.all([controlDb.mediaAsset.findUnique({where:{id}}),controlDb.seoEntry.findMany({where:{imageUrl:url},select:{path:true}}),controlDb.blogPost.count({where:{coverUrl:url,status:"published"}})]);
  const publishedSeo=await Promise.all(seo.map(async row=>row.path==='/'||row.path==='/blog'||row.path==='/glossario'||row.path.startsWith('/blog/')&&await controlDb.blogPost.count({where:{slug:row.path.slice(6),status:'published'}})>0||row.path.startsWith('/glossario/')&&await controlDb.glossaryTerm.count({where:{slug:row.path.slice(11),status:'published'}})>0));
  if(!asset||!posts&&!publishedSeo.some(Boolean)||!['image/png','image/jpeg','image/webp','image/avif'].includes(asset.mimeType))return missing();
  if(!Number.isSafeInteger(asset.sizeBytes)||asset.sizeBytes<1||asset.sizeBytes>8*1024*1024)return missing();
  const root=await realpath('/var/lib/nalven/uploads');const path=await realpath(resolve(asset.path));const child=relative(root,path);
  if(!child||child.startsWith('..')||isAbsolute(child))return missing();
  const metadata=await stat(path);if(!metadata.isFile()||metadata.size!==asset.sizeBytes)return missing();
  const body=await readFile(path);if(body.length!==asset.sizeBytes)return missing();
  const etag=`"${createHash('sha256').update(body).digest('hex')}"`;
  const responseHeaders={'content-type':asset.mimeType,'cache-control':'public, max-age=0, must-revalidate','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; sandbox",'etag':etag};
  if(request.headers.get('if-none-match')?.split(',').some(value=>value.trim()==='*'||value.trim().replace(/^W\//,'')===etag))return new Response(null,{status:304,headers:responseHeaders});
  return new Response(body,{headers:{...responseHeaders,'content-length':String(body.length)}});
 }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return missing();return unexpectedErrorResponse('public.media',error)}
}
function missing(){return new Response('Not found',{status:404,headers:{'cache-control':'no-store','content-type':'text/plain; charset=utf-8','x-content-type-options':'nosniff'}})}
