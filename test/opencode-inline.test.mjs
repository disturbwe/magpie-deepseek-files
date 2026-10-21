import test from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { randomBytes } from 'node:crypto';
import { prepareInlineRequest, GO_REQUEST_BUDGET } from '../src/opencode-inline.mjs';
import { onRequest } from '../src/opencode.hooks.mjs';
const tiny=await sharp({create:{width:32,height:32,channels:3,background:'#25bc63'}}).png().toBuffer();
const data=raw=>'data:image/png;base64,'+raw.toString('base64');
const image=raw=>({type:'image_url',image_url:{url:data(raw)}});
const body=images=>({model:'deepseek-v4.1-flash',messages:[{role:'user',content:[{type:'text',text:'Read this UI.'},...images]}]});

test('hook targets built-in Go DeepSeek only, preserving client controls and source',async()=>{
 const b=body([image(tiny)]);
 b.model='opencode-go/deepseek-v4.1-flash';b.stream=true;
 b.tools=[{type:'function',function:{name:'test',parameters:{type:'object',properties:{value:{type:'string',pattern:'\\0'}}}}}];
 b.tool_choice='auto';
 const original=structuredClone(b);
 const result=await onRequest(b,{model:b.model,protocol:'chat'});
 assert.deepEqual(result,original);assert.deepEqual(b,original);
 for(const model of ['opencode-go/claude-haiku-5-5','deepseek/deepseek-flash','codex/gpt-6-astra','opencode-go-deepseek/deepseek-v4.1-flash'])
  assert.equal(await onRequest(b,{model,protocol:'chat'}),undefined);
});

test('routing groups and automatic aliases are budgeted before selection',async()=>{
 for(const model of ['group/mixed-vendors','group/outer-nested','group/auto-deepseek-v4-1-flash','auto/deepseek-v4.1-flash']){
  const b={model,stream:true,messages:[{role:'user',content:Array.from({length:130},()=>image(tiny))}]};
  const result=await onRequest(b,{model,protocol:'chat'});
  assert.equal(result.model,model);assert.equal(result.stream,true);
  assert.equal(result.messages[0].content.filter(p=>p.type==='image_url').length,128);
  assert.match(result.messages[0].content[0].text,/original retained/);
  assert.equal(b.messages[0].content.filter(p=>p.type==='image_url').length,130);
 }
});

test('hook handles native Responses tool images without changing call pairing',async()=>{
 const b={model:'opencode-go/deepseek-v4.1-flash',input:[{type:'function_call',call_id:'test',name:'screenshot',arguments:'{}'},{type:'function_call_output',call_id:'test',output:Array.from({length:130},()=>({type:'input_image',image_url:data(tiny)}))}]};
 const result=await onRequest(b,{model:b.model,protocol:'responses'});
 assert.deepEqual(result.input[0],b.input[0]);assert.equal(result.input[1].call_id,'test');
 assert.equal(result.input[1].output.filter(p=>p.type==='input_image').length,128);
 assert.equal(b.input[1].output[0].type,'input_image');
});

test('hook handles Anthropic tool-result and Gemini inline images',async()=>{
 const model='opencode-go/deepseek-v4.1-flash';
 const anthropic={model,messages:[{role:'user',content:[{type:'tool_result',tool_use_id:'test',content:Array.from({length:130},()=>({type:'image',source:{type:'base64',media_type:'image/png',data:tiny.toString('base64')}}))}]}]};
 const a=await onRequest(anthropic,{model,protocol:'anthropic'});
 assert.equal(a.messages[0].content[0].tool_use_id,'test');
 assert.equal(a.messages[0].content[0].content.filter(p=>p.type==='image').length,128);
 const gemini={contents:[{role:'user',parts:Array.from({length:130},()=>({inlineData:{mimeType:'image/png',data:tiny.toString('base64')}}))}]};
 const g=await onRequest(gemini,{model,protocol:'gemini'});
 assert.equal(g.contents[0].parts.filter(p=>p.inlineData).length,128);
 assert.match(g.contents[0].parts[0].text,/original retained/);
 assert.equal(g.contents[0].parts[0].type,undefined);
 const snake={contents:[{role:'user',parts:[{inline_data:{mime_type:'image/png',data:tiny.toString('base64')}}]}]};
 assert.deepEqual(await onRequest(snake,{model,protocol:'gemini'}),snake);
});

test('hook lets host roll back processing errors and observes cancellation',async()=>{
 const b=body([{type:'image_url',image_url:{url:'data:image/png;base64,invalid'}}]);
 await assert.rejects(onRequest(b,{model:'opencode-go/deepseek-v4.1-flash',protocol:'chat'}),/Malformed|Invalid/);
 assert.equal(b.messages[0].content[1].type,'image_url');
 const controller=new AbortController();controller.abort();
 await assert.rejects(onRequest(body([image(tiny)]),{model:'opencode-go/deepseek-v4.1-flash',protocol:'chat',signal:controller.signal}));
});

test('small images preserve exact bytes and text; source input is unchanged',async()=>{
 const b=body([image(tiny)]),original=JSON.stringify(b);const result=await prepareInlineRequest(original,'/chat/completions');
 assert.deepEqual(JSON.parse(result.payload),b);assert.equal(JSON.stringify(b),original);assert.equal(result.omitted,0);
});

test('large ordinary PNG history is compressed under serialized budget; recent four preserved when possible',async()=>{
 const raw=await sharp(randomBytes(512*512*3),{raw:{width:512,height:512,channels:3}}).png().toBuffer();
 const original=JSON.stringify(body(Array.from({length:50},()=>image(raw))));assert.ok(Buffer.byteLength(original)>48*1024*1024);
 const r=await prepareInlineRequest(original,'/chat/completions');assert.ok(Buffer.byteLength(r.payload)<=GO_REQUEST_BUDGET);assert.ok(r.changed>0);assert.equal(r.omitted,0);assert.equal(r.images,50);
 const parts=JSON.parse(r.payload).messages[0].content;for(const part of parts.slice(-4)){const saved=Buffer.from(part.image_url.url.split(',')[1],'base64');assert.ok((await sharp(saved).raw().toBuffer()).equals(await sharp(raw).raw().toBuffer()),'recent image pixels changed');}
});

test('count budget keeps newest images with explicit markers, including URL/file references',async()=>{
 const b=body(Array.from({length:130},(_,i)=>({type:'image_url',image_url:{url:'https://example.invalid/'+i+'.png'}})));
 const r=await prepareInlineRequest(JSON.stringify(b),'/chat/completions');assert.equal(r.omitted,2);assert.equal(r.images,128);
 const parts=JSON.parse(r.payload).messages[0].content;assert.match(parts[1].text,/original retained/);assert.equal(parts.at(-1).image_url.url,'https://example.invalid/129.png');
});

test('Responses tool outputs preserve call pairing and non-image content',async()=>{
 const b={input:[{type:'function_call',call_id:'call-test',name:'screenshot',arguments:'{}'},{type:'function_call_output',call_id:'call-test',output:[{type:'input_text',text:'result'},...Array.from({length:130},()=>({type:'input_image',image_url:data(tiny)}))]}]};
 const r=await prepareInlineRequest(JSON.stringify(b),'/responses');const out=JSON.parse(r.payload);assert.deepEqual(out.input[0],b.input[0]);assert.equal(out.input[1].call_id,'call-test');assert.deepEqual(out.input[1].output[0],b.input[1].output[0]);assert.equal(out.input[1].output.length,131);assert.equal(r.omitted,2);
});

test('text/tool overhead reduces image allowance before dropping any history',async()=>{
 const raw=await sharp(randomBytes(256*256*3),{raw:{width:256,height:256,channels:3}}).png().toBuffer();
 const b=body([image(raw),image(raw)]);b.messages[0].content[0].text='x'.repeat(350000);
 const r=await prepareInlineRequest(JSON.stringify(b),'/chat/completions',{imageBudget:400000,requestBudget:500000});assert.ok(Buffer.byteLength(r.payload)<=500000);assert.equal(r.omitted,0);assert.equal(JSON.parse(r.payload).messages[0].content[0].text,b.messages[0].content[0].text);
});
