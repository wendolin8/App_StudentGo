import assert from 'node:assert/strict';
import {createECDH, randomBytes} from 'node:crypto';
import * as webpush from 'npm:web-push@4.0.0';
import {sendPush} from './send.ts';
Deno.test('sender encrypts a payload and supplies VAPID without allowing redirects', async()=>{
 const keys=webpush.generateVAPIDKeys(); const receiver=createECDH('prime256v1'); receiver.generateKeys();
 const previous=globalThis.fetch;
 let called=false;
 globalThis.fetch=async(input,init)=>{
  called=true;assert.equal(input,'https://fcm.googleapis.com/fcm/send/test');
  assert.equal(init?.redirect,'error');assert.equal(init?.method,'POST');
  const headers=new Headers(init?.headers);assert.equal(headers.get('content-encoding'),'aes128gcm');assert.match(headers.get('authorization')!,/^vapid /);
  assert.ok(init?.body instanceof Uint8Array);assert.ok(init.body.length>40);
  assert.ok(!new TextDecoder().decode(init.body).includes('private-test-tag'));
  return new Response(null,{status:201});
 };
 try {assert.equal(await sendPush({endpoint:'https://fcm.googleapis.com/fcm/send/test',keys:{p256dh:receiver.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}},{kind:'test',tag:'private-test-tag'},{...keys,subject:'https://app-student-go.vercel.app'}),201);assert.ok(called);}
 finally {globalThis.fetch=previous;}
});
