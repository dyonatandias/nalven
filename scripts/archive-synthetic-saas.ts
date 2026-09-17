import { controlDb } from "../db/control";
async function main(){
 const result=await controlDb.$transaction(async tx=>{
  const invoice=await tx.invoice.findUnique({where:{id:'inv-demo-001'}});
  const ticket=await tx.ticket.findUnique({where:{id:'ticket-demo-001'}});
  const archived:string[]=[];
  if(invoice?.organizationId==='org-demo'&&invoice.description==='Plano Escala — Agosto/2026'&&invoice.amount===549&&invoice.status==='paid'&&invoice.paidAt==='2026-08-08'&&invoice.dueAt==='2026-08-10'){
   await tx.auditLog.create({data:{action:'site.synthetic_record.archive',entityType:'invoice',entityId:invoice.id,metadata:{reason:'Registro financeiro de demonstração criado pelo seed',record:invoice}}});
   await tx.invoice.delete({where:{id:invoice.id}});archived.push(invoice.id);
  }
  if(ticket?.organizationId==='org-demo'&&ticket.subject==='Configuração inicial do ambiente'&&ticket.priority==='normal'&&ticket.status==='open'&&ticket.assignee==='Equipe NALVEN'){
   await tx.auditLog.create({data:{action:'site.synthetic_record.archive',entityType:'ticket',entityId:ticket.id,metadata:{reason:'Chamado de demonstração criado pelo seed',record:{...ticket,createdAt:ticket.createdAt.toISOString(),updatedAt:ticket.updatedAt.toISOString()}}}});
   await tx.ticket.delete({where:{id:ticket.id}});archived.push(ticket.id);
  }
  return archived;
 });console.log(JSON.stringify({archivedSyntheticRecords:result}));
}
main().finally(()=>controlDb.$disconnect());
