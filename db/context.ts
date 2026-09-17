import {headers} from 'next/headers';
import {currentUser,currentMembership,AuthError} from '@/lib/auth';
import {controlDb} from './control';

const platformHosts=new Set(['nalven.com.br','www.nalven.com.br','127.0.0.1','localhost']);

export async function currentOrganization(){
  const user=await currentUser();
  if(!user)throw new AuthError(401);
  const membership=await currentMembership(user);
  if(!membership)throw new AuthError(403);
  const hostname=((await headers()).get('host')??'').split(':')[0].toLowerCase();
  if(hostname&&!platformHosts.has(hostname)){
    const domain=await controlDb.organizationDomain.findUnique({where:{hostname}});
    if(!domain||domain.organizationId!==membership.organizationId)throw new AuthError(403);
  }
  if(!['active','trial','provisioning'].includes(membership.organization.status))throw new AuthError(403);
  return membership.organization;
}
