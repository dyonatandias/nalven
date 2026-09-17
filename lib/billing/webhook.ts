import {createHmac,timingSafeEqual} from 'node:crypto';
export function verifyBillingWebhook(raw:Buffer,received:string,secret:string){if(!secret||!received.startsWith('sha256='))return false;const expected=Buffer.from(`sha256=${createHmac('sha256',secret).update(raw).digest('hex')}`);const actual=Buffer.from(received);return expected.length===actual.length&&timingSafeEqual(expected,actual)}
